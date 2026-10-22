/**
 * dev 一键回路：升版本（patch）→ 构建 → 重建本地市场清单。
 * 用法：npm run dev
 * 之后手动（首次或需要刷新安装时）：
 *   zcode plugins marketplace add <repo>/market/zci-local
 *   zcode plugins install zcode-context-insight@zci-local   # 或 update
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marketplaceManifest, marketplaceJsonPath } from "./marketplace.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** patch 版本号提升：0.1.0 → 0.1.1 */
export function bumpPatch(version) {
  const parts = version.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`版本号不符合 semver 三段格式: ${version}`);
  }
  parts[2] = String(Number(parts[2]) + 1);
  return parts.join(".");
}

async function main() {
  // 1) 升版本：package.json 与 .zcode-plugin/plugin.json 同步提升
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const nextVersion = bumpPatch(pkg.version);
  pkg.version = nextVersion;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const manifestPath = join(repoRoot, ".zcode-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = nextVersion;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`版本提升: ${pkg.version}（package.json 与 plugin.json 已同步）`);

  // 2) 构建（先升版本再构建，产物内联的版本号为新版本）
  await import("./build.mjs");

  // 3) 重建本地市场清单
  const marketPath = marketplaceJsonPath(repoRoot);
  await mkdir(dirname(marketPath), { recursive: true });
  await writeFile(marketPath, JSON.stringify(marketplaceManifest(repoRoot, pkg), null, 2) + "\n", "utf8");
  console.log(`本地市场清单已同步: ${marketPath}`);

  console.log(
    [
      "",
      "下一步（首次安装或刷新）：",
      `  plugins marketplace add "${join(repoRoot, "market", "zci-local")}"`,
      `  plugins install zcode-context-insight@zci-local   # 已装过则 plugins update`,
      "  安装/更新后需重启 ZCode 桌面应用生效（MCP/面板不热加载）",
    ].join("\n"),
  );
}

await main();
