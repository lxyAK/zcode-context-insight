/**
 * Insights 总览工具功能缝基线（T8，缝：in-process 直调工具 execute）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 的行集，不经被测代码反推）。
 * 手算口径（工具实现必须与之对齐）：
 *  - KPI 跨全部未删除会话（不受列表筛选影响）：
 *      totalTokens = 各会话 model_usage.computed_total_tokens 全量合计
 *                  = 1815(S_MAIN) + 350(S_OLD) + 2300(S_SUB) + 50000(S_DAY1)
 *                    + 3000(S_DAY3) + 500(S_DAY8) + 0(S_EMPTY) = 57965
 *      totalSessions = 7
 *      activeDays = model_usage.started_at 去重 UTC 日 = {10-13, 10-18, 10-20, 10-21} = 4
 *  - 7 天趋势：锚点 = 全库最大 started_at（= T0+40000 → UTC 日 2026-10-21），
 *    窗口 [2026-10-15, 2026-10-21]（含端点 7 天，旧→新）：
 *      10-18: 3000 token / 2 请求 / 1 会话（S_DAY3 两行）
 *      10-20: 50000 / 1 / 1（S_DAY1）
 *      10-21: 4465 / 5 / 3（S_MAIN 1815 + S_OLD 350 + S_SUB 2300）
 *      其余日全 0；10-13（S_DAY8）在窗口外不计入趋势但计入 KPI/活跃天数
 *  - 会话列表默认排序 recent = time_updated 降序；tokens = 合计 token 降序
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");

// 夹具常量（与 make-fixtures.mjs 同源）
const T0 = 1792600000000;
const DAY = 86400000;
const S_MAIN = "session_00000000000000000000000000000001";
const S_OLD = "session_00000000000000000000000000000002";
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003";
const S_DAY1 = "session_00000000000000000000000000000011";
const S_DAY3 = "session_00000000000000000000000000000012";
const S_DAY8 = "session_00000000000000000000000000000013";
const S_EMPTY = "session_00000000000000000000000000000014";
const PROJ_A = "proj_d-.opensource-zcode-context-insight";
const PROJ_B = "proj_d-.opensource-other-project";

// 手算期望（见文件头注释）
const EXPECT_KPI = { totalTokens: 57965, totalSessions: 7, activeDays: 4 };
const zero = { tokens: 0, requests: 0, sessions: 0 };
const EXPECT_TREND = [
  { date: "2026-10-15", ...zero },
  { date: "2026-10-16", ...zero },
  { date: "2026-10-17", ...zero },
  { date: "2026-10-18", tokens: 3000, requests: 2, sessions: 1 },
  { date: "2026-10-19", ...zero },
  { date: "2026-10-20", tokens: 50000, requests: 1, sessions: 1 },
  { date: "2026-10-21", tokens: 4465, requests: 5, sessions: 3 },
];

/** 会话摘要断言辅助：只校验列表关心的字段 */
const summary = (s) => ({
  id: s.id,
  taskType: s.taskType,
  requests: s.requests,
  totalTokens: s.totalTokens,
});

async function callTool(args = {}, deps = { dbPath: fixtureDb }) {
  const { createInsightsTool } = await import("../src/server/tools/get_insights.ts");
  const tool = createInsightsTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

describe("get_insights（功能缝：直调 execute）", () => {
  it("KPI 三值与夹具聚合一致（总 token / 会话数 / 活跃天数）", async () => {
    const payload = await callTool();
    expect(payload.available).toBe(true);
    expect(payload.kpi).toEqual(EXPECT_KPI);
  });

  it("7 天趋势数值与窗口边界与手算一致（旧→新 7 桶，窗口外日期不计入）", async () => {
    const payload = await callTool();
    expect(payload.trend).toEqual(EXPECT_TREND);
    // 锚点 = 全库最大 model_usage.started_at（T0+40000，S_SUB 行）
    expect(payload.anchorTime).toBe(T0 + 40000);
  });

  it("项目清单含两个项目及会话数（筛选下拉数据源）", async () => {
    const payload = await callTool();
    expect(payload.projects).toEqual([
      { id: PROJ_A, directory: "D:\\.opensource\\zcode-context-insight", sessions: 5 },
      { id: PROJ_B, directory: "D:\\.opensource\\other-project", sessions: 2 },
    ]);
  });

  it("默认会话列表：按 time_updated 降序，含零用量会话（LEFT JOIN 语义）与子代理标注", async () => {
    const payload = await callTool();
    expect(payload.sessions.total).toBe(7);
    expect(payload.sessions.items.map(summary)).toEqual([
      { id: S_MAIN, taskType: "interactive", requests: 3, totalTokens: 1815 },
      { id: S_SUB, taskType: "subagent_child", requests: 1, totalTokens: 2300 },
      { id: S_OLD, taskType: "interactive", requests: 1, totalTokens: 350 },
      { id: S_EMPTY, taskType: "interactive", requests: 0, totalTokens: 0 },
      { id: S_DAY1, taskType: "interactive", requests: 1, totalTokens: 50000 },
      { id: S_DAY3, taskType: "interactive", requests: 2, totalTokens: 3000 },
      { id: S_DAY8, taskType: "interactive", requests: 1, totalTokens: 500 },
    ]);
    // 列表项字段契约：标题/项目/时间/token（会话卡片的取数来源）
    const main = payload.sessions.items[0];
    expect(main.title).toBe("夹具主会话（当前）");
    expect(main.projectId).toBe(PROJ_A);
    expect(main.directory).toBe("D:\\.opensource\\zcode-context-insight");
    expect(main.timeUpdated).toBe(T0 + 60000);
    expect(main.parentId).toBeNull();
    const sub = payload.sessions.items[1];
    expect(sub.parentId).toBe(S_MAIN); // Fleet 后续工单复用
  });

  it("筛选：按项目（PROJ_B → S_DAY3/S_DAY8，仍按时间降序）", async () => {
    const payload = await callTool({ project: PROJ_B });
    expect(payload.sessions.total).toBe(2);
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_DAY3, S_DAY8]);
    // KPI 与趋势不受列表筛选影响（全局口径）
    expect(payload.kpi).toEqual(EXPECT_KPI);
    expect(payload.trend).toEqual(EXPECT_TREND);
  });

  it("筛选：按规模 minTokens=1000（剔除 S_OLD 350 / S_DAY8 500 / S_EMPTY 0）", async () => {
    const payload = await callTool({ minTokens: 1000 });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_MAIN, S_SUB, S_DAY1, S_DAY3]);
    expect(payload.sessions.total).toBe(4);
  });

  it("筛选：按时间 since=T0（仅 D0 当天活跃的三个会话）", async () => {
    const payload = await callTool({ since: T0 });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_MAIN, S_SUB, S_OLD]);
  });

  it("排序 sort=tokens：按合计 token 降序，与 recent 排序可区分", async () => {
    const payload = await callTool({ sort: "tokens" });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([
      S_DAY1, S_DAY3, S_SUB, S_MAIN, S_DAY8, S_OLD, S_EMPTY,
    ]);
  });

  it("limit 分页：total 为筛选命中数（分页前），items 截断到 limit", async () => {
    const payload = await callTool({ sort: "tokens", limit: 2 });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_DAY1, S_DAY3]);
    expect(payload.sessions.total).toBe(7);
  });

  it("筛选生效值回显（filters 字段携带实际使用的默认值）", async () => {
    const payload = await callTool({ project: PROJ_B, minTokens: 1000 });
    expect(payload.sessions.filters).toEqual({
      project: PROJ_B,
      since: null,
      until: null,
      minTokens: 1000,
      sort: "recent",
      limit: 50,
    });
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const payload = await callTool({}, { dbPath: join(repoRoot, "test", "fixtures", "absent.sqlite") });
    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("db-not-found");
    expect(payload.kpi).toBeNull();
    expect(payload.trend).toBeNull();
    expect(payload.sessions).toBeNull();
  });
});
