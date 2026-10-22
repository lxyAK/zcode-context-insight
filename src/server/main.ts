/**
 * MCP server 入口：stdio 传输，注册工具注册表与面板资源。
 * 构建为 dist/server.mjs（esbuild 自包含单文件，零运行时依赖）。
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { PLUGIN_NAME, PLUGIN_VERSION } from "./meta.ts";
import type { ToolDefinition } from "./registry.ts";
import { getOverviewTool } from "./tools/get_overview.ts";
import { registerPanelResource } from "./panel-resource.ts";

/** 工具注册表：新工具在此追加（扩展缝） */
const tools: ToolDefinition[] = [getOverviewTool];

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

async function main(): Promise<void> {
  const server = new McpServer({ name: PLUGIN_NAME, version: PLUGIN_VERSION });
  registerTools(server, tools);
  registerPanelResource(server);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[zci] server 启动失败:", err);
  process.exit(1);
});
