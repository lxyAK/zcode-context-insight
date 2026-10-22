/**
 * Fleet 代理网络树功能缝（T10，工单预先约定的缝：in-process 直调工具 execute）。
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
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003";
const S_SUBSUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000004";
// T11 并入的接近压缩会话：time_updated（T0+90000）全场最新 → 无心跳兜底改选它（合并时本测试同步改述）
const S_NEAR = "session_00000000000000000000000000000006";

// 三层树各节点的手算聚合（行集见 make-fixtures.mjs 注释）：
// S_MAIN（6 行）：requests=6, input=4000, output=405, computedTotal=4405,
//   durationMsTotal=5000+3000+200+2500+1200+800=12700, errorRequests=1(mu_main_5)，
//   lastRequestStatus='completed'（mu_main_6 的 started_at=T0+45000 最新）
const MAIN_NODE = {
  requests: 6,
  inputTokens: 4000,
  outputTokens: 405,
  computedTotalTokens: 4405,
  durationMsTotal: 12700,
  errorRequests: 1,
  lastRequestStatus: "completed",
};
// S_SUB（1 行 mu_sub_1）
const SUB_NODE = {
  requests: 1,
  inputTokens: 2000,
  outputTokens: 300,
  computedTotalTokens: 2300,
  durationMsTotal: 4000,
  errorRequests: 0,
  lastRequestStatus: "completed",
};
// S_SUBSUB（2 行：mu_subsub_1 completed → mu_subsub_2 error 且更晚）
const SUBSUB_NODE = {
  requests: 2,
  inputTokens: 1100,
  outputTokens: 100,
  computedTotalTokens: 1200,
  durationMsTotal: 1800,
  errorRequests: 1,
  lastRequestStatus: "error",
};

/** 写一个临时心跳文件，返回路径（测试后由调用方清理目录） */
function writeHeartbeat(dir, obj) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  return p;
}

async function callTool(deps, args = {}) {
  const { createFleetTreeTool } = await import("../src/server/tools/get_fleet_tree.ts");
  const tool = createFleetTreeTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

describe("get_fleet_tree（功能缝：直调 execute）", () => {
  it("心跳根：三层树（主会话 → 子代理 → 孙代理），结构与各节点聚合、状态正确", async () => {
    const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    expect(payload.rootSessionSource).toBe("heartbeat");

    // 第一层：根为主会话，无父
    const root = payload.root;
    expect(root.id).toBe(S_MAIN);
    expect(root.parentId).toBeNull();
    expect(root.taskType).toBe("interactive");
    expect(root.title).toBe("夹具主会话（当前）");
    expect(root.usage).toEqual(MAIN_NODE);

    // 第二层：子代理挂在 S_MAIN 下
    expect(root.children).toHaveLength(1);
    const sub = root.children[0];
    expect(sub.id).toBe(S_SUB);
    expect(sub.parentId).toBe(S_MAIN);
    expect(sub.taskType).toBe("subagent_child");
    expect(sub.usage).toEqual(SUB_NODE);

    // 第三层：孙代理挂在 S_SUB 下（隔层不断链）
    expect(sub.children).toHaveLength(1);
    const subsub = sub.children[0];
    expect(subsub.id).toBe(S_SUBSUB);
    expect(subsub.parentId).toBe(S_SUB);
    expect(subsub.usage).toEqual(SUBSUB_NODE);
    expect(subsub.children).toEqual([]);
  });

  it("显式指定无子代理的会话（S_OLD）：单节点树，来源标注 explicit", async () => {
    const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat }, { sessionId: S_OLD });

    expect(payload.available).toBe(true);
    expect(payload.rootSessionSource).toBe("explicit");
    // S_OLD 无任何子代理：children 为空数组，树只有一个根节点
    expect(payload.root.id).toBe(S_OLD);
    expect(payload.root.parentId).toBeNull();
    expect(payload.root.children).toEqual([]);
    // S_OLD 单行 mu_old_1 手算聚合
    expect(payload.root.usage).toEqual({
      requests: 1,
      inputTokens: 300,
      outputTokens: 50,
      computedTotalTokens: 350,
      durationMsTotal: 2000,
      errorRequests: 0,
      lastRequestStatus: "completed",
    });
  });

  it("心跳指向未落库的新会话：仍按 heartbeat 返回单节点树（元数据 null、用量全 0），不报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-fleet-"));
    try {
      const hb = writeHeartbeat(dir, { sessionId: "session_ffffffffffffffffffffffffffffffff", time: 1792600090000 });
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });

      expect(payload.available).toBe(true);
      expect(payload.rootSessionSource).toBe("heartbeat");
      expect(payload.root.id).toBe("session_ffffffffffffffffffffffffffffffff");
      expect(payload.root.title).toBeNull(); // session 表无行
      expect(payload.root.children).toEqual([]);
      expect(payload.root.usage).toEqual({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        computedTotalTokens: 0,
        durationMsTotal: 0,
        errorRequests: 0,
        lastRequestStatus: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无心跳：兜底最近活跃 interactive 会话（S_NEAR）为根并标注 inferred", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-fleet-"));
    try {
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: join(dir, "absent.json") });

      expect(payload.available).toBe(true);
      expect(payload.rootSessionSource).toBe("inferred");
      // T11 并入 S_NEAR（time_updated=T0+90000，全场最新 interactive）后兜底改选它：
      // S_NEAR 无子代理 → 单节点树（S_SUB/S_SUBSUB 挂 S_MAIN 下，不在树中）
      expect(payload.root.id).toBe(S_NEAR);
      expect(payload.root.children).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-fleet-"));
    try {
      const payload = await callTool({
        dbPath: join(dir, "no-such.sqlite"),
        heartbeatPath: join(dir, "absent.json"),
      });

      expect(payload.available).toBe(false);
      expect(typeof payload.reason).toBe("string");
      expect(payload.reason.length).toBeGreaterThan(0);
      expect(payload.root).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
