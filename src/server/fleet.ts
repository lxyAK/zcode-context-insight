/**
 * Fleet 代理网络树查询（T10）。
 *
 * 口径（研究笔记 03 §2 与 GLOSSARY「Fleet（代理网络）」）：
 *  - 树边 = session.parent_id（子代理会话指向父会话；主会话为 NULL），
 *    从根会话出发向下递归收齐全部后代，节点 task_type 原样透出（subagent_child /
 *    workflow_child 等），不在此层过滤——是否筛类型由消费方决定；
 *  - 每个节点聚合该会话自身的 model_usage（不含后代，用量按 session_id 天然隔离）：
 *    token 口径与 usage.ts 一致（总量以 computed_total_tokens 为准），
 *    耗时 = SUM(duration_ms)（请求耗时合计）；状态 = 最近一次请求的 status，
 *    另给 errorRequests 供卡片呈现错误请求计数；
 *  - 根会话未落库（心跳指向新会话）：返回元数据为 null、用量全 0 的单节点树。
 */
import type { DatabaseSync } from "node:sqlite";

/** 节点用量聚合（该会话自身请求，不含后代） */
export interface FleetNodeUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  computedTotalTokens: number;
  /** 请求耗时合计：SUM(duration_ms)（NULL 行计 0） */
  durationMsTotal: number;
  /** status='error' 的请求数 */
  errorRequests: number;
  /** 最近一次请求的 status（running/completed/error/cancelled）；无请求时 null */
  lastRequestStatus: string | null;
}

/** Fleet 树节点（递归结构） */
export interface FleetNode {
  id: string;
  title: string | null;
  taskType: string | null;
  parentId: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  usage: FleetNodeUsage;
  children: FleetNode[];
}

/** 全 0 用量（会话无请求行，或根未落库） */
function emptyUsage(): FleetNodeUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    computedTotalTokens: 0,
    durationMsTotal: 0,
    errorRequests: 0,
    lastRequestStatus: null,
  };
}

/** 树内会话的用量聚合与最近请求状态（一次 IN 查询 + 一次轻量状态行扫描） */
type SessionUsageWithStatus = Omit<FleetNodeUsage, "lastRequestStatus"> & { lastStatus: string | null };

function collectUsageBySession(
  db: DatabaseSync,
  sessionIds: string[],
): Map<string, SessionUsageWithStatus> {
  const result = new Map<string, SessionUsageWithStatus>();
  if (sessionIds.length === 0) return result;
  const placeholders = sessionIds.map(() => "?").join(", ");

  const aggRows = db
    .prepare(
      `SELECT session_id,
              COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(computed_total_tokens) AS computed_total,
              SUM(COALESCE(duration_ms, 0)) AS duration_ms_total,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_requests
       FROM model_usage WHERE session_id IN (${placeholders})
       GROUP BY session_id`,
    )
    .all(...sessionIds) as Array<Record<string, number | string | null>>;
  for (const r of aggRows) {
    result.set(String(r.session_id), {
      requests: Number(r.requests ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      computedTotalTokens: Number(r.computed_total ?? 0),
      durationMsTotal: Number(r.duration_ms_total ?? 0),
      errorRequests: Number(r.error_requests ?? 0),
      lastStatus: null,
    });
  }

  // 最近请求状态：按 started_at 升序扫描，每会话取最后一条的 status
  // （树内会话请求量有限，轻量列内存扫描；避免依赖窗口函数的方言差异）
  const statusRows = db
    .prepare(
      `SELECT session_id, status FROM model_usage
       WHERE session_id IN (${placeholders}) ORDER BY started_at ASC`,
    )
    .all(...sessionIds) as Array<{ session_id: string; status: string }>;
  for (const r of statusRows) {
    const entry = result.get(r.session_id);
    if (entry) entry.lastStatus = r.status;
  }
  return result;
}

/**
 * 以 rootSessionId 为根构建 Fleet 父子树。
 * 根未落库时返回元数据 null 的单节点树（不抛错，消费方按降级呈现）。
  * @param db 只读连接
 * @param rootSessionId 根会话 ID
 * @return 以该会话为根的 Fleet 树（节点含用量与状态聚合）
 */
export function buildFleetTree(db: DatabaseSync, rootSessionId: string): FleetNode {
  // 全量 session 行（真实宿主千行以内）；time_deleted 软删除行不进树
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, task_type, time_created, time_updated
       FROM session WHERE time_deleted IS NULL`,
    )
    .all() as Array<{
    id: string;
    parent_id: string | null;
    title: string;
    task_type: string;
    time_created: number;
    time_updated: number;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  // parent_id → 子会话索引；同父按 time_created 升序（展示顺序稳定）
  const childrenOf = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.parent_id === null) continue;
    const list = childrenOf.get(r.parent_id) ?? [];
    list.push(r);
    childrenOf.set(r.parent_id, list);
  }

  // 自根向下收齐树内会话（visited 防御脏数据成环导致的死循环）
  const inTree: typeof rows = [];
  const visited = new Set<string>();
  const queue: string[] = [rootSessionId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const row = byId.get(id);
    if (row) inTree.push(row);
    for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
  }

  const usageBySession = collectUsageBySession(db, inTree.map((r) => r.id));

  const toNode = (row: (typeof rows)[number] | undefined, parentId: string | null): FleetNode => {
    const usage = row ? usageBySession.get(row.id) : undefined;
    return {
      id: row?.id ?? rootSessionId,
      title: row?.title ?? null,
      taskType: row?.task_type ?? null,
      parentId,
      timeCreated: row?.time_created ?? null,
      timeUpdated: row?.time_updated ?? null,
      usage: usage
        ? {
            requests: usage.requests,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            computedTotalTokens: usage.computedTotalTokens,
            durationMsTotal: usage.durationMsTotal,
            errorRequests: usage.errorRequests,
            lastRequestStatus: usage.lastStatus,
          }
        : emptyUsage(),
      children: [],
    };
  };

  const build = (row: (typeof rows)[number] | undefined, id: string, parentId: string | null): FleetNode => {
    const node = toNode(row, parentId);
    const kids = (childrenOf.get(id) ?? []).slice().sort((a, b) => a.time_created - b.time_created);
    node.children = kids.map((k) => build(k, k.id, id));
    return node;
  };

  return build(byId.get(rootSessionId), rootSessionId, null);
}
