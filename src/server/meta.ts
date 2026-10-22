/**
 * 插件元信息：单一真值来源是仓库根 package.json（构建时被 esbuild 内联进产物）。
 */
import pkg from "../../package.json";

export const PLUGIN_NAME = pkg.name; // "zcode-context-insight"
export const PLUGIN_VERSION = pkg.version;

/** MCP server 名（manifest mcpServers 键名，需与 plugin.json 保持一致） */
export const SERVER_NAME = "zci";

/** 面板资源 URI（必须与 plugin.json ui.surfaces[].resourceUri 完全一致） */
export const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`;

/** 面板 HTML 的 MIME（宿主据此按 MCP App 面板加载） */
export const PANEL_MIME = "text/html;profile=mcp-app";
