/**
 * 设置模型（T12）：三项设置的默认值、校验与 settings.json 读写。
 *
 * 存储位置：插件自身数据目录（宿主注入 ZCODE_PLUGIN_DATA，见 paths.ts）——
 * 属插件可写数据（区别于宿主 db/rollout 的严格只读红线），跨会话持久。
 *
 * 容错口径（工单约定）：任何字段缺失/未知枚举/文件损坏都回退该字段默认值，
 * 绝不抛错；面板与模型侧随时可用 sanitize 后的安全值。
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";

/** 默认视图（GLOSSARY 三视图：Insights / Context 仪表盘 / Fleet） */
export type DefaultView = "insights" | "context" | "fleet";
/** 趋势粒度（T4 逐请求趋势为基准口径；turn=按轮聚合、day=按天聚合） */
export type TrendGranularity = "request" | "turn" | "day";
/** 组成估算密度（T3 口径：粗略=仅四分组 / 均衡=默认 / 精细=细分子组） */
export type EstimationDensity = "coarse" | "balanced" | "detailed";

/** 设置形状（settings.json 的顶层三字段，一一对应） */
export interface Settings {
  defaultView: DefaultView;
  trendGranularity: TrendGranularity;
  estimationDensity: EstimationDensity;
}

/** 各字段合法枚举（校验真值来源；与 Settings 类型一同维护） */
const ENUMS: Record<keyof Settings, readonly string[]> = {
  defaultView: ["insights", "context", "fleet"],
  trendGranularity: ["request", "turn", "day"],
  estimationDensity: ["coarse", "balanced", "detailed"],
};

/** 默认设置（单一真值来源） */
export const DEFAULT_SETTINGS: Settings = {
  defaultView: "insights",
  trendGranularity: "request",
  estimationDensity: "balanced",
};

/** 字段级回退结果：非法/缺失字段的提示（面板展示"已回退默认"） */
export interface SanitizeResult {
  settings: Settings;
  warnings: string[];
}

/**
 * 校验并回退未知字段：每个字段非合法枚举字符串时取默认值并记 warning。
 * 输入可以是任意 JSON 解析产物（损坏文件、旧版本、手改产物），绝不抛错。
 */
export function sanitizeSettings(raw: unknown): SanitizeResult {
  const warnings: string[] = [];
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  // 初始取默认值拷贝：非法/缺失字段天然落在默认值上，合法字段才覆盖
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const assignable = settings as Record<keyof Settings, string>;
  for (const field of Object.keys(ENUMS) as Array<keyof Settings>) {
    const value = source[field];
    if (typeof value === "string" && ENUMS[field].includes(value)) {
      assignable[field] = value;
    } else if (value !== undefined) {
      warnings.push(
        `${field}: 未知值 ${JSON.stringify(value)}，已回退默认 ${DEFAULT_SETTINGS[field]}`,
      );
    }
  }
  return { settings, warnings };
}

/** 读取并校验 settings.json；缺文件/损坏一律返回默认值（含 warnings） */
export function readSettings(path: string): SanitizeResult {
  if (!path) {
    return { settings: { ...DEFAULT_SETTINGS }, warnings: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, warnings: [] }; // 尚未写过设置
  }
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warnings: ["settings.json 损坏（非法 JSON），已回退全部默认值"],
    };
  }
}

/** 原子写 settings.json（tmp + rename，避免面板读到半截文件）；失败向上抛由调用方降级 */
export function writeSettings(path: string, settings: Settings): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
