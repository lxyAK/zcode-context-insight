/**
 * 构建脚本：
 *  - dist/server.mjs：esbuild 打包 src/server/main.ts（platform=node，format=esm，自包含单文件）
 *  - dist/ui/panel.html：esbuild 打包 src/panel/entry.ts（IIFE）+ panel.css 后整体内联进模板，
 *    产物单文件、资产零外链（沙箱 CSP 默认禁网）
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(repoRoot, "dist");

/** 清理并重建 dist */
async function cleanDist() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(join(distDir, "ui"), { recursive: true });
}

/** 打包 MCP server 为自包含单文件（零运行时依赖） */
async function buildServer() {
  await build({
    entryPoints: [join(repoRoot, "src/server/main.ts")],
    outfile: join(distDir, "server.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    legalComments: "none",
    // 无 external：SDK/zod 全部内联
  });
}

/** 打包面板为 IIFE 产物（中间文件，稍后内联进 panel.html） */
async function bundlePanel() {
  const outdir = join(distDir, "ui");
  await build({
    entryPoints: [join(repoRoot, "src/panel/entry.ts")],
    outdir,
    outExtension: { ".js": ".bundle.js", ".css": ".bundle.css" },
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    sourcemap: false,
    legalComments: "none",
    minify: true,
  });
  // esbuild 会把 import 的 CSS 提取为同名 .css
  const js = await readFile(join(outdir, "entry.bundle.js"), "utf8");
  let css = "";
  try {
    css = await readFile(join(outdir, "entry.bundle.css"), "utf8");
  } catch {
    /* 无 CSS 产物时忽略 */
  }
  await rm(join(outdir, "entry.bundle.js"), { force: true });
  await rm(join(outdir, "entry.bundle.css"), { force: true });
  return { js, css };
}

/** JS/CSS 内联进模板，生成自包含 panel.html */
async function buildPanel() {
  const { js, css } = await bundlePanel();
  const template = await readFile(join(repoRoot, "src/panel/template.html"), "utf8");
  // 防止 JS 文本中出现 </script> 提前闭合标签
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  // 替换串必须走函数形式：字符串形式会把 $&、$` 等解释为特殊模式。
  // 0.1.1–0.1.4 事故：uPlot 压缩产物中变量 $ 的 && 连写构成 $&，被替换成占位符
  // <!--ZCI_JS--> 注入产物，<!-- 在经典脚本中开启 HTML 注释吞掉单行脚本其余部分，
  // 面板静默死亡、宿主 ui/initialize 握手超时（回归测试：test/panel.artifact.test.mjs）
  const html = template
    .replace("<!--ZCI_CSS-->", () => `<style>\n${css}\n</style>`)
    .replace("<!--ZCI_JS-->", () => `<script>\n${safeJs}\n</script>`);
  await writeFile(join(distDir, "ui", "panel.html"), html, "utf8");
}

await cleanDist();
await buildServer();
await buildPanel();
console.log("build 完成: dist/server.mjs + dist/ui/panel.html");
