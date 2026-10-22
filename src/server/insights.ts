/**
 * Insights 跨会话聚合查询（T8；面板 Insights 页与模型侧共用的数据层缝）。
 *
 * 口径（与 test/insights.test.mjs 顶部手算注释一一对应）：
 *  - KPI 跨全部未删除会话，不受会话列表筛选参数影响；
 *    totalTokens = 全部 model_usage.computed_total_tokens 合计（含 session_title/compact 行）；
 *    activeDays = model_usage.started_at 去重 UTC 日数（"有模型请求"才算活跃）；
 *  - 7 天趋势锚定全库最大 started_at（夹具下确定性可算；真实宿主库持续写入，锚点≈当下），
 *    窗口为锚点 UTC 日起往前 7 个含端点日桶，旧→新返回；窗口外日期只计入 KPI 不计入趋势；
 *  - 会话列表 = session LEFT JOIN model_usage（零用量会话保留 requests=0/totalTokens=0），
 *    支持 project / since / until / minTokens / sort(recent|tokens) / limit 筛选。
 */
import type { DatabaseSync } from "node:sqlite";

/** KPI 带：跨全部会话的三项总览值 */
export interface InsightsKpi {
  totalTokens: number;
  totalSessions: number;
  activeDays: number;
}

/** 7 天趋势的单日桶（UTC 日） */
export interface TrendDay {
  date: string;
  tokens: number;
  requests: number;
  sessions: number;
}

/** 会话列表条目（会话卡片取数来源；parentId/taskType 供 Fleet 与子代理标注复用） */
export interface SessionListItem {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  taskType: string;
  parentId: string | null;
  timeCreated: number;
  timeUpdated: number;
  requests: number;
  totalTokens: number;
}

/** 会话列表筛选参数（工具入参的规范化形式） */
export interface SessionFilter {
  project: string | null;
  since: number | null;
  until: number | null;
  minTokens: number | null;
  sort: "recent" | "tokens";
  limit: number;
}

export interface ProjectSummary {
  id: string;
  directory: string;
  sessions: number;
}

/** Insights 总览载荷（工具 structuredContent 的形状） */
export interface InsightsPayload {
  available: true;
  /** 趋势窗口锚点：全库最大 model_usage.started_at（无用量行时为最大 session.time_updated） */
  anchorTime: number;
  kpi: InsightsKpi;
  trend: TrendDay[];
  projects: ProjectSummary[];
  sessions: {
    filters: SessionFilter;
    total: number;
    items: SessionListItem[];
  };
}

const DAY_MS = 86400000;
const TREND_DAYS = 7;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** UTC 日索引 → "YYYY-MM-DD"（趋势桶的确定性日期串） */
function dayIndexToDate(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

/** 查询全部聚合（打开的只读连接；任何异常由工具层 catch 降级） */
export function collectInsights(db: DatabaseSync, filter: Partial<SessionFilter>): InsightsPayload {
  const normalized = normalizeFilter(filter);

  const kpi = queryKpi(db);
  const anchorTime = queryAnchorTime(db);
  const trend = queryTrend(db, anchorTime);
  const projects = queryProjects(db);
  const { total, items } = querySessions(db, normalized);

  return { available: true, anchorTime, kpi, trend, projects, sessions: { filters: normalized, total, items } };
}

function normalizeFilter(filter: Partial<SessionFilter>): SessionFilter {
  return {
    project: typeof filter.project === "string" && filter.project.length > 0 ? filter.project : null,
    since: typeof filter.since === "number" && Number.isFinite(filter.since) ? filter.since : null,
    until: typeof filter.until === "number" && Number.isFinite(filter.until) ? filter.until : null,
    minTokens:
      typeof filter.minTokens === "number" && Number.isFinite(filter.minTokens) ? filter.minTokens : null,
    sort: filter.sort === "tokens" ? "tokens" : "recent",
    limit: clampInt(filter.limit, 1, MAX_LIMIT, DEFAULT_LIMIT),
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** KPI 三值：用量合计/活跃天数一条查询 + 会话总数一条查询 */
function queryKpi(db: DatabaseSync): InsightsKpi {
  const usage = db
    .prepare(
      `SELECT COALESCE(SUM(computed_total_tokens), 0) AS totalTokens,
              COUNT(DISTINCT started_at / ${DAY_MS}) AS activeDays
       FROM model_usage`,
    )
    .get() as { totalTokens: number; activeDays: number };
  const sessions = db
    .prepare(`SELECT COUNT(*) AS totalSessions FROM session WHERE time_deleted IS NULL`)
    .get() as { totalSessions: number };
  return {
    totalTokens: usage.totalTokens,
    totalSessions: sessions.totalSessions,
    activeDays: usage.activeDays,
  };
}

/** 锚点：优先最新模型请求时刻，无用量行时退到最新会话更新时刻（可能为 0，空库） */
function queryAnchorTime(db: DatabaseSync): number {
  const usage = db.prepare(`SELECT MAX(started_at) AS a FROM model_usage`).get() as { a: number | null };
  if (usage.a !== null) return usage.a;
  const session = db
    .prepare(`SELECT MAX(time_updated) AS a FROM session WHERE time_deleted IS NULL`)
    .get() as { a: number | null };
  return session.a ?? 0;
}

/** 7 天趋势：锚点 UTC 日为最后一桶，窗口内按日聚合（窗口外行不选取） */
function queryTrend(db: DatabaseSync, anchorTime: number): TrendDay[] {
  const anchorDay = Math.floor(anchorTime / DAY_MS);
  const firstDay = anchorDay - (TREND_DAYS - 1);
  const rows = db
    .prepare(
      `SELECT (started_at / ${DAY_MS}) AS dayIndex,
              SUM(computed_total_tokens) AS tokens,
              COUNT(*) AS requests,
              COUNT(DISTINCT session_id) AS sessions
       FROM model_usage
       WHERE started_at / ${DAY_MS} BETWEEN ? AND ?
       GROUP BY dayIndex`,
    )
    .all(firstDay, anchorDay) as Array<{
    dayIndex: number;
    tokens: number;
    requests: number;
    sessions: number;
  }>;

  const byIndex = new Map(rows.map((r) => [r.dayIndex, r]));
  const trend: TrendDay[] = [];
  for (let i = firstDay; i <= anchorDay; i++) {
    const row = byIndex.get(i);
    trend.push({
      date: dayIndexToDate(i),
      tokens: row?.tokens ?? 0,
      requests: row?.requests ?? 0,
      sessions: row?.sessions ?? 0,
    });
  }
  return trend;
}

/** 项目清单（筛选下拉数据源；directory 取该项目的任一目录） */
function queryProjects(db: DatabaseSync): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT project_id AS id, MIN(directory) AS directory, COUNT(*) AS sessions
       FROM session WHERE time_deleted IS NULL
       GROUP BY project_id
       ORDER BY sessions DESC, project_id ASC`,
    )
    .all() as Array<{ id: string; directory: string; sessions: number }>;
  return rows;
}

/** 会话列表：普通列条件走 WHERE，合计 token（规模筛选）走 HAVING 别名；值全为参数绑定 */
function querySessions(db: DatabaseSync, filter: SessionFilter): { total: number; items: SessionListItem[] } {
  const columnConditions = ["s.time_deleted IS NULL"];
  const bindParams: Array<string | number> = [];
  if (filter.project !== null) {
    columnConditions.push("s.project_id = ?");
    bindParams.push(filter.project);
  }
  if (filter.since !== null) {
    columnConditions.push("s.time_updated >= ?");
    bindParams.push(filter.since);
  }
  if (filter.until !== null) {
    columnConditions.push("s.time_updated <= ?");
    bindParams.push(filter.until);
  }
  const havingConditions: string[] = [];
  if (filter.minTokens !== null) {
    havingConditions.push("totalTokens >= ?"); // HAVING 引用 SELECT 别名（SQLite 支持）
  }

  const baseSql = `FROM session s
       LEFT JOIN model_usage mu ON mu.session_id = s.id
       WHERE ${columnConditions.join(" AND ")}
       GROUP BY s.id${havingConditions.length > 0 ? ` HAVING ${havingConditions.join(" AND ")}` : ""}`;
  const havingParams = filter.minTokens !== null ? [filter.minTokens] : [];
  const listParams = [...bindParams, ...havingParams];

  // 分页前命中数（外层包 COUNT，使 HAVING 的规模筛选计入 total）
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS total FROM (SELECT s.id, COALESCE(SUM(mu.computed_total_tokens), 0) AS totalTokens ${baseSql})`,
    )
    .all(...listParams) as Array<{ total: number }>;

  const orderBy =
    filter.sort === "tokens"
      ? "totalTokens DESC, s.time_updated DESC"
      : "s.time_updated DESC, s.id ASC";
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.project_id AS projectId, s.directory, s.task_type AS taskType,
              s.parent_id AS parentId, s.time_created AS timeCreated, s.time_updated AS timeUpdated,
              COUNT(mu.id) AS requests,
              COALESCE(SUM(mu.computed_total_tokens), 0) AS totalTokens
       ${baseSql}
       ORDER BY ${orderBy}
       LIMIT ?`,
    )
    .all(...listParams, filter.limit) as unknown as Array<SessionListItem>;

  return { total: totalRow[0]?.total ?? 0, items: rows };
}
