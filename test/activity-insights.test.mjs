/**
 * get_activity_insights 功能缝基线（T9，工单预先约定的缝：in-process 直调工具 execute）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 的 T9 行集 mu_act_* 与既有行集），
 * 不经被测代码路径反推——夹具即真值来源。日期键用与被测代码独立的实现（sv-SE locale）
 * 从行时间戳推导，避免硬编码日历日导致时区脆弱。
 *
 * 口径（ADR/GLOSSARY）：
 *  - 按「用户所在时区的自然日」聚合（本地日历日，非 UTC 日）；
 *  - query_source=session_title 的后台请求不计入（宿主自动标题生成，非用户对话成本）；
 *  - 子代理会话的请求计入 Insights 统计；
 *  - token 总量以 computed_total_tokens 为准。
 *
 * 手算（91 天窗口、nowMs = T0+3600000，排除 session_title 后；含 T5 并入的 mu_main_4/5/6）：
 *   D0   = dayKey(mu_act_a=T0+30000)         计入 mu_main_1(1200)+mu_main_2(600)+mu_main_4(480)
 *                                             +mu_main_5(2000,error 行按真实消耗计入)+mu_main_6(110)
 *                                             +mu_old_1(350)+mu_sub_1(2300)+mu_act_a(700)
 *                                             → requests=8, computedTotal=7740, sessions=4（S_MAIN/S_OLD/S_SUB/S_MULTI）
 *   D0-1 = dayKey(mu_act_b=T0-86400000+1h)   计入 mu_act_b(300) → requests=1, computedTotal=300, sessions=1
 *   D0-2 = dayKey(mu_act_c=T0-2*86400000+2h) 计入 mu_act_c(500)；mu_act_d 为 session_title 应排除
 *                                             → requests=1, computedTotal=500, sessions=1
 *   模型分布：GLM-5.3/account:fixture     = 7740+500 = 8240（9 请求）
 *             GLM-4.7/account:fixture-alt = 300（1 请求）
 *   供应商：account:fixture=8240（9 请求）、account:fixture-alt=300（1 请求）
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");

// 与 scripts/make-fixtures.mjs 同源常量
const T0 = 1792600000000;
const NOW = T0 + 3600000; // 测试注入的"当前时刻"（仍在 D0 当日）

/** 独立实现的本地日历日键（sv-SE locale 恰好输出 YYYY-MM-DD；与被测代码实现路径不同） */
function dayKey(ms) {
  return new Date(ms).toLocaleDateString("sv-SE");
}

async function callTool(args = {}, deps = {}) {
  const { createActivityTool } = await import("../src/server/tools/activity.ts");
  const tool = createActivityTool({ dbPath: fixtureDb, nowMs: NOW, ...deps });
  const result = await tool.execute(args);
  return result.structuredContent;
}

describe("get_activity_insights（功能缝：直调 execute）", () => {
  it("按日聚合：默认 91 天窗口内三天的请求数/token/会话数与手算一致", async () => {
    const payload = await callTool();

    expect(payload.available).toBe(true);
    expect(payload.rangeDays).toBe(91);
    expect(payload.nowMs).toBe(NOW);

    const byDate = new Map(payload.daily.map((d) => [d.date, d]));

    // D0：既有行（含 T5 的 mu_main_4/5/6）+ mu_act_a；mu_main_3（session_title）排除
    expect(byDate.get(dayKey(T0 + 30000))).toEqual({
      date: dayKey(T0 + 30000),
      requests: 8,
      computedTotalTokens: 7740,
      sessions: 4,
    });
    // D0-1：仅 mu_act_b
    expect(byDate.get(dayKey(T0 - 86400000 + 3600000))).toEqual({
      date: dayKey(T0 - 86400000 + 3600000),
      requests: 1,
      computedTotalTokens: 300,
      sessions: 1,
    });
    // D0-2：mu_act_c 计入，mu_act_d（session_title）排除
    expect(byDate.get(dayKey(T0 - 2 * 86400000 + 7200000))).toEqual({
      date: dayKey(T0 - 2 * 86400000 + 7200000),
      requests: 1,
      computedTotalTokens: 500,
      sessions: 1,
    });
    // 稀疏返回：只有有活动的日历日（无第四天）
    expect(payload.daily).toHaveLength(3);
    // 升序
    const dates = payload.daily.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("session_title 请求不计入（口径标注随载荷透出）", async () => {
    const payload = await callTool();
    expect(payload.querySourcesExcluded).toEqual(["session_title"]);
    // mu_act_d（50 token）与 mu_main_3（15 token）若被计入将抬高对应日合计；由上面按日断言兜底，本条显式标注口径
  });

  it("模型分布：按 provider+model 聚合，token 降序，数值与手算一致", async () => {
    const payload = await callTool();

    expect(payload.models).toEqual([
      {
        providerId: "account:fixture",
        modelId: "GLM-5.3",
        requests: 9,
        computedTotalTokens: 8240,
      },
      {
        providerId: "account:fixture-alt",
        modelId: "GLM-4.7",
        requests: 1,
        computedTotalTokens: 300,
      },
    ]);
  });

  it("供应商分布：按 provider 聚合，token 降序", async () => {
    const payload = await callTool();

    expect(payload.providers).toEqual([
      { providerId: "account:fixture", requests: 9, computedTotalTokens: 8240 },
      { providerId: "account:fixture-alt", requests: 1, computedTotalTokens: 300 },
    ]);
  });

  it("days=1：窗口仅当日（D0），前两日行落在窗口外", async () => {
    const payload = await callTool({ days: 1 });

    expect(payload.rangeDays).toBe(1);
    expect(payload.daily).toEqual([
      { date: dayKey(T0 + 30000), requests: 8, computedTotalTokens: 7740, sessions: 4 },
    ]);
    // 窗口外数据不进分布：D0 计入的 8 行全部是 GLM-5.3/account:fixture
    // （1200+600+480+2000+110+350+2300+700 = 7740）
    expect(payload.models).toEqual([
      { providerId: "account:fixture", modelId: "GLM-5.3", requests: 8, computedTotalTokens: 7740 },
    ]);
  });

  it("days=2：窗口含 D0 与 D0-1", async () => {
    const payload = await callTool({ days: 2 });
    const dates = payload.daily.map((d) => d.date);
    expect(dates).toEqual([dayKey(T0 - 86400000 + 3600000), dayKey(T0 + 30000)]);
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const { createActivityTool } = await import("../src/server/tools/activity.ts");
    const tool = createActivityTool({
      dbPath: join(tmpdir(), "zci-absent", "no-such.sqlite"),
      nowMs: NOW,
    });
    const payload = (await tool.execute({})).structuredContent;

    expect(payload.available).toBe(false);
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason.length).toBeGreaterThan(0);
    expect(payload.daily).toBeNull();
    expect(payload.models).toBeNull();
  });

  it("空库（无任何 model_usage 行）：available=true 且 daily/models/providers 均为空数组", async () => {
    // days 窗口内无行的等价场景：把窗口缩到夹具最早行之前不可能（days 最小 7），
    // 直接用"极远过去"的 nowMs 表达同一空态：窗口完全落在夹具行集之外
    const payload = await callTool({}, { nowMs: T0 - 400 * 86400000 });

    expect(payload.available).toBe(true);
    expect(payload.daily).toEqual([]);
    expect(payload.models).toEqual([]);
    expect(payload.providers).toEqual([]);
  });

  it("days 参数越界（0 / 366 / 非整数）被 zod 拒绝", async () => {
    const { createActivityTool } = await import("../src/server/tools/activity.ts");
    const tool = createActivityTool({ dbPath: fixtureDb, nowMs: NOW });
    await expect(tool.execute({ days: 0 })).rejects.toThrow();
    await expect(tool.execute({ days: 366 })).rejects.toThrow();
    await expect(tool.execute({ days: 7.5 })).rejects.toThrow();
  });
});
