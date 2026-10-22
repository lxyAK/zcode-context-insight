/**
 * 工具 get_settings（T12，面板专用 app 可见）：读取插件设置。
 * 设置存 server 侧插件数据目录 settings.json（跨会话持久）；
 * 面板 stateKey 只存窗口布局类状态，不存设置（划分见工单 T12 / 笔记 02 §3）。
 * 缺文件/损坏/未知枚举一律容错回退默认值（sanitizeSettings）。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveSettingsPath } from "../paths.ts";
import { DEFAULT_SETTINGS, readSettings } from "../settings.ts";

/** 工具依赖（测试注入缝；缺省从环境变量与插件数据目录解析） */
export interface GetSettingsDeps {
  settingsPath?: string;
}

/**
 * 设置读取工具工厂。
 * @param deps 依赖注入（测试/调试；缺省从环境与宿主默认路径解析）
 * @return 工具定义（main.ts 注册到 MCP server）
 */
export function createGetSettingsTool(deps: GetSettingsDeps = {}): ToolDefinition {
  return {
    name: "get_settings",
    title: "读取设置",
    description:
      "读取 Context Insight 插件设置（默认视图 defaultView：insights/context/fleet；" +
      "趋势粒度 trendGranularity：request/turn/day；估算密度 estimationDensity：coarse/balanced/detailed）。" +
      "设置跨会话持久于插件数据目录 settings.json；文件缺失、损坏或含未知枚举时容错回退默认值。",
    inputSchema: z.object({}),
    visibility: ["app"],
    execute: async () => {
      const path = deps.settingsPath ?? resolveSettingsPath();
      if (!path) {
        const payload = {
          available: false,
          reason: "no-plugin-data-dir",
          settings: null,
          defaults: DEFAULT_SETTINGS,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
      let result;
      try {
        result = readSettings(path);
      } catch (err) {
        const payload = {
          available: false,
          reason: `read-failed: ${err instanceof Error ? err.message : String(err)}`,
          settings: null,
          defaults: DEFAULT_SETTINGS,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
      const payload = {
        available: true,
        settings: result.settings,
        defaults: DEFAULT_SETTINGS,
        warnings: result.warnings,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}
