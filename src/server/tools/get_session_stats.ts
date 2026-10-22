/**
 * 工具 get_session_stats（T5，app+model 双可见）：
 * 返回当前会话的统计汇总口径——缓存命中率（cacheRead / input 合计，input 已含缓存读）、
 * TTFT 分布 p50/p95（nearest-rank，仅计 time_to_first_token_ms 非空样本）、
 * 重试计数（SUM(retry_count)）、上下文超限计数（SUM(context_exceeded)）与 token 合计。
 *
 * 依赖注入缝与降级语义同 get_current_session_usage：缺库/查询失败一律 available=false。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath } from "../paths.ts";
import { openReadonlyDatabase } from "../db.ts";
import { aggregateSessionStats, getSessionRow, resolveCurrentSession } from "../usage.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface SessionStatsDeps {
  dbPath?: string;
  heartbeatPath?: string;
}

export function createSessionStatsTool(deps: SessionStatsDeps = {}): ToolDefinition {
  return {
    name: "get_session_stats",
    title: "当前会话统计",
    description:
      "返回当前会话的统计汇总：缓存命中率（cacheRead/input 合计，input 已含缓存读部分）、" +
      "TTFT p50/p95（nearest-rank 分位，仅计成功产生首 token 的请求）、重试计数、" +
      "上下文超限计数与 token 合计（总量以 computed_total_tokens 为准）。" +
      "样本缺失的项（命中率、分位数）返回 null 而非 0。db 不可用时 available=false 降级返回。",
    inputSchema: z.object({}),
    visibility: ["model", "app"],
    execute: async () => {
      const payload = collectSessionStats(deps);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步；任何失败降级为 available=false，不炸面板） */
function collectSessionStats(deps: SessionStatsDeps): Record<string, unknown> {
  const dbPath = deps.dbPath ?? resolveDbPath();
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();

  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) {
    return { available: false, reason: opened.reason, session: null, stats: null };
  }
  try {
    const current = resolveCurrentSession(opened.db, heartbeatPath);
    if (!current) {
      return { available: false, reason: "no-interactive-session", session: null, stats: null };
    }
    const row = getSessionRow(opened.db, current.id);
    const stats = aggregateSessionStats(opened.db, current.id);
    return {
      available: true,
      session: {
        id: current.id,
        source: current.source,
        heartbeatAt: current.heartbeatAt,
        title: row?.title ?? null,
        taskType: row?.taskType ?? null,
        timeCreated: row?.timeCreated ?? null,
        timeUpdated: row?.timeUpdated ?? null,
      },
      stats,
    };
  } catch (err) {
    // schema 漂移（缺表缺列）等查询期异常：降级而非炸面板
    return {
      available: false,
      reason: `query-failed: ${err instanceof Error ? err.message : String(err)}`,
      session: null,
      stats: null,
    };
  } finally {
    opened.db.close();
  }
}
