/**
 * 示例工具 get_overview：返回插件自检信息。
 * 面板（app）与模型（model）均可见——本工具是 T1 全链路（面板桥 → callServerTool → 渲染）的连通性探针。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { PLUGIN_NAME, PLUGIN_VERSION, SERVER_NAME } from "../meta.ts";

export const getOverviewTool: ToolDefinition = {
  name: "get_overview",
  title: "插件概览",
  description:
    "返回 Context Insight 插件的自检信息（名称、版本、MCP server 名与问候语），用于面板与模型侧连通性验证。",
  inputSchema: z.object({}),
  visibility: ["model", "app"],
  execute: async () => {
    const payload = {
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      server: SERVER_NAME,
      protocol: "mcp-apps",
      greeting: "Context Insight 插件骨架已就绪。",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
};
