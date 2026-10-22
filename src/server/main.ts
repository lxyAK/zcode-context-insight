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
import { createGetSettingsTool } from "./tools/get_settings.ts";
import { createSetSettingsTool } from "./tools/set_settings.ts";
import { createGetDataVersionTool } from "./tools/get_data_version.ts";
import { resolveDbPath, resolveRolloutDir } from "./paths.ts";
import { createDataVersionWatcher } from "./watcher.ts";
import { registerPanelResource } from "./panel-resource.ts";

/** 数据版本监视器：fs.watch 双数据源（db.sqlite 目录 + rollout 目录），面板轮询比对自动刷新 */
const dataWatcher = createDataVersionWatcher({
  dbPath: resolveDbPath(),
  rolloutDir: resolveRolloutDir(),
});

/** 工具注册表：新工具在此追加（扩展缝） */
const tools: ToolDefinition[] = [
  getOverviewTool,
  createCurrentSessionUsageTool(),
  createGetSettingsTool(),
  createSetSettingsTool(),
  createGetDataVersionTool({ watcher: dataWatcher }),
];

function registerTools(server: McpServer, defs: ToolDefinition[]): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { readOnlyHint: def.readOnlyHint !== false },
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
  dataWatcher.start(); // 源缺失时内部容错（watching=false），不影响 server 启动
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
