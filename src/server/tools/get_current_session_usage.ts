/**
 * 工具 get_current_session_usage（T2，面板专用 app 可见）：
 * 返回当前会话的请求级精确用量（input/output/缓存读/缓存写/推理/请求数/TTFT 合计，
 * 总量以 computed_total_tokens 为准）与会话识别来源标注（heartbeat=心跳精确 /
 * inferred=最近活跃推断 / explicit=显式指定，ADR-0003）。
 *
 * 显式 sessionId（review 修复 P0-3）：Insights 卡片跳转后 Context 仪表盘按目标会话
 * 查询；显式传参优先于心跳识别。
 *
 * 依赖注入缝：deps 允许显式指定 db 与心跳路径（测试/调试），默认经 paths.ts 从
 * 环境变量与宿主默认位置解析。缺库/打开失败一律降级 available=false，不抛错。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { aggregateSessionUsage, getSessionRow, resolveCurrentSession } from "../usage.ts";
import { sessionMetaBlock, withReadonlyDb, type SessionToolDeps } from "./pipeline.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export type CurrentSessionUsageDeps = SessionToolDeps;

/** 会话识别结果（source 三态：explicit=显式指定 / heartbeat=心跳精确 / inferred=推断） */
type ResolvedSession = {
  id: string;
  source: "explicit" | "heartbeat" | "inferred";
  heartbeatAt: number | null;
};

/**
 * 当前会话精确用量工具工厂。
 * @param deps 依赖注入（测试/调试；缺省从环境与宿主默认路径解析）
 * @return 工具定义（main.ts 注册到 MCP server）
 */
export function createCurrentSessionUsageTool(
  deps: CurrentSessionUsageDeps = {},
): ToolDefinition {
  return {
    name: "get_current_session_usage",
    title: "当前会话精确用量",
    description:
      "返回当前会话的精确用量（请求数、input/output/缓存读/缓存写/推理 token 合计、TTFT 合计；" +
      "总量以宿主 computed_total_tokens 口径为准，input 已含缓存读部分）。" +
      "会话识别来源：heartbeat=用户提交心跳（精确）；inferred=最近活跃 interactive 会话（推断）；" +
      "explicit=传入 sessionId 直选。db 不可用时 available=false 降级返回。",
    inputSchema: z.object({
      sessionId: z.string().optional().describe("目标会话 ID；缺省解析当前会话（心跳优先，兜底最近活跃 interactive）"),
    }),
    visibility: ["app"],
    execute: async (args) => {
      const explicitId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : null;
      const payload = collectCurrentSessionUsage(deps, explicitId);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（同步：读心跳 + 打开只读连接 + 聚合；任何失败降级为 available=false） */
function collectCurrentSessionUsage(deps: CurrentSessionUsageDeps, explicitId: string | null): Record<string, unknown> {
  return withReadonlyDb(deps, { session: null, usage: null }, (db, heartbeatPath) => {
    const current: ResolvedSession | null = explicitId
      ? { id: explicitId, source: "explicit", heartbeatAt: null }
      : resolveCurrentSession(db, heartbeatPath);
    if (!current) {
      // db 可读但没有任何 interactive 会话（全新宿主）
      return { available: false, reason: "no-interactive-session", session: null, usage: null };
    }
    return {
      available: true,
      session: sessionMetaBlock(current, getSessionRow(db, current.id)),
      usage: aggregateSessionUsage(db, current.id),
    };
  });
}
