/**
 * 面板资源注册：宿主经 resources/read 取 ui://zcode-context-insight/panel.html，
 * 在沙箱 webview 中加载。panel.html 与 server.mjs 同属 dist/ 产物，按产物内相对路径定位。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { PANEL_MIME, PANEL_URI } from "./meta.ts";

/**
 * 从构建产物位置（dist/server.mjs）解析 dist/ui/panel.html
 * @param serverModuleUrl server 模块 URL（import.meta.url）
 * @return 面板 HTML 的文件绝对路径
 */
export function resolvePanelHtmlPath(serverModuleUrl: string): string {
  return join(dirname(fileURLToPath(serverModuleUrl)), "ui", "panel.html");
}

/**
 * 注册面板 HTML 资源（宿主经 ui://zcode-context-insight/panel.html 加载）。
 * @param server MCP server 实例
 * @return void（副作用：注册资源读取处理器）
 */
export function registerPanelResource(server: McpServer): void {
  server.registerResource(
    "panel",
    PANEL_URI,
    { mimeType: PANEL_MIME },
    async (uri) => {
      const html = await readFile(resolvePanelHtmlPath(import.meta.url), "utf8");
      return {
        contents: [{ uri: uri.href, mimeType: PANEL_MIME, text: html }],
      };
    },
  );
}
