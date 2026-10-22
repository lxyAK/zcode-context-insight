/**
 * 会话识别与用量聚合查询（T2；T4/T5/T8 复用的 db 查询缝）。
 *
 * 口径（研究笔记 03 §3 与 GLOSSARY）：
 *  - input_tokens 已含 cache_read 部分；精确总量以宿主计算的 computed_total_tokens 为准；
 *  - query_source 细分随总聚合一并返回（session_title 类不计入"用户对话成本"是
 *    Insights 口径，消费方按需取用，本层不做过滤）；
 *  - 当前会话识别：心跳优先（精确），无心跳兜底最近活跃 interactive 会话（标注推断）。
 */
import type { DatabaseSync } from "node:sqlite";
import { readHeartbeat, type Heartbeat } from "./heartbeat.ts";

/** 会话识别结果：source 标注"心跳精确"或"推断兜底" */
export interface CurrentSession {
  id: string;
  source: "heartbeat" | "inferred";
  heartbeatAt: number | null;
}

/** session 表元数据（心跳指向未落库的新会话时取不到，字段为 null） */
export interface SessionRow {
  id: string;
  title: string | null;
  taskType: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
}

/** 精确用量聚合（全请求合计；字段语义对照 model_usage 同名列） */
export interface UsageAggregate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  computedTotalTokens: number;
  /** time_to_first_token_ms 合计（毫秒） */
  ttftMsTotal: number;
  /** 按 query_source 细分（main_turn / subagent / session_title / compact / ...） */
  byQuerySource: Record<string, { requests: number; inputTokens: number; outputTokens: number; computedTotalTokens: number }>;
}

/**
 * 识别当前会话：心跳文件可用即精确返回；否则查询最近活跃 interactive 会话兜底
 * （task_type != interactive 的子代理/工作流会话排除，ADR 红线）。
 */
export function resolveCurrentSession(db: DatabaseSync, heartbeatPath: string): CurrentSession | null {
  const heartbeat: Heartbeat | null = readHeartbeat(heartbeatPath);
  if (heartbeat) {
    return { id: heartbeat.sessionId, source: "heartbeat", heartbeatAt: heartbeat.time };
  }
  const row = db
    .prepare(
      `SELECT id FROM session
       WHERE task_type = 'interactive' AND time_deleted IS NULL
       ORDER BY time_updated DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return row ? { id: row.id, source: "inferred", heartbeatAt: null } : null;
}

/** 取 session 元数据；会话未落库时返回 null */
export function getSessionRow(db: DatabaseSync, sessionId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT id, title, task_type, time_created, time_updated
       FROM session WHERE id = ?`,
    )
    .get(sessionId) as
    | { id: string; title: string; task_type: string; time_created: number; time_updated: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    taskType: row.task_type,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

/** 会话统计汇总（T5 统计卡口径；字段为空样本时分位数/比率为 null） */
export interface SessionStats {
  requests: number;
  /** 缓存命中率：SUM(cache_read) / SUM(input)（input 已含缓存读，研究笔记 03 §3）；无请求时 null */
  cacheHitRate: number | null;
  /** SUM(context_exceeded)：上下文超限的请求次数 */
  contextExceededCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  computedTotalTokens: number;
  /** TTFT 有效样本数（time_to_first_token_ms 非空的行） */
  ttftCount: number;
  /** TTFT p50（nearest-rank：排序后第 ceil(0.50×n) 个），无样本时 null */
  ttftP50Ms: number | null;
  /** TTFT p95（nearest-rank：排序后第 ceil(0.95×n) 个），无样本时 null */
  ttftP95Ms: number | null;
  /** SUM(retry_count)：重试次数合计（NULL 行计 0） */
  retryCount: number;
}

/** nearest-rank 分位数：排序样本（1-based）第 ceil(p×n) 个；无样本返回 null（"未知"而非 0） */
function percentileNearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length); // p∈(0,1]，rank∈[1,n]
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * 汇总指定会话的统计口径（T5 统计卡）：
 *  - 缓存命中率 = cacheRead / input 合计（input_tokens 已含 cache_read，分母不另加）；
 *  - TTFT 分布取 time_to_first_token_ms 非空样本（失败请求无首 token，自然排除）；
 *  - 重试/超限计数取 SUM（NULL 行按 0 计）。
 */
export function aggregateSessionStats(db: DatabaseSync, sessionId: string): SessionStats {
  const total = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(reasoning_tokens) AS reasoning_tokens,
              SUM(cache_creation_input_tokens) AS cache_creation,
              SUM(cache_read_input_tokens) AS cache_read,
              SUM(computed_total_tokens) AS computed_total,
              SUM(COALESCE(retry_count, 0)) AS retry_count,
              SUM(COALESCE(context_exceeded, 0)) AS context_exceeded
       FROM model_usage WHERE session_id = ?`,
    )
    .get(sessionId) as Record<string, number | null>;

  // 分位数需要全样本：按会话取非空 TTFT 升序（会话级样本量有限，内存可承受）
  const samples = (
    db
      .prepare(
        `SELECT time_to_first_token_ms AS ttft
         FROM model_usage
         WHERE session_id = ? AND time_to_first_token_ms IS NOT NULL
         ORDER BY time_to_first_token_ms`,
      )
      .all(sessionId) as Array<{ ttft: number }>
  ).map((r) => Number(r.ttft));

  const inputTokens = Number(total?.input_tokens ?? 0);
  const cacheReadTokens = Number(total?.cache_read ?? 0);

  return {
    requests: Number(total?.requests ?? 0),
    // 分母为 0（无请求）时比率为"未知"：null 而非 0/NaN（面板据此显示占位）
    cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null,
    contextExceededCount: Number(total?.context_exceeded ?? 0),
    inputTokens,
    outputTokens: Number(total?.output_tokens ?? 0),
    reasoningTokens: Number(total?.reasoning_tokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens: Number(total?.cache_creation ?? 0),
    computedTotalTokens: Number(total?.computed_total ?? 0),
    ttftCount: samples.length,
    ttftP50Ms: percentileNearestRank(samples, 0.5),
    ttftP95Ms: percentileNearestRank(samples, 0.95),
    retryCount: Number(total?.retry_count ?? 0),
  };
}

/** 聚合指定会话的请求级精确用量（SUM 对空集返回 NULL，统一落 0） */
export function aggregateSessionUsage(db: DatabaseSync, sessionId: string): UsageAggregate {
  const total = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(reasoning_tokens) AS reasoning_tokens,
              SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
              SUM(cache_read_input_tokens) AS cache_read_input_tokens,
              SUM(computed_total_tokens) AS computed_total_tokens,
              SUM(time_to_first_token_ms) AS ttft_ms_total
       FROM model_usage WHERE session_id = ?`,
    )
    .get(sessionId) as Record<string, number | null>;

  const byRows = db
    .prepare(
      `SELECT query_source,
              COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(computed_total_tokens) AS computed_total_tokens
       FROM model_usage WHERE session_id = ? GROUP BY query_source`,
    )
    .all(sessionId) as Array<Record<string, number | string | null>>;

  const byQuerySource: UsageAggregate["byQuerySource"] = {};
  for (const r of byRows) {
    byQuerySource[String(r.query_source)] = {
      requests: Number(r.requests ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      computedTotalTokens: Number(r.computed_total_tokens ?? 0),
    };
  }

  return {
    requests: total?.requests ?? 0,
    inputTokens: total?.input_tokens ?? 0,
    outputTokens: total?.output_tokens ?? 0,
    reasoningTokens: total?.reasoning_tokens ?? 0,
    cacheReadTokens: total?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: total?.cache_creation_input_tokens ?? 0,
    computedTotalTokens: total?.computed_total_tokens ?? 0,
    ttftMsTotal: total?.ttft_ms_total ?? 0,
    byQuerySource,
  };
}
