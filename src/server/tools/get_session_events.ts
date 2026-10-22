/**
 * 工具 get_session_events（T7，app+model 双可见）：
 * 返回会话事件流（压缩事件 + 模型切换事件）按时间升序；压缩事件含触发方式（manual/auto）
 * 与压缩前后 token 数（spec：压缩账本读 compaction part）。
 *
 * 会话定位：可选 sessionId 直选（source=explicit）；缺省沿用 T2 口径
 * （心跳精确 → 最近活跃 interactive 推断）。缺库/查询失败一律降级 available=false，不抛错。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath } from "../paths.ts";
import { openReadonlyDatabase } from "../db.ts";
import { resolveCurrentSession } from "../usage.ts";
import { listSessionEvents } from "../events.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface SessionEventsDeps {
  dbPath?: string;
  heartbeatPath?: string;
}

export function createSessionEventsTool(deps: SessionEventsDeps = {}): ToolDefinition {
  return {
    name: "get_session_events",
    title: "会话事件流",
    description:
      "返回会话事件流（按时间升序）：压缩事件（触发方式 manual/auto、压缩前后 token 数、" +
      "被总结/保留消息数）与模型切换事件（目标模型与供应商）。" +
      "缺省对当前会话查询（心跳精确 / 最近活跃推断）；可传 sessionId 直选会话。" +
      "db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("目标会话 ID；缺省取当前会话"),
    }),
    visibility: ["model", "app"],
    execute: async (args) => {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
      const payload = collectSessionEvents(deps, sessionId);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步；任何失败降级为 available=false） */
function collectSessionEvents(
  deps: SessionEventsDeps,
  sessionId: string | undefined,
): Record<string, unknown> {
  const dbPath = deps.dbPath ?? resolveDbPath();
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();

  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) {
    return { available: false, reason: opened.reason, session: null, events: null };
  }
  try {
    if (sessionId) {
      return {
        available: true,
        session: { id: sessionId, source: "explicit", heartbeatAt: null },
        events: listSessionEvents(opened.db, sessionId),
      };
    }
    const current = resolveCurrentSession(opened.db, heartbeatPath);
    if (!current) {
      return { available: false, reason: "no-interactive-session", session: null, events: null };
    }
    return {
      available: true,
      session: { id: current.id, source: current.source, heartbeatAt: current.heartbeatAt },
      events: listSessionEvents(opened.db, current.id),
    };
  } catch (err) {
    // schema 漂移（缺表缺列）等查询期异常：降级而非炸面板（细粒度探测见 T13）
    return {
      available: false,
      reason: `query-failed: ${err instanceof Error ? err.message : String(err)}`,
      session: null,
      events: null,
    };
  } finally {
    opened.db.close();
  }
}
