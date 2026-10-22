/**
 * 工具 get_session_timeline（T4，app+model 双可见）：
 * 返回会话逐请求时间线（input/output/缓存读/缓存写/推理/总量 + 时间戳 + 模型，来自 DB
 * model_usage，按 started_at 升序），并把 part 表 compaction 记录作为标记并入
 * （含 preCompactTokenCount 与 truePostCompactTokenCount、触发方式）。
 *
 * 依赖注入缝：deps 允许显式指定 db 与心跳路径（测试/调试），默认经 paths.ts 从
 * 环境变量与宿主默认位置解析。缺库/打开失败一律降级 available=false，不抛错。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath } from "../paths.ts";
import { openReadonlyDatabase } from "../db.ts";
import { fetchCompactionEvents, fetchRequestTimeline, getSessionRow, resolveCurrentSession } from "../usage.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface SessionTimelineDeps {
  dbPath?: string;
  heartbeatPath?: string;
}

export function createSessionTimelineTool(
  deps: SessionTimelineDeps = {},
): ToolDefinition {
  return {
    name: "get_session_timeline",
    title: "会话逐请求时间线",
    description:
      "返回指定会话（缺省为当前会话）的逐请求时间线：每次模型请求的 input/output/缓存读/缓存写 token、" +
      "时间戳、模型与 query_source，按时间升序排列（input 已含缓存读部分，总量以 computed_total_tokens 口径为准）。" +
      "同时并入该会话的压缩事件标记（preCompactTokenCount 与 truePostCompactTokenCount、触发方式）；" +
      "truePostCompactTokenCount 是真实压缩后的上下文 token 数，postCompactTokenCount 是含总结消息的 post 值，两者口径不同。" +
      "db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("目标会话 ID；缺省解析当前会话（心跳优先，兜底最近活跃 interactive）"),
    }),
    visibility: ["model", "app"],
    execute: async (args: Record<string, unknown>) => {
      const payload = collectSessionTimeline(deps, args);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步：读心跳 + 打开只读连接 + 查询；任何失败降级为 available=false） */
function collectSessionTimeline(
  deps: SessionTimelineDeps,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const dbPath = deps.dbPath ?? resolveDbPath();
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();

  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) {
    return { available: false, reason: opened.reason, session: null, requests: null, compactions: null };
  }
  try {
    const explicitId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : null;
    const current = resolveCurrentSession(opened.db, heartbeatPath);
    if (!explicitId && !current) {
      return { available: false, reason: "no-interactive-session", session: null, requests: null, compactions: null };
    }
    const sessionId = explicitId ?? current!.id;
    const source = explicitId ? "explicit" : current!.source;
    const row = getSessionRow(opened.db, sessionId);
    const requests = fetchRequestTimeline(opened.db, sessionId);
    const compactions = fetchCompactionEvents(opened.db, sessionId, requests);
    return {
      available: true,
      session: {
        id: sessionId,
        source,
        heartbeatAt: source === "heartbeat" ? current!.heartbeatAt : null,
        title: row?.title ?? null,
        taskType: row?.taskType ?? null,
        timeCreated: row?.timeCreated ?? null,
        timeUpdated: row?.timeUpdated ?? null,
      },
      requests,
      compactions,
    };
  } catch (err) {
    // schema 漂移（缺表缺列）等查询期异常：降级而非炸面板（细粒度探测见 T13）
    return {
      available: false,
      reason: `query-failed: ${err instanceof Error ? err.message : String(err)}`,
      session: null,
      requests: null,
      compactions: null,
    };
  } finally {
    opened.db.close();
  }
}
