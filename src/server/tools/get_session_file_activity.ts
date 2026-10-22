/**
 * 工具 get_session_file_activity（T7，面板专用 app 可见）：
 * 返回会话的文件读写/搜索记录（Read/Write/Edit/Grep/Glob 工具调用）按时间升序；
 * 每条含路径、操作类型（read/write/edit/search）与行数变化
 * （Edit=additions(new_string 行数)/deletions(old_string 行数)、Write=additions(content 行数)，
 * 行数按 \n 分割计、空串 0 行）。无记录时 activities 为空数组（面板空态）。
 *
 * 会话定位与降级口径同 get_session_events。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveCurrentSession } from "../usage.ts";
import { withReadonlyDb, type SessionToolDeps } from "./pipeline.ts";
import { listSessionFileActivity } from "../events.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export type SessionFileActivityDeps = SessionToolDeps;

export function createSessionFileActivityTool(deps: SessionFileActivityDeps = {}): ToolDefinition {
  return {
    name: "get_session_file_activity",
    title: "会话文件活动",
    description:
      "返回会话的文件活动记录（按时间升序）：读取/写入/编辑/搜索（Grep/Glob）与行数变化" +
      "（编辑 +新行数/-旧行数、写入 +行数；读取与搜索无行数变化），含每条的状态（completed/error）。" +
      "缺省对当前会话查询（心跳精确 / 最近活跃推断）；可传 sessionId 直选会话。" +
      "db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("目标会话 ID；缺省取当前会话"),
    }),
    visibility: ["app"],
    execute: async (args) => {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
      const payload = collectSessionFileActivity(deps, sessionId);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步；任何失败降级为 available=false） */
function collectSessionFileActivity(
  deps: SessionFileActivityDeps,
  sessionId: string | undefined,
): Record<string, unknown> {
  return withReadonlyDb(deps, { session: null, activities: null }, (db, heartbeatPath) => {
    if (sessionId) {
      return {
        available: true,
        session: { id: sessionId, source: "explicit", heartbeatAt: null },
        activities: listSessionFileActivity(db, sessionId),
      };
    }
    const current = resolveCurrentSession(db, heartbeatPath);
    if (!current) {
      return { available: false, reason: "no-interactive-session", session: null, activities: null };
    }
    return {
      available: true,
      session: { id: current.id, source: current.source, heartbeatAt: current.heartbeatAt },
      activities: listSessionFileActivity(db, current.id),
    };
  });
}
