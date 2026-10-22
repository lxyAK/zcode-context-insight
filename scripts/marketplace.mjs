/**
 * 本地市场清单生成（dev 回路）。
 * 实测结论（2026-10-22，ZCode 3.16.2）：
 *  - source 必须用对象形式 { source: "directory", path: <绝对原生路径> }；
 *    相对路径与正斜杠绝对路径均解析失败（plugin_manifest_not_found / directory does not exist）。
 *  - 因此 market/zci-local/marketplace.json 是机器相关的生成物（gitignore），由 dev 脚本重建。
 */
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * 插件图标（内嵌 SVG，零外链）：读取 assets/icon.svg 编码为 data URI。
 * 官方市场条目的 icon 是 URL 字符串（通常指向 CDN）；本插件承诺零外部网络，
 * 故用 data URI 自包含（面板沙箱 CSP 禁网，市场图标同理不依赖外链）。
 */
export function pluginIconDataUri(repoRoot) {
  const svg = readFileSync(join(repoRoot, "assets", "icon.svg"), "utf8").trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 生成 zci-local 市场清单对象；repoRoot 为插件根（仓库根）绝对路径 */
export function marketplaceManifest(repoRoot, pkg) {
  const nativePath = repoRoot.split("/").join(sep);
  return {
    name: "zci-local",
    plugins: [
      {
        name: pkg.name,
        source: { source: "directory", path: nativePath },
        version: pkg.version,
        description: "ZCode 的上下文与 token 可视化插件",
        displayName: "Context Insight",
        displayName_i18n: { "zh-CN": "上下文洞察", en: "Context Insight" },
        description_i18n: {
          "zh-CN": "跨会话总览、会话内上下文仪表盘、代理网络与 /context 命令。",
          en: "Cross-session Insights, in-session Context dashboard, agent Fleet and /context command.",
        },
        icon: pluginIconDataUri(repoRoot),
      },
    ],
  };
}

/** 市场清单落盘路径 */
export function marketplaceJsonPath(repoRoot) {
  return join(repoRoot, "market", "zci-local", "marketplace.json");
}
