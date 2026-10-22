/**
 * 工具 get_insights（T8，面板专用 app 可见）：跨会话总览。
 * 返回 KPI 带（总 token / 会话数 / 活跃天数）、日 token 趋势（窗口默认 7 天，
 * trendDays 入参覆盖——面板按趋势粒度设置传 7/14/30）、项目清单与可筛选会话列表
 * （标题/项目/时间/token）。KPI 与趋势为全局口径（不受列表筛选影响）。
 *
 * 依赖注入缝与降级行为同 get_current_session_usage：db 缺失/查询失败 → available=false。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath } from "../paths.ts";
import { classifyDbError, openReadonlyDatabase } from "../db.ts";
import { collectInsights } from "../insights.ts";

export interface InsightsDeps {
  dbPath?: string;
}

export function createInsightsTool(deps: InsightsDeps = {}): ToolDefinition {
  return {
    name: "get_insights",
    title: "跨会话总览",
    description:
      "返回跨全部会话的 Insights 总览：KPI（总 token / 会话数 / 活跃天数）、日 token 趋势" +
      "（按 UTC 日聚合，锚定库内最新请求时刻；窗口默认 7 天，trendDays 覆盖）、项目清单，以及可筛选的会话列表" +
      "（project 按项目 / since+until 按会话更新时间 / minTokens 按规模 / sort=recent|tokens / limit 分页）。" +
      "KPI 与趋势为全局口径，不受列表筛选影响。db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      project: z.string().optional().describe("按 project_id 精确筛选会话列表"),
      since: z.number().optional().describe("会话更新时间下界（Unix 毫秒）"),
      until: z.number().optional().describe("会话更新时间上界（Unix 毫秒）"),
      minTokens: z.number().optional().describe("会话合计 token 下界（规模筛选）"),
      sort: z.enum(["recent", "tokens"]).optional().describe("排序：recent=按更新时间降序（默认），tokens=按合计 token 降序"),
      limit: z.number().int().optional().describe("列表长度上限（1-200，默认 50）"),
      trendDays: z.number().int().optional().describe("趋势窗口天数（含锚点日的日桶数，默认 7；面板按趋势粒度设置传 7/14/30）"),
    }),
    visibility: ["app"],
    execute: async (args) => {
      const payload = collectInsightsSafe(deps, args);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步；打开/查询失败降级为 available=false，不抛错） */
function collectInsightsSafe(deps: InsightsDeps, args: Record<string, unknown>): Record<string, unknown> {
  const trendDays = typeof args.trendDays === "number" ? args.trendDays : undefined;
  const dbPath = deps.dbPath ?? resolveDbPath();
  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) {
    return { available: false, reason: opened.reason, anchorTime: null, kpi: null, trend: null, projects: null, sessions: null };
  }
  try {
    return collectInsights(opened.db, args, trendDays) as unknown as Record<string, unknown>;
  } catch (err) {
    // schema 漂移（缺表缺列）/BUSY 等查询期异常：分类降级而非炸面板（classifyDbError，T13）
    return {
      available: false,
      reason: classifyDbError(err),
      anchorTime: null, kpi: null, trend: null, projects: null, sessions: null,
    };
  } finally {
    opened.db.close();
  }
}
