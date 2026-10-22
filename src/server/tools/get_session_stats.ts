/**
 * 工具 get_session_stats（T5，面板专用 app 可见）：
 * 返回当前会话的统计汇总口径——缓存命中率（cacheRead / input 合计，input 已含缓存读）、
 * TTFT 分布 p50/p95（nearest-rank，仅计 time_to_first_token_ms 非空样本）、
 * 重试计数（SUM(retry_count)）、上下文超限计数（SUM(context_exceeded)）与 token 合计。
 *
 * 显式 sessionId（review 修复 P0-3）：Insights 卡片跳转后按目标会话统计；
 * 显式传参优先于心跳识别（source=explicit）。
 *
 * 依赖注入缝与降级语义同 get_current_session_usage：缺库/查询失败一律 available=false。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { aggregateSessionStats, getSessionRow, resolveCurrentSession } from "../usage.ts";
import { sessionMetaBlock, withReadonlyDb, type SessionToolDeps } from "./pipeline.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export type SessionStatsDeps = SessionToolDeps;

export function createSessionStatsTool(deps: SessionStatsDeps = {}): ToolDefinition {
  return {
    name: "get_session_stats",
    title: "当前会话统计",
    description:
      "返回当前会话的统计汇总：缓存命中率（cacheRead/input 合计，input 已含缓存读部分）、" +
      "TTFT p50/p95（nearest-rank 分位，仅计成功产生首 token 的请求）、重试计数、" +
      "上下文超限计数与 token 合计（总量以 computed_total_tokens 为准）。" +
      "样本缺失的项（命中率、分位数）返回 null 而非 0。db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("目标会话 ID；缺省解析当前会话（心跳优先，兜底最近活跃 interactive）"),
    }),
    visibility: ["app"],
    execute: async (args) => {
      const explicitId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : null;
      const payload = collectSessionStats(deps, explicitId);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步；任何失败降级为 available=false，不炸面板） */
function collectSessionStats(deps: SessionStatsDeps, explicitId: string | null): Record<string, unknown> {
  return withReadonlyDb(deps, { session: null, stats: null }, (db, heartbeatPath) => {
    const current = explicitId
      ? { id: explicitId, source: "explicit" as const, heartbeatAt: null }
      : resolveCurrentSession(db, heartbeatPath);
    if (!current) {
      return { available: false, reason: "no-interactive-session", session: null, stats: null };
    }
    return {
      available: true,
      session: sessionMetaBlock(current, getSessionRow(db, current.id)),
      stats: aggregateSessionStats(db, current.id),
    };
  });
}
