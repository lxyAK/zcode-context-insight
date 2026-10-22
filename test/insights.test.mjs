/**
 * Insights 总览工具功能缝基线（T8，缝：in-process 直调工具 execute）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 的行集，不经被测代码反推）。
 * 手算口径（工具实现必须与之对齐；并集夹具含 T5 追加 3 行、T9 活跃行集、T10 孙代理行集、
 * T11 接近压缩会话 S_NEAR——合并 t11 时按并集夹具重算，来源见各行括注）：
 *  - KPI 跨全部未删除会话（不受列表筛选影响）：
 *      totalTokens = 各会话 model_usage.computed_total_tokens 全量合计
 *                  = 4405(S_MAIN 6 行) + 350(S_OLD) + 2300(S_SUB) + 1550(S_MULTI 4 行)
 *                    + 1200(S_SUBSUB 2 行) + 50000(S_DAY1) + 3000(S_DAY3) + 500(S_DAY8)
 *                    + 0(S_EMPTY) + 1000(S_NEAR 1 行，T11) = 64305
 *      totalSessions = 10
 *      activeDays = model_usage.started_at 去重 UTC 日
 *                 = {07-13(T11 mu_near_1，置于 T9 91 天窗口外的 100 天前), 10-13, 10-18,
 *                    10-19, 10-20, 10-21} = 6（10-19 为 T9 的 mu_act_c/d）
 *  - 7 天趋势：锚点 = 全库最大 started_at（= T0+52000，mu_subsub_2 → UTC 日 2026-10-21），
 *    窗口 [2026-10-15, 2026-10-21]（含端点 7 天，旧→新）：
 *      10-18: 3000 token / 2 请求 / 1 会话（S_DAY3 两行）
 *      10-19: 550 / 2 / 1（T9 mu_act_c 500 + mu_act_d 50，同挂 S_MULTI）
 *      10-20: 50300 / 2 / 2（S_DAY1 50000 + T9 mu_act_b 300）
 *      10-21: 8955 / 11 / 5（S_MAIN 4405 + S_OLD 350 + S_SUB 2300 + mu_act_a 700
 *              + S_SUBSUB 1200；请求 6+1+1+1+2）
 *      其余日全 0；10-13（S_DAY8）在窗口外不计入趋势但计入 KPI/活跃天数
 *  - 会话列表默认排序 recent = time_updated 降序（同刻按 id 升序）；
 *    tokens = 合计 token 降序
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
const S_MULTI = "session_00000000000000000000000000000004"; // T9 跨日会话
const S_SUBSUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000004"; // T10 孙代理
const S_DAY1 = "session_00000000000000000000000000000011";
const S_DAY3 = "session_00000000000000000000000000000012";
const S_DAY8 = "session_00000000000000000000000000000013";
const S_EMPTY = "session_00000000000000000000000000000014";
const S_NEAR = "session_00000000000000000000000000000006"; // T11 接近压缩会话（time_updated=T0+90000 全场最新；1 行 / 1000 token）
const PROJ_A = "proj_d-.opensource-zcode-context-insight";
const PROJ_B = "proj_d-.opensource-other-project";

// 手算期望（见文件头注释；并集夹具含 T5/T9/T10/T11 行集）
const EXPECT_KPI = { totalTokens: 64305, totalSessions: 10, activeDays: 6 };
const zero = { tokens: 0, requests: 0, sessions: 0 };
const EXPECT_TREND = [
  { date: "2026-10-15", ...zero },
  { date: "2026-10-16", ...zero },
  { date: "2026-10-17", ...zero },
  { date: "2026-10-18", tokens: 3000, requests: 2, sessions: 1 },
  { date: "2026-10-19", tokens: 550, requests: 2, sessions: 1 },
  { date: "2026-10-20", tokens: 50300, requests: 2, sessions: 2 },
  { date: "2026-10-21", tokens: 8955, requests: 11, sessions: 5 },
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
    // 锚点 = 全库最大 model_usage.started_at（T0+52000，mu_subsub_2 行）
    expect(payload.anchorTime).toBe(T0 + 52000);
  });

  it("项目清单含两个项目及会话数（筛选下拉数据源）", async () => {
    const payload = await callTool();
    expect(payload.projects).toEqual([
      // 项目 A：S_MAIN/S_OLD/S_SUB/S_MULTI/S_SUBSUB/S_EMPTY/S_DAY1/S_NEAR 共 8 个（并集夹具）
      { id: PROJ_A, directory: "D:\\.opensource\\zcode-context-insight", sessions: 8 },
      { id: PROJ_B, directory: "D:\\.opensource\\other-project", sessions: 2 },
    ]);
  });

  it("默认会话列表：按 time_updated 降序，含零用量会话（LEFT JOIN 语义）与子代理标注", async () => {
    const payload = await callTool();
    expect(payload.sessions.total).toBe(10);
    expect(payload.sessions.items.map(summary)).toEqual([
      // S_NEAR（T11）time_updated=T0+90000 全场最新 → 列表首位
      { id: S_NEAR, taskType: "interactive", requests: 1, totalTokens: 1000 },
      { id: S_MAIN, taskType: "interactive", requests: 6, totalTokens: 4405 },
      { id: S_SUBSUB, taskType: "subagent_child", requests: 2, totalTokens: 1200 },
      { id: S_SUB, taskType: "subagent_child", requests: 1, totalTokens: 2300 },
      { id: S_OLD, taskType: "interactive", requests: 1, totalTokens: 350 },
      { id: S_MULTI, taskType: "interactive", requests: 4, totalTokens: 1550 },
      { id: S_EMPTY, taskType: "interactive", requests: 0, totalTokens: 0 },
      { id: S_DAY1, taskType: "interactive", requests: 1, totalTokens: 50000 },
      { id: S_DAY3, taskType: "interactive", requests: 2, totalTokens: 3000 },
      { id: S_DAY8, taskType: "interactive", requests: 1, totalTokens: 500 },
    ]);
    // 列表项字段契约：标题/项目/时间/token（会话卡片的取数来源）
    const main = payload.sessions.items[1];
    expect(main.title).toBe("夹具主会话（当前）");
    expect(main.projectId).toBe(PROJ_A);
    expect(main.directory).toBe("D:\\.opensource\\zcode-context-insight");
    expect(main.timeUpdated).toBe(T0 + 60000);
    expect(main.parentId).toBeNull();
    const sub = payload.sessions.items[3];
    expect(sub.parentId).toBe(S_MAIN); // Fleet 后续工单复用
    const subsub = payload.sessions.items[2];
    expect(subsub.parentId).toBe(S_SUB); // 孙代理（T10 行集）
  });

  it("筛选：按项目（PROJ_B → S_DAY3/S_DAY8，仍按时间降序）", async () => {
    const payload = await callTool({ project: PROJ_B });
    expect(payload.sessions.total).toBe(2);
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_DAY3, S_DAY8]);
    // KPI 与趋势不受列表筛选影响（全局口径）
    expect(payload.kpi).toEqual(EXPECT_KPI);
    expect(payload.trend).toEqual(EXPECT_TREND);
  });

  it("筛选：按规模 minTokens=1000（剔除 S_DAY8 500 / S_OLD 350 / S_EMPTY 0）", async () => {
    const payload = await callTool({ minTokens: 1000 });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([
      S_NEAR, S_MAIN, S_SUBSUB, S_SUB, S_MULTI, S_DAY1, S_DAY3,
    ]);
    expect(payload.sessions.total).toBe(7); // S_NEAR 1000 恰达下界（T11 并入后新增命中）
  });

  it("筛选：按时间 since=T0（仅 D0 当天活跃的六个会话）", async () => {
    const payload = await callTool({ since: T0 });
    // since 按会话 time_updated 过滤：S_NEAR（T0+90000，T11）亦在 D0
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_NEAR, S_MAIN, S_SUBSUB, S_SUB, S_OLD, S_MULTI]);
  });

  it("排序 sort=tokens：按合计 token 降序，与 recent 排序可区分", async () => {
    const payload = await callTool({ sort: "tokens" });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([
      S_DAY1, S_MAIN, S_DAY3, S_SUB, S_MULTI, S_SUBSUB, S_NEAR, S_DAY8, S_OLD, S_EMPTY,
    ]);
  });

  it("limit 分页：total 为筛选命中数（分页前），items 截断到 limit", async () => {
    const payload = await callTool({ sort: "tokens", limit: 2 });
    expect(payload.sessions.items.map((s) => s.id)).toEqual([S_DAY1, S_MAIN]);
    expect(payload.sessions.total).toBe(10);
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
