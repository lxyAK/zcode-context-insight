/**
 * 工具 get_fleet_tree（T10，面板专用 app 可见）：
 * 返回以指定会话（默认当前会话，复用心跳/兜底识别，ADR-0003）为根的 Fleet 代理网络树。
 * 树边 = session.parent_id；每个节点聚合该会话自身的精确用量（token/请求耗时合计）
 * 与状态（最近一次请求 status、错误请求数）。刷新式静态快照，不做实时推送。
 *
 * 依赖注入缝：deps 允许显式指定 db 与心跳路径（测试/调试），默认经 paths.ts 从
 * 环境变量与宿主默认位置解析。缺库/打开失败一律降级 available=false，不抛错。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveCurrentSession } from "../usage.ts";
import { buildFleetTree } from "../fleet.ts";
import { withReadonlyDb, type SessionToolDeps } from "./pipeline.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export type FleetTreeDeps = SessionToolDeps;

export function createFleetTreeTool(deps: FleetTreeDeps = {}): ToolDefinition {
  return {
    name: "get_fleet_tree",
    title: "Fleet 代理网络树",
    description:
      "返回以指定会话为根的 Fleet 代理网络父子树（树边=session.parent_id）。" +
      "不传 sessionId 时默认取当前会话（心跳精确识别优先，无心跳兜底最近活跃 interactive 会话并标注 inferred）。" +
      "每个节点聚合该会话自身的精确用量（请求数、input/output token、总量 computed_total_tokens、" +
      "请求耗时合计）与状态（最近一次请求 status、错误请求数）。无子代理会话返回单节点树。" +
      "db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      /** 根会话 ID；缺省为当前会话（心跳/兜底识别） */
      sessionId: z.string().optional(),
    }),
    visibility: ["app"],
    execute: async (args) => {
      const payload = collectFleetTree(deps, args);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步：识别根 → 只读连接 → 构树；任何失败降级为 available=false） */
function collectFleetTree(
  deps: FleetTreeDeps,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const requestedSessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
  // 显式指定的根无需开库即可先定下；当前会话识别需要库（兜底查询在库上进行）
  return withReadonlyDb(deps, { rootSessionSource: null, root: null }, (db, heartbeatPath) => {
    let rootId: string;
    let rootSource: "heartbeat" | "inferred" | "explicit";
    if (requestedSessionId) {
      rootId = requestedSessionId;
      rootSource = "explicit";
    } else {
      const current = resolveCurrentSession(db, heartbeatPath);
      if (!current) {
        return { available: false, reason: "no-interactive-session", rootSessionSource: null, root: null };
      }
      rootId = current.id;
      rootSource = current.source;
    }
    const root = buildFleetTree(db, rootId);
    return { available: true, rootSessionSource: rootSource, root };
  });
}
