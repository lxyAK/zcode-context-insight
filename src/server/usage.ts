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

/** 逐请求时间线行（T4；字段语义对照 model_usage 同名列，时间戳为 Unix 毫秒） */
export interface TimelineRequestRow {
  index: number;
  startedAt: number;
  querySource: string;
  modelId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  computedTotalTokens: number;
  contextExceeded: boolean;
}

/** 取指定会话的逐请求时间线（model_usage 按 started_at 升序，序号从 0 起） */
export function fetchRequestTimeline(db: DatabaseSync, sessionId: string): TimelineRequestRow[] {
  const rows = db
    .prepare(
      `SELECT started_at, query_source, model_id, status,
              input_tokens, output_tokens, reasoning_tokens,
              cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens,
              context_exceeded
       FROM model_usage WHERE session_id = ?
       ORDER BY started_at ASC, id ASC`,
    )
    .all(sessionId) as Array<Record<string, number | string | null>>;
  return rows.map((r, index) => ({
    index,
    startedAt: Number(r.started_at),
    querySource: String(r.query_source),
    modelId: String(r.model_id),
    status: String(r.status),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    reasoningTokens: Number(r.reasoning_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_creation_input_tokens ?? 0),
    computedTotalTokens: Number(r.computed_total_tokens ?? 0),
    contextExceeded: Number(r.context_exceeded ?? 0) !== 0,
  }));
}

/**
 * 压缩事件标记（T4；来自 part 表 type='compaction' 行，结构对照研究笔记 03 §5）。
 * 口径：truePostCompactTokenCount = 真实压缩后上下文 token 数；
 *       postCompactTokenCount = 含总结消息在内的 post 值（两者刻意区分，勿混用）。
 */
export interface CompactionEvent {
  time: number;
  /** 触发方式：auto=true 自动 / false 手动 */
  auto: boolean | null;
  trigger: string | null;
  phase: string | null;
  compactReason: string | null;
  preCompactTokenCount: number | null;
  postCompactTokenCount: number | null;
  truePostCompactTokenCount: number | null;
  summarizedMessageCount: number | null;
  keptMessageCount: number | null;
  /** 关联的时间线请求序号（最后一个 started_at <= time 的请求；早于全部请求时为 null） */
  requestIndex: number | null;
}

/** 查询指定会话的压缩事件并关联请求序号（part 无函数索引，先按 session_id 过滤） */
export function fetchCompactionEvents(
  db: DatabaseSync,
  sessionId: string,
  requests: TimelineRequestRow[] = [],
): CompactionEvent[] {
  interface PartRow {
    time_created: number;
    auto: number | null;
    trigger: string | null;
    phase: string | null;
    compactReason: string | null;
    pre: number | null;
    post: number | null;
    truePost: number | null;
    summarized: number | null;
    kept: number | null;
  }
  // 真实结构中 trigger/phase/compactReason 顶层与 compactBoundary 内均可能出现，取先非空者
  const rows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.auto') AS auto,
              COALESCE(json_extract(data, '$.trigger'), json_extract(data, '$.compactBoundary.trigger')) AS trigger,
              COALESCE(json_extract(data, '$.phase'), json_extract(data, '$.compactBoundary.phase')) AS phase,
              COALESCE(json_extract(data, '$.compactReason'), json_extract(data, '$.compactBoundary.compactReason')) AS compactReason,
              json_extract(data, '$.compactBoundary.preCompactTokenCount') AS pre,
              json_extract(data, '$.compactBoundary.postCompactTokenCount') AS post,
              json_extract(data, '$.compactBoundary.truePostCompactTokenCount') AS truePost,
              json_extract(data, '$.compactBoundary.summarizedMessageCount') AS summarized,
              json_extract(data, '$.compactBoundary.keptMessageCount') AS kept
       FROM part
       WHERE session_id = ? AND json_extract(data, '$.type') = 'compaction'
       ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId) as unknown as PartRow[];

  return rows.map((r) => {
    // 关联序号：最后一个 started_at <= 事件时间的请求（requests 已按时间升序）
    let requestIndex: number | null = null;
    for (const req of requests) {
      if (req.startedAt <= Number(r.time_created)) requestIndex = req.index;
      else break;
    }
    return {
      time: Number(r.time_created),
      auto: r.auto === null ? null : Number(r.auto) !== 0,
      trigger: r.trigger ?? null,
      phase: r.phase ?? null,
      compactReason: r.compactReason ?? null,
      preCompactTokenCount: r.pre === null ? null : Number(r.pre),
      postCompactTokenCount: r.post === null ? null : Number(r.post),
      truePostCompactTokenCount: r.truePost === null ? null : Number(r.truePost),
      summarizedMessageCount: r.summarized === null ? null : Number(r.summarized),
      keptMessageCount: r.kept === null ? null : Number(r.kept),
      requestIndex,
    };
  });
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
