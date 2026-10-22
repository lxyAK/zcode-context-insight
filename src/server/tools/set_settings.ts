/**
 * 工具 set_settings（T12，面板专用 app 可见，写操作）：更新插件设置并持久化。
 *
 * 语义（工单约定）：
 *  - 增量合并：只更新提交的字段，未提交字段保持原值；
 *  - 非法值容错：未知枚举不报错，该字段回退默认值并在 warnings 提示；
 *  - 持久化：原子写插件数据目录 settings.json（跨会话生效），失败降级 available=false。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveSettingsPath } from "../paths.ts";
import { DEFAULT_SETTINGS, readSettings, sanitizeSettings, writeSettings } from "../settings.ts";

/** 工具依赖（测试注入缝） */
export interface SetSettingsDeps {
  settingsPath?: string;
}

/** 输入 schema：三字段全可选、宽松字符串（非法枚举在执行层容错回退，不经 schema 拒绝） */
const inputSchema = z.object({
  defaultView: z.string().optional(),
  trendGranularity: z.string().optional(),
  estimationDensity: z.string().optional(),
});

export function createSetSettingsTool(deps: SetSettingsDeps = {}): ToolDefinition {
  return {
    name: "set_settings",
    title: "更新设置",
    description:
      "更新 Context Insight 插件设置（增量合并：defaultView/trendGranularity/estimationDensity，" +
      "合法枚举见 get_settings）。写入插件数据目录 settings.json，跨会话生效；" +
      "未知枚举不报错，该字段回退默认值并在 warnings 中提示。",
    inputSchema,
    visibility: ["app"],
    readOnlyHint: false,
    execute: async (args) => {
      const path = deps.settingsPath ?? resolveSettingsPath();
      if (!path) {
        const payload = {
          available: false,
          reason: "no-plugin-data-dir",
          settings: null,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
      try {
        const current = readSettings(path).settings; // 当前值（含缺文件→默认）
        const { settings, warnings } = sanitizeSettings({ ...current, ...args });
        writeSettings(path, settings);
        const payload = { available: true, settings, warnings };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (err) {
        const payload = {
          available: false,
          reason: `write-failed: ${err instanceof Error ? err.message : String(err)}`,
          settings: null,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
    },
  };
}
