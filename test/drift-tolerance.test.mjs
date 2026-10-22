/**
 * T13 健壮性基线：schema 漂移 / 无 rollout 会话 / DB 缺失或被锁下的降级行为。
 *
 * 缝（与既有功能测试一致）：in-process 直调工具 execute，仅断言工具外部行为——
 * 不抛异常、降级载荷结构（available:false + 机器可读 reason）或行级容错（坏行跳过）。
 * 期望值全部为独立设计常量（对照 scripts/make-fixtures.mjs 的漂移变体注释），
 * 不经被测代码路径反推。
 *
 * 红线对照：所有测试读写 test/fixtures 合成夹具与临时目录，绝不触碰 ~/.zcode 真实库。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(repoRoot, "test", "fixtures");
const fixtureDb = join(fixtureDir, "db.sqlite");
const fixtureHeartbeat = join(fixtureDir, "heartbeat.json");
const fixtureRolloutDir = join(fixtureDir, "rollout");
const driftDir = join(fixtureDir, "drift");

// 夹具会话 ID（与 scripts/make-fixtures.mjs 保持同源常量）
const S_MAIN = "session_00000000000000000000000000000001";
const S_DAY1 = "session_00000000000000000000000000000011"; // 无 rollout 文件的会话（T13 空态依据）

/** 13 个工具的（名字, 装载函数, 默认入参）清单；调用时逐个 execute 并解析 JSON */
async function loadAllTools(deps) {
  const { getOverviewTool } = await import("../src/server/tools/get_overview.ts");
  const { createCurrentSessionUsageTool } = await import("../src/server/tools/get_current_session_usage.ts");
  const { createSessionTimelineTool } = await import("../src/server/tools/get_session_timeline.ts");
  const { createCurrentSessionCompositionTool } = await import("../src/server/tools/get_current_session_composition.ts");
  const { createSessionStatsTool } = await import("../src/server/tools/get_session_stats.ts");
  const { createFleetTreeTool } = await import("../src/server/tools/get_fleet_tree.ts");
  const { createCurrentSessionReportTool } = await import("../src/server/tools/get_current_session_report.ts");
  const { createSessionEventsTool } = await import("../src/server/tools/get_session_events.ts");
  const { createSessionFileActivityTool } = await import("../src/server/tools/get_session_file_activity.ts");
  const { createInsightsTool } = await import("../src/server/tools/get_insights.ts");
  const { createActivityTool } = await import("../src/server/tools/activity.ts");
  const { createListSessionRequestsTool, createGetRequestDetailTool } = await import("../src/server/tools/request-detail.ts");
  return [
    ["get_overview", getOverviewTool, {}],
    ["get_current_session_usage", createCurrentSessionUsageTool(deps), {}],
    ["get_session_timeline", createSessionTimelineTool(deps), {}],
    ["get_current_session_composition", createCurrentSessionCompositionTool(deps), {}],
    ["get_session_stats", createSessionStatsTool(deps), {}],
    ["get_fleet_tree", createFleetTreeTool(deps), {}],
    ["get_current_session_report", createCurrentSessionReportTool(deps), {}],
    ["get_session_events", createSessionEventsTool(deps), {}],
    ["get_session_file_activity", createSessionFileActivityTool(deps), {}],
    ["get_insights", createInsightsTool(deps), {}],
    ["get_activity_insights", createActivityTool(deps), {}],
    ["list_session_requests", createListSessionRequestsTool(deps), {}],
    ["get_request_detail", createGetRequestDetailTool(deps), { requestId: "req-main-3" }],
  ];
}

/**
 * 调用全部 13 个工具并解析载荷。核心断言：execute 不抛异常（漂移容错的第一红线），
 * 返回的结构化载荷为对象。逐工具的 available/reason 断言由调用方按变体矩阵给出。
 */
async function callAllTools(deps) {
  const results = {};
  for (const [name, tool, args] of await loadAllTools(deps)) {
    const result = await tool.execute(args); // 断言一：不抛异常
    const payload = JSON.parse(result.content[0].text);
    expect(typeof payload).toBe("object");
    results[name] = payload;
  }
  return results;
}

/** 按变体矩阵断言：degraded 集合中的工具 available=false 且 reason 精确匹配；其余 available=true */
function assertMatrix(payloads, { degraded, reason }) {
  for (const [name, payload] of Object.entries(payloads)) {
    if (name === "get_overview") continue; // 不触碰 db，无降级语义
    if (degraded.includes(name)) {
      expect(payload.available, `${name} 应降级`).toBe(false);
      expect(payload.reason, `${name} 的 reason`).toBe(reason);
    } else {
      expect(payload.available, `${name} 不触碰漂移对象，应保持可用`).toBe(true);
    }
  }
}

describe("DB schema 漂移：缺表 / 缺列下全部 13 个工具降级而非异常", () => {
  const deps = { heartbeatPath: fixtureHeartbeat, rolloutDir: fixtureRolloutDir };

  it("缺 model_usage 表：触碰用量表的 7 个工具降级 reason=schema-drift:missing-table:model_usage，其余照常", async () => {
    const payloads = await callAllTools({ ...deps, dbPath: join(driftDir, "no-model-usage.sqlite") });
    assertMatrix(payloads, {
      degraded: [
        "get_current_session_usage", "get_session_timeline", "get_session_stats",
        "get_fleet_tree", "get_current_session_report", "get_insights", "get_activity_insights",
      ],
      reason: "schema-drift:missing-table:model_usage",
    });
  });

  it("缺 part 表：事件/文件活动/时间线压缩标记/报告降级 reason=schema-drift:missing-table:part，纯用量侧照常", async () => {
    const payloads = await callAllTools({ ...deps, dbPath: join(driftDir, "no-part.sqlite") });
    assertMatrix(payloads, {
      degraded: ["get_session_events", "get_session_file_activity", "get_session_timeline", "get_current_session_report"],
      reason: "schema-drift:missing-table:part",
    });
  });

  it("缺 session 表（心跳可用）：会话元数据查询降级 reason=schema-drift:missing-table:session，不查 session 的照常", async () => {
    const payloads = await callAllTools({ ...deps, dbPath: join(driftDir, "no-session.sqlite") });
    assertMatrix(payloads, {
      degraded: [
        "get_current_session_usage", "get_session_timeline", "get_session_stats",
        "get_fleet_tree", "get_current_session_report", "get_insights",
      ],
      reason: "schema-drift:missing-table:session",
    });
  });

  it("model_usage 缺 input_tokens 列：使用该列的 5 个工具降级 reason=schema-drift:missing-column:input_tokens，不使用该列的照常", async () => {
    const payloads = await callAllTools({ ...deps, dbPath: join(driftDir, "missing-input-tokens.sqlite") });
    assertMatrix(payloads, {
      degraded: [
        "get_current_session_usage", "get_session_timeline", "get_session_stats",
        "get_fleet_tree", "get_current_session_report",
      ],
      reason: "schema-drift:missing-column:input_tokens",
    });
  });

  it("缺 session 表且无心跳（兜底识别路径）：会话识别降级为 schema-drift:missing-table:session 而非抛异常", async () => {
    const { createCurrentSessionUsageTool } = await import("../src/server/tools/get_current_session_usage.ts");
    const { createCurrentSessionCompositionTool } = await import("../src/server/tools/get_current_session_composition.ts");
    const { createFleetTreeTool } = await import("../src/server/tools/get_fleet_tree.ts");
    const { createListSessionRequestsTool, createGetRequestDetailTool } = await import("../src/server/tools/request-detail.ts");
    const noHeartbeatDeps = { dbPath: join(driftDir, "no-session.sqlite"), heartbeatPath: join(fixtureDir, "absent.json"), rolloutDir: fixtureRolloutDir };

    const usage = JSON.parse((await createCurrentSessionUsageTool(noHeartbeatDeps).execute({})).content[0].text);
    expect(usage.available).toBe(false);
    expect(usage.reason).toBe("schema-drift:missing-table:session");

    // 组成工具的会话兜底识别同样不得抛异常（无心跳 + session 表缺失的最坏组合）
    const composition = JSON.parse((await createCurrentSessionCompositionTool(noHeartbeatDeps).execute({})).content[0].text);
    expect(composition.available).toBe(false);
    expect(composition.reason).toBe("schema-drift:missing-table:session");

    const fleet = JSON.parse((await createFleetTreeTool(noHeartbeatDeps).execute({})).content[0].text);
    expect(fleet.available).toBe(false);
    expect(fleet.reason).toBe("schema-drift:missing-table:session");

    // 请求序列/明细（T6 自包含解析侧）的兜底识别路径同样分类降级
    const list = JSON.parse((await createListSessionRequestsTool(noHeartbeatDeps).execute({})).content[0].text);
    expect(list.available).toBe(false);
    expect(list.reason).toBe("schema-drift:missing-table:session");

    const detail = JSON.parse((await createGetRequestDetailTool(noHeartbeatDeps).execute({ requestId: "req-main-3" })).content[0].text);
    expect(detail.available).toBe(false);
    expect(detail.reason).toBe("schema-drift:missing-table:session");
  });
});

describe("行级漂移：part.data 非法 JSON 时坏行跳过、好行照常返回", () => {
  const deps = { dbPath: join(driftDir, "bad-part-json.sqlite"), heartbeatPath: fixtureHeartbeat, rolloutDir: fixtureRolloutDir };

  it("全部 13 个工具仍可用（available=true）：单行坏 data 不毒化整查询", async () => {
    const payloads = await callAllTools(deps);
    for (const [name, payload] of Object.entries(payloads)) {
      if (name === "get_overview") continue;
      expect(payload.available, `${name} 在坏 JSON 行下应保持可用`).toBe(true);
    }
  });

  it("事件流跳过坏压缩行：保留 2 条模型切换 + 1 条合法手动压缩（自动压缩行 data 已写坏）", async () => {
    const { createSessionEventsTool } = await import("../src/server/tools/get_session_events.ts");
    const payload = JSON.parse((await createSessionEventsTool(deps).execute({})).content[0].text);
    expect(payload.available).toBe(true);
    expect(payload.events).toHaveLength(3);
    const compactions = payload.events.filter((e) => e.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].trigger).toBe("manual"); // part_t7_compact_2 仍可解析
  });

  it("文件活动跳过坏工具行：Read 行（data 已写坏）被剔除，其余 5 条保留", async () => {
    const { createSessionFileActivityTool } = await import("../src/server/tools/get_session_file_activity.ts");
    const payload = JSON.parse((await createSessionFileActivityTool(deps).execute({})).content[0].text);
    expect(payload.available).toBe(true);
    expect(payload.activities).toHaveLength(5);
    expect(payload.activities.every((a) => a.operation !== "read")).toBe(true);
  });

  it("时间线压缩标记跳过坏行：compactions 只剩 1 条（manual），请求序列不受影响", async () => {
    const { createSessionTimelineTool } = await import("../src/server/tools/get_session_timeline.ts");
    const payload = JSON.parse((await createSessionTimelineTool(deps).execute({})).content[0].text);
    expect(payload.available).toBe(true);
    expect(payload.requests).toHaveLength(6); // model_usage 未漂移
    expect(payload.compactions).toHaveLength(1);
    expect(payload.compactions[0].trigger).toBe("manual");
  });
});

describe("无 rollout 文件的会话：DB 统计正常，组成类视图返回说明性空态", () => {
  let dir;
  let heartbeatPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zci-norollout-"));
    // 心跳指向 S_DAY1（夹具 db 有统计行、rollout 目录无其文件——宿主已清理的旧会话）
    heartbeatPath = join(dir, "heartbeat.json");
    writeFileSync(heartbeatPath, JSON.stringify({ sessionId: S_DAY1, time: 1792591400000 }), "utf8");
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，残留临时目录无害 */ }
  });

  it("DB 统计类工具正常返回：精确用量 / 统计卡 / 时间线（手算：S_DAY1 一行 48000 入 / 50000 总量）", async () => {
    const { createCurrentSessionUsageTool } = await import("../src/server/tools/get_current_session_usage.ts");
    const { createSessionStatsTool } = await import("../src/server/tools/get_session_stats.ts");
    const { createSessionTimelineTool } = await import("../src/server/tools/get_session_timeline.ts");
    const d = { dbPath: fixtureDb, heartbeatPath, rolloutDir: fixtureRolloutDir };

    const usage = JSON.parse((await createCurrentSessionUsageTool(d).execute({})).content[0].text);
    expect(usage.available).toBe(true);
    expect(usage.usage.requests).toBe(1);
    expect(usage.usage.inputTokens).toBe(48000);
    expect(usage.usage.computedTotalTokens).toBe(50000);

    const stats = JSON.parse((await createSessionStatsTool(d).execute({})).content[0].text);
    expect(stats.available).toBe(true);
    expect(stats.stats.requests).toBe(1);

    const timeline = JSON.parse((await createSessionTimelineTool(d).execute({})).content[0].text);
    expect(timeline.available).toBe(true);
    expect(timeline.requests).toHaveLength(1);
    expect(timeline.compactions).toEqual([]);
  });

  it("组成估算返回说明性空态：available=false + reason=rollout-not-found（宿主清理属预期，ADR-0001）", async () => {
    const { createCurrentSessionCompositionTool } = await import("../src/server/tools/get_current_session_composition.ts");
    const d = { dbPath: fixtureDb, heartbeatPath, rolloutDir: fixtureRolloutDir };
    const payload = JSON.parse((await createCurrentSessionCompositionTool(d).execute({})).content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("rollout-not-found");
    expect(payload.session.id).toBe(S_DAY1);
    expect(payload.rollout.found).toBe(false);
    expect(payload.composition).toBeNull();
    expect(payload.exactTotalTokens).toBeNull();
  });

  it("请求序列与单请求明细同样返回 rollout-not-found 空态", async () => {
    const { createListSessionRequestsTool, createGetRequestDetailTool } = await import("../src/server/tools/request-detail.ts");
    const d = { dbPath: fixtureDb, heartbeatPath, rolloutDir: fixtureRolloutDir };

    const list = JSON.parse((await createListSessionRequestsTool(d).execute({})).content[0].text);
    expect(list.available).toBe(false);
    expect(list.reason).toBe("rollout-not-found");
    expect(list.requests).toBeNull();

    const detail = JSON.parse((await createGetRequestDetailTool(d).execute({ requestId: "req-any" })).content[0].text);
    expect(detail.available).toBe(false);
    expect(detail.reason).toBe("rollout-not-found");
    expect(detail.request).toBeNull();
  });

  it("报告（/context 后端）DB 侧照常：组成估算降级为精确总量兜底（estimated=false）", async () => {
    const { createCurrentSessionReportTool } = await import("../src/server/tools/get_current_session_report.ts");
    const d = { dbPath: fixtureDb, heartbeatPath, rolloutDir: fixtureRolloutDir };
    const payload = JSON.parse((await createCurrentSessionReportTool(d).execute({})).content[0].text);
    expect(payload.available).toBe(true);
    expect(payload.usage.computedTotalTokens).toBe(50000);
    expect(payload.composition.estimated).toBe(false);
    expect(payload.composition.basis).toBe("exact-usage-fallback");
    expect(payload.composition.groups).toBeNull();
  });
});

describe("DB 不存在 / 路径不可用 / 被锁：错误空态而非异常", () => {
  it("db 路径不存在：全部 13 个工具不抛异常，db 依赖工具 reason=db-not-found", async () => {
    const payloads = await callAllTools({
      dbPath: join(fixtureDir, "absent", "no-such.sqlite"),
      heartbeatPath: fixtureHeartbeat,
      rolloutDir: fixtureRolloutDir,
    });
    expect(payloads.get_overview.plugin).toBe("zcode-context-insight"); // 不依赖 db 的探针照常
    for (const name of [
      "get_current_session_usage", "get_session_timeline", "get_session_stats",
      "get_fleet_tree", "get_current_session_report", "get_session_events",
      "get_session_file_activity", "get_insights", "get_activity_insights",
    ]) {
      expect(payloads[name].available, name).toBe(false);
      expect(payloads[name].reason, name).toBe("db-not-found");
    }
    // 心跳可用时组成/序列/明细走 rollout，不依赖 db，应保持可用
    expect(payloads.get_current_session_composition.available).toBe(true);
    expect(payloads.list_session_requests.available).toBe(true);
    expect(payloads.get_request_detail.available).toBe(true);
  });

  it("db 路径指向目录（不可作为库打开）：reason 以 db-open-failed 开头", async () => {
    const { createCurrentSessionUsageTool } = await import("../src/server/tools/get_current_session_usage.ts");
    const payload = JSON.parse((await createCurrentSessionUsageTool({ dbPath: fixtureRolloutDir }).execute({})).content[0].text);
    expect(payload.available).toBe(false);
    expect(payload.reason).toMatch(/^db-open-failed/);
  });

  it("db 被独占写锁（Windows 真实锁，模拟宿主写入中）：busy 等待后降级 reason=db-busy", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "zci-locked-"));
    const lockedDb = join(dir, "db.sqlite");
    copyFileSync(fixtureDb, lockedDb);
    // 写连接持独占事务（夹具库为默认 journal 模式，独占锁阻塞一切读）
    const writer = new DatabaseSync(lockedDb);
    try {
      writer.exec("BEGIN EXCLUSIVE");
      const d = { dbPath: lockedDb, heartbeatPath: fixtureHeartbeat, rolloutDir: fixtureRolloutDir };
      const { createCurrentSessionUsageTool } = await import("../src/server/tools/get_current_session_usage.ts");
      const { createInsightsTool } = await import("../src/server/tools/get_insights.ts");

      const usage = JSON.parse((await createCurrentSessionUsageTool(d).execute({})).content[0].text);
      expect(usage.available).toBe(false);
      expect(usage.reason).toBe("db-busy");

      const insights = JSON.parse((await createInsightsTool(d).execute({})).content[0].text);
      expect(insights.available).toBe(false);
      expect(insights.reason).toBe("db-busy");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
    }
  }, 30000);
});

describe("基线对照：完整夹具下全部 13 个工具可用（防止漂移容错误伤正常路径）", () => {
  it("available 全为 true（get_overview 返回插件信息）", async () => {
    const payloads = await callAllTools({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat, rolloutDir: fixtureRolloutDir });
    for (const [name, payload] of Object.entries(payloads)) {
      if (name === "get_overview") continue;
      expect(payload.available, name).toBe(true);
    }
    expect(payloads.get_overview.plugin).toBe("zcode-context-insight");
  });
});
