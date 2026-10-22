/**
 * 会话组成摘要工具 get_current_session_report（T11，功能缝：in-process 直调 execute）。
 *
 * 验收口径（工单 #10 验收项 2 的兜底设计改述）：命令执行后模型调用的工具以
 * 心跳会话为准——夹具中心跳指向 S_MAIN 而无心跳兜底会选 time_updated 更新的
 * S_NEAR，两者可区分，断言报告始终锚定心跳会话。
 *
 * 期望值为独立手算常量（对照 scripts/make-fixtures.mjs 注入的行集），不经被测代码反推。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");
const fixtureHeartbeat = join(repoRoot, "test", "fixtures", "heartbeat.json");
const fixtureRolloutDir = join(repoRoot, "test", "fixtures", "rollout");

// 夹具会话 ID（与 scripts/make-fixtures.mjs 保持同源常量）
const S_MAIN = "session_00000000000000000000000000000001"; // 心跳指向；带压缩历史（阈值 1800）
const S_OLD = "session_00000000000000000000000000000002"; // 无压缩历史
const S_NEAR = "session_00000000000000000000000000000005"; // time_updated 最新 → 无心跳兜底选中；占用 900/阈值 1000

/** 写一个临时心跳文件，返回路径（测试后由调用方清理目录） */
function writeHeartbeat(dir, obj) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  return p;
}

async function callTool(deps) {
  const { createCurrentSessionReportTool } = await import("../src/server/tools/get_current_session_report.ts");
  const tool = createCurrentSessionReportTool(deps);
  const result = await tool.execute({});
  return result.structuredContent;
}

describe("get_current_session_report（功能缝：直调 execute）", () => {
  it("心跳可用：报告锚定心跳会话 S_MAIN 而非兜底会话 S_NEAREST（验收项 2 兜底改述）", async () => {
    const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    // S_NEAR 的 time_updated（T0+90000）比 S_MAIN（T0+60000）新：若误走兜底推断会选中 S_NEAR。
    // 断言以心跳为准（夹具心跳 → S_MAIN），即"命令→工具"路径的会话精度等价于命令注入。
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("heartbeat");
    expect(payload.usage.requests).toBe(6); // S_MAIN 行集（手算，同 make-fixtures 注释）
    expect(payload.usage.computedTotalTokens).toBe(4405);
    expect(payload.usage.inputTokens).toBe(4000);
    expect(payload.usage.cacheReadTokens).toBe(3400);
  });

  it("无心跳：兜底推断选最近活跃 S_NEAR 并标注 inferred", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-report-"));
    try {
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: join(dir, "absent.json") });
      expect(payload.available).toBe(true);
      expect(payload.session.id).toBe(S_NEAR);
      expect(payload.session.source).toBe("inferred");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("组成估算（T3 已合入）：S_MAIN 有 rollout 夹具 → estimated=true，四分组为锚点校准手算值（标注估算）", async () => {
    const payload = await callTool({
      dbPath: fixtureDb,
      heartbeatPath: fixtureHeartbeat,
      rolloutDir: fixtureRolloutDir,
    });
    const c = payload.composition;

    // 手算真值来源：make-fixtures.mjs buildMainRolloutLines 注释（T3 锚点 req-main-3）：
    // Σraw=500，锚点 usage.inputTokens=625 → scale=1.25，
    // 校准后 { system:151, tools:124, history:213, currentTurn:137 }，Σ=625
    expect(c.estimated).toBe(true);
    expect(c.basis).toBe("rollout-full-request");
    expect(c.exactTotalTokens).toBe(625);
    expect(c.groups).toEqual({ system: 151, tools: 124, history: 213, currentTurn: 137 });
    expect(c.scaleFactor).toBe(1.25);
    expect(c.note).toContain("估算"); // ADR-0002：展示必须标注估算
  });

  it("组成兜底呈现：S_NEAR 无 rollout 文件 → estimated=false，四分组留空，总量以 API 精确值兜底", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-report-"));
    try {
      const hb = writeHeartbeat(dir, { sessionId: S_NEAR, time: 1792600090000 });
      const payload = await callTool({
        dbPath: fixtureDb,
        heartbeatPath: hb,
        rolloutDir: fixtureRolloutDir,
      });
      const c = payload.composition;

      expect(c.estimated).toBe(false);
      expect(c.basis).toBe("exact-usage-fallback");
      expect(c.groups).toBeNull();
      expect(c.exactTotalTokens).toBe(1000); // S_NEAR mu_near_1 computedTotalTokens（手算）
      expect(c.note).toContain("估算");
      expect(c.note).toContain("兜底");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("接近压缩提醒（启发式，口径在返回中声明）", () => {
    it("S_NEAR：最近占用 900 达实测阈值 1000 的 0.9 → 提醒触发并透出口径", async () => {
      const dir = mkdtempSync(join(tmpdir(), "zci-report-"));
      try {
        const hb = writeHeartbeat(dir, { sessionId: S_NEAR, time: 1792600090000 });
        const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });
        const w = payload.compactionWarning;

        // 手算：mu_near_1 input=900（含缓存读，最近 completed main_turn）÷
        // part_fixture_compact_near preCompactTokenCount=1000 = 0.9 ≥ 0.8
        expect(w).toBeTruthy();
        expect(w.present).toBe(true);
        expect(w.ratio).toBe(0.9);
        expect(w.currentContextTokens).toBe(900);
        expect(w.thresholdTokens).toBe(1000);
        expect(w.triggerRatio).toBe(0.8);
        expect(w.basis).toContain("preCompactTokenCount"); // 口径声明：阈值依据可追溯
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("S_MAIN：最近占用 90 ÷ 阈值 4000（T7 手动压缩 part，最新）= 0.0225 → present=false 且 ratio 透出", async () => {
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });
      const w = payload.compactionWarning;

      // 手算：mu_main_6（最近 completed main_turn，mu_main_5 为 error 行须排除）input=90；
      // S_MAIN 最近压缩事件 = part_t7_compact_2（T0+58000，晚于 part_fixture_compact_1 的
      // T0+55000）preCompactTokenCount=4000 → 90/4000 = 0.0225
      expect(w).toBeTruthy();
      expect(w.present).toBe(false);
      expect(w.ratio).toBe(0.0225);
      expect(w.currentContextTokens).toBe(90);
      expect(w.thresholdTokens).toBe(4000);
    });

    it("S_OLD：无压缩历史即无阈值依据 → 整个提醒字段省略（null）", async () => {
      const dir = mkdtempSync(join(tmpdir(), "zci-report-"));
      try {
        const hb = writeHeartbeat(dir, { sessionId: S_OLD, time: 1792600030000 });
        const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });
        expect(payload.compactionWarning).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-report-"));
    try {
      const payload = await callTool({
        dbPath: join(dir, "no-such.sqlite"),
        heartbeatPath: join(dir, "absent.json"),
      });
      expect(payload.available).toBe(false);
      expect(payload.usage).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
