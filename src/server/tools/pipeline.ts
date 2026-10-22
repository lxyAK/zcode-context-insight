/**
 * 会话级工具的共享管线（review 修复 P1-7）：
 *  - SessionToolDeps：公共依赖形状（db/心跳路径的测试注入缝）；
 *  - withReadonlyDb：open → fn(db, heartbeatPath) → finally close 的统一管道，
 *    打开失败与查询期异常（schema 漂移/BUSY，classifyDbError，T13）统一降级
 *    available=false，reason 机器可读；
 *  - sessionMetaBlock：会话元数据块（识别来源 + session 表行字段）。
 * 纯机械抽取：各工具此前的样板语义与此处逐字一致，行为不变。
 */
import type { DatabaseSync } from "node:sqlite";
import { resolveDbPath, resolveHeartbeatPath } from "../paths.ts";
import { classifyDbError, openReadonlyDatabase } from "../db.ts";
import type { SessionRow } from "../usage.ts";

/** 会话级工具公共依赖形状（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface SessionToolDeps {
  dbPath?: string;
  heartbeatPath?: string;
}

/**
 * 只读库管道：打开只读连接执行 fn，无论成败 finally 关闭。
 * 打开失败与查询期异常统一降级为 { available:false, reason, ...degrade }。
 *
 * @param deps 依赖注入（dbPath 缺省经 paths.ts 解析）
 * @param degrade 降级载荷的附加字段（如 { session:null, usage:null }）
 * @param fn 查询体（接收打开的连接与解析好的心跳路径；返回 available=true 的载荷
 *   或自行构造的降级载荷如 no-interactive-session）
 * @returns fn 的返回值，或打开/查询失败的统一降级载荷
 */
export function withReadonlyDb<T extends Record<string, unknown>>(
  deps: SessionToolDeps,
  degrade: Record<string, unknown>,
  fn: (db: DatabaseSync, heartbeatPath: string) => T,
): Record<string, unknown> {
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();
  const opened = openReadonlyDatabase(deps.dbPath ?? resolveDbPath());
  if (!opened.ok) {
    return { available: false, reason: opened.reason, ...degrade };
  }
  try {
    return fn(opened.db, heartbeatPath);
  } catch (err) {
    // schema 漂移（缺表缺列）/BUSY 等查询期异常：分类降级而非炸面板（classifyDbError，T13）
    return { available: false, reason: classifyDbError(err), ...degrade };
  } finally {
    opened.db.close();
  }
}

/** 会话元数据块：识别来源标注（ADR-0003）+ session 表行字段（未落库为 null） */
export function sessionMetaBlock(
  session: { id: string; source: "explicit" | "heartbeat" | "inferred"; heartbeatAt: number | null },
  row: SessionRow | null,
): {
  id: string;
  source: string;
  heartbeatAt: number | null;
  title: string | null;
  taskType: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
} {
  return {
    id: session.id,
    source: session.source,
    heartbeatAt: session.heartbeatAt,
    title: row?.title ?? null,
    taskType: row?.taskType ?? null,
    timeCreated: row?.timeCreated ?? null,
    timeUpdated: row?.timeUpdated ?? null,
  };
}
