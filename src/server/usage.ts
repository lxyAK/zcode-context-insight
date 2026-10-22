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
