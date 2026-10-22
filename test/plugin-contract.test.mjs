/**
 * 插件契约测试：manifest / 本地市场清单 / 构建产物的静态契约。
 * 这些文件是宿主装载插件的真实输入，契约漂移（版本不同步、resourceUri 不一致、
 * 面板出现外链资源）都会导致面板白屏或加载失败，此处静态断言兜底。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marketplaceManifest, marketplaceJsonPath } from "../scripts/marketplace.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (p) => JSON.parse(readFileSync(join(repoRoot, p), "utf8"));
const pkg = readJson("package.json");

describe("插件 manifest（.zcode-plugin/plugin.json）", () => {
  const manifest = readJson(".zcode-plugin/plugin.json");

  it("name 符合插件名正则且与 package.json 一致", () => {
    expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
    expect(manifest.name).toBe(pkg.name);
  });

  it("version 与 package.json 同步", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("mcpServers.zci 声明 stdio server 并指向产物 dist/server.mjs", () => {
    const server = manifest.mcpServers?.zci;
    expect(server, "mcpServers.zci 必须存在").toBeTruthy();
    expect([server.type].filter(Boolean)).toEqual(["stdio"]);
    expect(typeof server.command).toBe("string");
    expect(server.command.length).toBeGreaterThan(0);
    expect(server.args).toContain("${ZCODE_PLUGIN_ROOT}/dist/server.mjs");
    expect(server.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("ui.surfaces 面板声明与 server/resourceUri/availability 契约一致", () => {
    const surfaces = manifest.ui?.surfaces ?? [];
    expect(surfaces).toHaveLength(1);
    const surface = surfaces[0];
    expect(surface.id).toBeTruthy();
    expect(surface.title?.["zh-CN"]).toBeTruthy();
    expect(surface.title?.["en-US"]).toBeTruthy();
    expect(surface.icon).toMatch(/^[a-z0-9-]+$/); // lucide 图标名
    expect(surface.server).toBe("zci"); // 指向 mcpServers 键
    expect(surface.resourceUri).toBe(`ui://${pkg.name}/panel.html`); // 与 server 注册的 PANEL_URI 一致
    expect(surface.availability).toBe("session");
  });
});

/** 解码市场条目的内嵌 SVG 图标（data:image/svg+xml,<percent-encoded>） */
function decodeSvgDataUri(uri) {
  const prefix = "data:image/svg+xml,";
  expect(uri, "icon 必须是 SVG data URI").toMatch(/^data:image\/svg\+xml,/);
  return decodeURIComponent(uri.slice(prefix.length));
}

describe("T14 打磨：i18n 骨架与图标", () => {
  it("plugin.json description_i18n 含 zh-CN 与 en 双语，zh-CN 与 description 一致", () => {
    const manifest = readJson(".zcode-plugin/plugin.json");
    expect(manifest.description_i18n?.["zh-CN"]).toBeTruthy();
    expect(manifest.description_i18n?.en).toBeTruthy();
    expect(typeof manifest.description_i18n.en).toBe("string");
    expect(manifest.description).toBe(manifest.description_i18n["zh-CN"]);
  });

  it("assets/icon.svg 存在且零外链（无 http(s) 引用、无脚本）", () => {
    const svg = readFileSync(join(repoRoot, "assets/icon.svg"), "utf8");
    expect(svg).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/); // 命名空间是标准声明，非外链资源
    expect(svg).toMatch(/viewBox=/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // 不引用任何网络资源
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<image/i); // 不嵌位图/外链图
  });

  it("市场条目 icon 为内嵌 SVG data URI，且与 assets/icon.svg 内容一致", () => {
    const market = marketplaceManifest(repoRoot, pkg);
    const entry = market.plugins[0];
    const svgAsset = readFileSync(join(repoRoot, "assets/icon.svg"), "utf8").trim();
    expect(entry.icon).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeSvgDataUri(entry.icon)).toBe(svgAsset);
  });

  it("面板产物 html lang=zh-CN 且初始占位文案为中文（zh-CN 走查）", () => {
    const html = readFileSync(join(repoRoot, "dist/ui/panel.html"), "utf8");
    expect(html).toMatch(/<html lang="zh-CN">/);
    expect(html).not.toContain("Loading"); // 初始占位不得残留英文
    // 中文优先字体回退（Windows system-ui 不含中文字形；压缩器可能去引号，按名称断言）
    expect(html).toMatch(/PingFang SC/);
    expect(html).toMatch(/Microsoft YaHei/);
  });
});

describe("本地市场清单生成（market/zci-local，dev 脚本生成物）", () => {
  it("生成条目：名称/版本与 package.json 同步，source 为原生绝对路径目录源", () => {
    const market = marketplaceManifest(repoRoot, pkg);
    const entry = market.plugins[0];
    expect(market.name).toBe("zci-local");
    expect(market.plugins).toHaveLength(1);
    expect(entry.name).toBe(pkg.name);
    expect(entry.version).toBe(pkg.version);
    // 实测契约：相对路径与正斜杠绝对路径均不被宿主接受，必须是原生分隔符绝对路径
    expect(entry.source).toEqual({ source: "directory", path: expect.any(String) });
    expect(entry.source.path).not.toMatch(/\//); // Windows 宿主下为反斜杠路径
  });

  it("source.path 解析到含有效 plugin.json 的插件根", () => {
    const market = marketplaceManifest(repoRoot, pkg);
    const pluginRoot = market.plugins[0].source.path;
    expect(existsSync(join(pluginRoot, ".zcode-plugin/plugin.json")), `应解析到插件根: ${pluginRoot}`).toBe(true);
  });

  it("已生成清单（若存在）与当前版本同步（防止忘记 npm run dev）", () => {
    const marketPath = marketplaceJsonPath(repoRoot);
    if (!existsSync(marketPath)) return; // 生成物未构建（如全新克隆），跳过
    const onDisk = JSON.parse(readFileSync(marketPath, "utf8"));
    expect(onDisk.plugins[0].version).toBe(pkg.version);
    expect(onDisk.plugins[0].name).toBe(pkg.name);
  });
});

describe("构建产物冒烟（dist/）", () => {
  it("dist/server.mjs 存在且非空", () => {
    const p = join(repoRoot, "dist/server.mjs");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8").length).toBeGreaterThan(1000);
  });

  it("panel.html 自包含：内联脚本与样式，零外链（沙箱 CSP 禁网）", () => {
    const html = readFileSync(join(repoRoot, "dist/ui/panel.html"), "utf8");
    expect(html).toContain('id="root"');
    expect(html).toMatch(/<script>[\s\S]+<\/script>/); // 内联 JS
    expect(html).toMatch(/<style>[\s\S]+<\/style>/); // 内联 CSS
    // 零外链断言
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<img[^>]+src=/i);
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?https?:\/\//i);
    expect(html).not.toMatch(/@import/i);
  });

  it("dist/ui 目录只保留 panel.html（无中间产物）", () => {
    expect(readdirSync(join(repoRoot, "dist/ui"))).toEqual(["panel.html"]);
  });
});
