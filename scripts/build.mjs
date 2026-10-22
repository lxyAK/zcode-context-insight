/**
 * 构建脚本：
 *  - dist/server.mjs：esbuild 打包 src/server/main.ts（platform=node，format=esm，自包含单文件）
 *  - dist/ui/panel.html：面板入口（自包含，JS/CSS 全内联）
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

/** 生成面板 HTML（切片 B 将替换为 esbuild 打包内联注入） */
async function buildPanel() {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body><div id="root">Loading…</div></body>
</html>
`;
  await writeFile(join(distDir, "ui", "panel.html"), html, "utf8");
}

await cleanDist();
await buildServer();
await buildPanel();
console.log("build 完成: dist/server.mjs + dist/ui/panel.html");
