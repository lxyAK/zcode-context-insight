/**
 * MCP server 入口：stdio 传输，注册工具注册表与面板资源。
 * 构建为 dist/server.mjs（esbuild 自包含单文件，零运行时依赖）。
 *
 * 启动契约（实测 zcode.cjs __zcode-plugin-host）：
 *  - 宿主以 `ZCode.exe zcode.cjs __zcode-plugin-host <path>` 拉起本模块，
 *    要求导出 main() 并由宿主调用（import 时不做副作用启动）；
 *  - 直接 `node dist/server.mjs`（开发/测试）时按 import.meta.url 自启动。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./meta.ts";
import type { ToolDefinition } from "./registry.ts";
import { getOverviewTool } from "./tools/get_overview.ts";
import { createCurrentSessionUsageTool } from "./tools/get_current_session_usage.ts";
import { createCurrentSessionCompositionTool } from "./tools/get_current_session_composition.ts";
import { createSessionStatsTool } from "./tools/get_session_stats.ts";
import { createFleetTreeTool } from "./tools/get_fleet_tree.ts";
import { createSessionEventsTool } from "./tools/get_session_events.ts";
import { createSessionFileActivityTool } from "./tools/get_session_file_activity.ts";
import { createActivityTool } from "./tools/activity.ts";
import { registerPanelResource } from "./panel-resource.ts";

/** 工具注册表：新工具在此追加（扩展缝） */
const tools: ToolDefinition[] = [
  getOverviewTool,
  createCurrentSessionUsageTool(),
  createCurrentSessionCompositionTool(),
  createSessionStatsTool(),
  createFleetTreeTool(),
  createSessionEventsTool(),
  createSessionFileActivityTool(),
  createActivityTool(),
];

function registerTools(server: McpServer, defs: ToolDefinition[]): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { readOnlyHint: true },
        _meta: { ui: { visibility: def.visibility } },
      },
      async (args) => def.execute(args as Record<string, unknown>),
    );
  }
}

/** 服务器装配与启动（供 __zcode-plugin-host 调用，也可自启动） */
export async function main(): Promise<void> {
  const server = new McpServer({ name: PLUGIN_NAME, version: PLUGIN_VERSION });
  registerTools(server, tools);
  registerPanelResource(server);
  await server.connect(new StdioServerTransport());
}

// 直接运行（node dist/server.mjs）时自启动；被 __zcode-plugin-host import 时 argv[1] 指向 zcode.cjs，不自启动
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[zci] server 启动失败:", err);
    process.exit(1);
  });
}
