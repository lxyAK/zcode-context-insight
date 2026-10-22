/**
 * 当前会话用量功能缝基线（T2，工单预先约定的缝：in-process 直调工具 execute）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 注入的行集），
 * 不经被测代码路径反推——夹具即真值来源。
 *
 * 红线对照：所有测试读写 test/fixtures 合成夹具，绝不触碰 ~/.zcode 真实库。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");
const fixtureHeartbeat = join(repoRoot, "test", "fixtures", "heartbeat.json");

// 夹具会话 ID（与 scripts/make-fixtures.mjs 保持同源常量）
const S_MAIN = "session_00000000000000000000000000000001";
const S_OLD = "session_00000000000000000000000000000002";

// S_MAIN 的 model_usage 手算聚合（全请求；行集见 make-fixtures.mjs 注释）
const MAIN_TOTAL = {
  requests: 3,
  inputTokens: 1510,
  outputTokens: 305,
  reasoningTokens: 50,
  cacheReadTokens: 1200,
  cacheWriteTokens: 100,
  computedTotalTokens: 1815,
  ttftMsTotal: 2700,
};
const MAIN_BY_SOURCE = {
  main_turn: { requests: 2, inputTokens: 1500, outputTokens: 300, computedTotalTokens: 1800 },
  session_title: { requests: 1, inputTokens: 10, outputTokens: 5, computedTotalTokens: 15 },
};

/** 写一个临时心跳文件，返回路径（测试后由调用方清理目录） */
function writeHeartbeat(dir, obj) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  return p;
}

async function callTool(deps) {
  const { createCurrentSessionUsageTool } = await import("../src/server/tools/get_current_session_usage.ts");
  const tool = createCurrentSessionUsageTool(deps);
  const result = await tool.execute({});
  return result.structuredContent;
}

describe("get_current_session_usage（功能缝：直调 execute）", () => {
  it("心跳可用：识别来源为 heartbeat，聚合数值与夹具 model_usage 手算一致", async () => {
    const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("heartbeat");
    expect(payload.session.heartbeatAt).toBe(1792600060000); // 夹具心跳的时间戳原样透出
    expect(payload.session.taskType).toBe("interactive");
    expect(payload.session.title).toBe("夹具主会话（当前）");

    expect(payload.usage).toEqual({ ...MAIN_TOTAL, byQuerySource: MAIN_BY_SOURCE });
  });

  it("心跳指向旧会话：聚合按 session_id 隔离（S_OLD 单行）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-usage-"));
    try {
      const hb = writeHeartbeat(dir, { sessionId: S_OLD, time: 1792600030000 });
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });

      expect(payload.session.id).toBe(S_OLD);
      expect(payload.session.source).toBe("heartbeat");
      expect(payload.usage.requests).toBe(1);
      expect(payload.usage.computedTotalTokens).toBe(350);
      expect(payload.usage.inputTokens).toBe(300);
      expect(payload.usage.outputTokens).toBe(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("心跳指向未落库的新会话：仍按 heartbeat 返回，用量全 0 而非报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-usage-"));
    try {
      const hb = writeHeartbeat(dir, { sessionId: "session_ffffffffffffffffffffffffffffffff", time: 1792600090000 });
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });

      expect(payload.session.id).toBe("session_ffffffffffffffffffffffffffffffff");
      expect(payload.session.source).toBe("heartbeat");
      expect(payload.session.title).toBeNull(); // session 表无行
      expect(payload.usage.requests).toBe(0);
      expect(payload.usage.computedTotalTokens).toBe(0);
      expect(payload.usage.ttftMsTotal).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无心跳文件：兜底最近活跃 interactive 会话并标注来源为 inferred（不选 subagent）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-usage-"));
    try {
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: join(dir, "absent.json") });

      expect(payload.available).toBe(true);
      // 夹具中 subagent 会话 time_updated 比 S_OLD 新，兜底必须按 task_type='interactive' 过滤
      expect(payload.session.id).toBe(S_MAIN);
      expect(payload.session.source).toBe("inferred");
      expect(payload.session.heartbeatAt).toBeNull();
      expect(payload.usage.requests).toBe(3); // S_MAIN 的聚合
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("心跳文件损坏（非法 JSON）：容错降级为 inferred，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-usage-"));
    try {
      const hb = join(dir, "heartbeat.json");
      writeFileSync(hb, '{"sessionId":"session_bro', "utf8"); // 半截 JSON
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });

      expect(payload.session.source).toBe("inferred");
      expect(payload.session.id).toBe(S_MAIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-usage-"));
    try {
      const payload = await callTool({
        dbPath: join(dir, "no-such.sqlite"),
        heartbeatPath: join(dir, "absent.json"),
      });

      expect(payload.available).toBe(false);
      expect(typeof payload.reason).toBe("string");
      expect(payload.reason.length).toBeGreaterThan(0);
      expect(payload.usage).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("只读连接层红线（ADR-0001：任何代码路径不得写入）", () => {
  it("openReadonlyDatabase 返回的连接拒绝一切写操作", async () => {
    const { openReadonlyDatabase } = await import("../src/server/db.ts");
    const opened = openReadonlyDatabase(fixtureDb);
    expect(opened.ok).toBe(true);
    try {
      expect(() => opened.db.exec("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('x','x','x','x','x','x',0,0)")).toThrow(/readonly/i);
      expect(() => opened.db.exec("UPDATE session SET title='x'")).toThrow(/readonly/i);
      expect(() => opened.db.exec("DELETE FROM session")).toThrow(/readonly/i);
      expect(() => opened.db.exec("CREATE TABLE evil (a int)")).toThrow(/readonly/i);
    } finally {
      opened.db.close();
    }
  });

  it("在夹具库上执行完整工具流程后，夹具目录不产生任何侧写文件（-wal/-shm/-journal 等）", async () => {
    const { readdirSync } = await import("node:fs");
    const fixtureDir = join(repoRoot, "test", "fixtures");
    const before = readdirSync(fixtureDir).sort();
    await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });
    await callTool({ dbPath: fixtureDb, heartbeatPath: join(fixtureDir, "absent.json") });
    expect(readdirSync(fixtureDir).sort()).toEqual(before); // 只读红线：连侧写文件都不落
  });
});
