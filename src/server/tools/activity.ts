/**
 * 工具 get_activity_insights（T9，面板专用 app 可见）：Insights 活跃数据。
 *
 * 返回两类数据（同一时间窗口）：
 *  - daily：按「用户所在时区的自然日」聚合的活跃度（请求数 / computed_total_tokens /
 *    当日会话数），稀疏返回（仅含有活动的日历日），供热力图补零渲染；
 *  - models / providers：按 provider+model 与按 provider 聚合的 token 分布，供环形图。
 *
 * 口径（ADR/GLOSSARY）：
 *  - query_source=session_title 的宿主后台请求不计入（非用户对话成本），口径随载荷透出；
 *  - 子代理/工作流会话的请求计入 Insights 统计（不做 task_type 过滤）；
 *  - token 总量以宿主计算的 computed_total_tokens 为准。
 *
 * 依赖注入缝：deps 允许显式指定 db 路径与"当前时刻"（测试注入固定 nowMs，不依赖墙钟）。
 * 缺库/查询失败一律降级 available=false，不抛错（schema 漂移细粒度容错见 T13）。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { withReadonlyDb } from "./pipeline.ts";

/** 默认窗口：最近 91 个日历日（热力图 13 周 × 7 天） */
const DEFAULT_DAYS = 91;

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("统计窗口（最近 N 个日历日，含当日），默认 91"),
});

/** 工具依赖（测试注入缝；dbPath 缺省从环境与宿主默认路径解析） */
export interface ActivityDeps {
  dbPath?: string;
  /** "当前时刻"（毫秒）；缺省 Date.now()。测试注入固定值以稳定窗口边界 */
  nowMs?: number;
}

/** 本地日历日键（YYYY-MM-DD）；分桶边界 = 用户所在时区的自然日，非 UTC 日 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 窗口起点（含）：today 00:00 本地 - (days-1) 个日历日。用日期算术构造，天然处理跨月/闰年 */
function windowStartMs(nowMs: number, days: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
}

export function createActivityTool(deps: ActivityDeps = {}): ToolDefinition {
  return {
    name: "get_activity_insights",
    title: "Insights 活跃数据",
    description:
      "返回 Insights 活跃数据：按本地日历日聚合的活跃度（请求数、token 总量、当日会话数，" +
      "供活跃热力图）与按模型/供应商聚合的 token 分布（供环形图）。窗口为最近 N 个日历日" +
      "（days 参数，默认 91）。口径：token 以 computed_total_tokens 为准；" +
      "query_source=session_title 的后台请求不计入；子代理会话请求计入。db 不可用时 available=false 降级返回。",
    inputSchema,
    visibility: ["app"],
    execute: async (args: Record<string, unknown>) => {
      const { days: daysArg } = inputSchema.parse(args);
      const days = daysArg ?? DEFAULT_DAYS;
      const payload = collectActivity(deps, days);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步：打开只读连接 + 一次投影查询 + JS 分桶；任何失败降级为 available=false） */
function collectActivity(deps: ActivityDeps, days: number): Record<string, unknown> {
  const nowMs = deps.nowMs ?? Date.now();
  return withReadonlyDb(deps, { daily: null, models: null, providers: null }, (db) => {
    const startMs = windowStartMs(nowMs, days);
    // 投影最小列集后在 JS 分桶：按日分桶必须用本地时区日界，SQLite date() 只有 UTC/localtime
    // 两档且 localtime 受进程 TZ 环境影响，不可控；行数（窗口内请求级）在万级以内，可接受。
    // 上界 nowMs：晚于"当前时刻"的行不属于"最近 N 个日历日"窗口。
    const rows = db
      .prepare(
        `SELECT started_at, session_id, provider_id, model_id, computed_total_tokens
         FROM model_usage
         WHERE started_at >= ? AND started_at <= ? AND query_source != 'session_title'`,
      )
      .all(startMs, nowMs) as Array<{
      started_at: number;
      session_id: string;
      provider_id: string;
      model_id: string;
      computed_total_tokens: number;
    }>;

    return {
      available: true,
      rangeDays: days,
      nowMs,
      querySourcesExcluded: ["session_title"],
      daily: aggregateDaily(rows),
      models: aggregateBy(rows, (r) => r.provider_id, (r) => r.model_id),
      providers: aggregateBy(rows, (r) => r.provider_id, null),
    };
  });
}

/** 按日聚合：稀疏返回（仅含有活动的日历日），date 升序 */
function aggregateDaily(
  rows: Array<{
    started_at: number;
    session_id: string;
    computed_total_tokens: number;
  }>,
): Array<{ date: string; requests: number; computedTotalTokens: number; sessions: number }> {
  const byDate = new Map<
    string,
    { requests: number; computedTotalTokens: number; sessions: Set<string> }
  >();
  for (const r of rows) {
    const date = localDayKey(r.started_at);
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = { requests: 0, computedTotalTokens: 0, sessions: new Set() };
      byDate.set(date, bucket);
    }
    bucket.requests += 1;
    bucket.computedTotalTokens += Number(r.computed_total_tokens ?? 0);
    bucket.sessions.add(r.session_id);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) => ({
      date,
      requests: b.requests,
      computedTotalTokens: b.computedTotalTokens,
      sessions: b.sessions.size,
    }));
}

/** 按供应商(+模型)聚合 token 分布，token 降序 */
function aggregateBy(
  rows: Array<{ provider_id: string; model_id: string; computed_total_tokens: number }>,
  providerOf: (r: { provider_id: string }) => string,
  modelOf: ((r: { model_id: string }) => string) | null,
): Array<Record<string, string | number>> {
  const map = new Map<string, { requests: number; computedTotalTokens: number }>();
  for (const r of rows) {
    const providerId = providerOf(r);
    const key = modelOf ? `${providerId}\u0000${modelOf(r)}` : providerId;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { requests: 0, computedTotalTokens: 0 };
      map.set(key, bucket);
    }
    bucket.requests += 1;
    bucket.computedTotalTokens += Number(r.computed_total_tokens ?? 0);
  }
  return [...map.entries()]
    .map(([key, b]) => {
      const [providerId, modelId] = key.split("\u0000");
      const entry: Record<string, string | number> = {
        providerId,
        requests: b.requests,
        computedTotalTokens: b.computedTotalTokens,
      };
      if (modelId !== undefined) entry.modelId = modelId;
      return entry;
    })
    .sort((a, b) => Number(b.computedTotalTokens) - Number(a.computedTotalTokens));
}
