/**
 * 面板设置卡片（T12）：渲染三项设置（默认视图/趋势粒度/估算密度）并提供修改。
 *
 * 持久化边界（对照笔记 02 §3 与工单 T12）：
 *  - 设置的持久层是 server 侧插件数据目录 settings.json（经 get/set_settings 工具读写，
 *    跨会话生效），本视图绝不写 localStorage/stateKey——stateKey 仅存窗口布局类状态；
 *  - 修改即调 set_settings（仅提交变更字段），生效值（服务端可能回退非法值）反映回 UI，
 *    warnings 展示回退提示。
 */
import { t, type MessageKey } from "../i18n.ts";
import type { BridgeClient } from "../bridge.ts";
import { el } from "./dom.ts";

/** 设置三字段形状（与 server settings.ts 的 Settings 对应；面板侧宽松字符串即可） */
export interface PanelSettings {
  defaultView: string;
  trendGranularity: string;
  estimationDensity: string;
}

/** get_settings 应答载荷（structuredContent 形状） */
export interface SettingsPayload {
  available: boolean;
  reason?: string;
  settings?: PanelSettings | null;
  defaults?: PanelSettings;
  warnings?: string[];
}

/** 单个设置字段的可选项清单（枚举真值与 server settings.ts ENUMS 对应） */
const FIELDS: Array<{
  key: keyof PanelSettings;
  labelKey: MessageKey;
  /** 该设置的实际效果说明（review 修复：设置已接线为消费方行为，文案如实说明） */
  hintKey: MessageKey;
  options: Array<{ value: string; labelKey: MessageKey }>;
}> = [
  {
    key: "defaultView",
    labelKey: "settingsFieldDefaultView",
    hintKey: "settingsHintDefaultView",
    options: [
      { value: "insights", labelKey: "optionViewInsights" },
      { value: "context", labelKey: "optionViewContext" },
      { value: "fleet", labelKey: "optionViewFleet" },
    ],
  },
  {
    key: "trendGranularity",
    labelKey: "settingsFieldTrendGranularity",
    hintKey: "settingsHintTrendGranularity",
    options: [
      { value: "request", labelKey: "optionGranularityRequest" },
      { value: "turn", labelKey: "optionGranularityTurn" },
      { value: "day", labelKey: "optionGranularityDay" },
    ],
  },
  {
    key: "estimationDensity",
    labelKey: "settingsFieldEstimationDensity",
    hintKey: "settingsHintEstimationDensity",
    options: [
      { value: "coarse", labelKey: "optionDensityCoarse" },
      { value: "balanced", labelKey: "optionDensityBalanced" },
      { value: "detailed", labelKey: "optionDensityDetailed" },
    ],
  },
];

/**
 * 渲染设置卡片：三个 select + 状态行。
 * 不可用（available=false/载荷缺失）时渲染降级提示，返回的 section 仍可安全挂载。
 */
export function renderSettingsSection(
  doc: Document,
  bridge: BridgeClient,
  payload: SettingsPayload | null,
): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "h2", "zci-subtitle", t("settingsTitle")));

  if (!payload?.available || !payload.settings) {
    section.append(el(doc, "p", "zci-status", t("settingsUnavailable")));
    return section;
  }

  const settings: PanelSettings = payload.settings;
  const status = el(doc, "p", "zci-settings-status", "");
  const selects = new Map<keyof PanelSettings, HTMLSelectElement>();

  for (const field of FIELDS) {
    const row = el(doc, "div", "zci-kv");
    row.append(el(doc, "span", "zci-kv-label", t(field.labelKey)));

    const select = doc.createElement("select");
    select.className = "zci-select";
    select.dataset.field = field.key;
    for (const opt of field.options) {
      const option = doc.createElement("option");
      option.value = opt.value;
      option.textContent = t(opt.labelKey);
      select.append(option);
    }
    select.value = settings[field.key];
    select.addEventListener("change", () => {
      void applySetting(bridge, field.key, select.value, selects, status);
    });
    selects.set(field.key, select);
    row.append(select);
    // 效果说明随行展示（行后独立段落，避免挤入 label+select 的 flex 行）
    section.append(row, el(doc, "p", "zci-settings-hint", t(field.hintKey)));
  }

  section.append(status);
  return section;
}

/** 提交单字段变更：生效值反映回全部 select，warnings/失败写入状态行 */
async function applySetting(
  bridge: BridgeClient,
  field: keyof PanelSettings,
  value: string,
  selects: Map<keyof PanelSettings, HTMLSelectElement>,
  status: HTMLElement,
): Promise<void> {
  const payload = await bridge.callToolJson<{
    available: boolean;
    settings?: PanelSettings | null;
    warnings?: string[];
  }>("set_settings", { [field]: value });

  if (!payload?.available || !payload.settings) {
    status.textContent = t("settingsSaveFailed", {
      message: payload ? (payload as { reason?: string }).reason ?? "unknown" : "bridge-error",
    });
    return;
  }
  // 生效值（服务端可能已把非法值回退默认）同步回 UI，防止停留在未生效选择上
  for (const [key, select] of selects) {
    select.value = payload.settings![key];
  }
  status.textContent =
    payload.warnings && payload.warnings.length > 0
      ? payload.warnings.join("；")
      : t("settingsSaved");
}
