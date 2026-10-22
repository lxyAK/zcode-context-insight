# 05 dev 回路与工具链（本机实测：Windows + ZCode 3.16.2 + Node v22.21.1 + Git Bash）

## 1. zcode CLI 与插件管理命令

CLI 真实入口（`ZCode.exe` 是 GUI，不要直接跑它当 CLI；官方插件的 MCP server 就是用下面这组合启动的）：

```bash
ELECTRON_RUN_AS_NODE=1 "C:/Program Files/ZCode/ZCode.exe" "C:/Program Files/ZCode/resources/glm/zcode.cjs" <command>
```

CLI 版本 0.17.0（随 3.16.2 桌面版分发）。插件相关完整命令（`plugins --help` 实测输出）：

```
list [--json] [--available]                  列已装插件；--available 连市场目录一起列
install <plugin>[@marketplace] [-s <scope>]  从已知市场安装
uninstall <plugin> [-s <scope>] [--keep-data] [--force]   卸载（--keep-data 保留数据目录）
enable <plugin> [-s <scope>] / disable [plugin] [-a|--all] [-s <scope>]
update <plugin> [-s <scope>]
validate <path>                              校验插件或市场 manifest（本地开发核心工具）
marketplace add <source> [--scope <scope>] [--sparse <path>]   从 URL/本地路径/GitHub 仓库加市场
marketplace list [--json] / marketplace remove <name>
```

实测：

```bash
$ ... zcode.cjs plugins validate "C:/Users/86176/.zcode/cli/plugins/cache/zcode-plugins-official/pdf/0.2.1"
Plugin manifest is valid: C:/Users/86176/.zcode/cli/plugins/cache/.../pdf/0.2.1

$ ... zcode.cjs plugins list
Plugins (17)
- pdf@zcode-plugins-official [enabled]
  ... skills: 2, commands: 0, hooks: 0, mcp: plugin:pdf:pdf
```

注意 `plugins list` 直接显示每个插件的 skills/commands/hooks/mcp 计数——**dev 回路的冒烟检查点**（改完 manifest 重启后跑它，四类组件计数符合预期才算装载成功）。

其他有用命令：`doctor`（运行时/打包假设体检）、`commands list`、`skills list`、`mcp` 斜杠命令（会话内 `/mcp list|status|connect|disconnect`）。

## 2. 本地安装回路（marketplace 机制）

市场存储：
- `C:\Users\86176\.zcode\cli\plugins\known_marketplaces.json`：已添加市场清单。
- `C:\Users\86176\.zcode\cli\plugins\marketplaces\<marketplace-id>\marketplace.json`：市场清单（缓存/解析态）。
- `C:\Users\86176\.zcode\cli\plugins\installed_plugins.json`：安装记录（id=`<name>@<marketplace>`、installPath、scope、source）。
- 插件本体安装进 `C:\Users\86176\.zcode\cli\plugins\cache\<marketplace>\<name>\<version>\`；每个插件数据目录 `C:\Users\86176\.zcode\cli\plugins\data\<name>@<marketplace>\`（自动创建，实测存在且初始为空——心跳文件目标位置）。
- 启停状态存 `C:\Users\86176\.zcode\cli\config.json` 的 `plugins.enabledPlugins` 映射（实测样例：`"pdf@zcode-plugins-official": true`）。

**作者侧 marketplace.json 格式**（zcode-guide diagnosing-plugins §2 原文，权威）：`{ name, plugins[], pluginRoot?, allowCrossMarketplaceDependenciesOn? }`；每个 `plugins[].source` 可以是**相对路径字符串**，或 `{kind: "directory"|"github"|"git"|"url"|"git-subdir", ...}` 对象；**不支持 npm/pip source**。

本地 dev 回路（推荐做法，一段命令）：

```bash
# 1) 仓库里准备 market/zci-local/marketplace.json（内容见下）+ 插件本体 market/zcode-context-insight/
# 2) 校验
ELECTRON_RUN_AS_NODE=1 "C:/Program Files/ZCode/ZCode.exe" "C:/Program Files/ZCode/resources/glm/zcode.cjs" \
  plugins validate "D:/.opensource/zcode-context-insight/market/zci-local/marketplace.json"
# 3) 添加本地市场 + 安装
... plugins marketplace add "D:/.opensource/zcode-context-insight/market/zci-local"
... plugins install zcode-context-insight@zci-local
# 4) 重启 ZCode 桌面应用（插件 MCP/hooks/面板装载依赖重启；hook 配置不热加载）
# 5) 冒烟
... plugins list   # 看 zcode-context-insight 行的 skills/commands/hooks/mcp 计数
```

本地 marketplace.json 草案（source 用相对路径字符串形式；displayName_i18n/icon 等字段对照官方条目）：

```json
{
  "name": "zci-local",
  "plugins": [
    {
      "name": "zcode-context-insight",
      "source": "../zcode-context-insight",
      "version": "0.1.0",
      "description": "ZCode 的上下文与 token 可视化插件",
      "displayName": "Context Insight",
      "displayName_i18n": { "zh-CN": "上下文洞察" },
      "description_i18n": { "zh-CN": "跨会话总览、会话内上下文仪表盘、代理网络与 /context 命令。" }
    }
  ]
}
```

**待验证**（无法在不写 `~/.zcode` 的约束下替实现代理试跑）：
- `source` 相对路径字符串是否需相对 marketplace.json 所在目录（文档措辞是"relative path"，倾向于是）；不行就换 `{ "kind": "directory", "path": "..." }`——字段名待验证。
- 本地 directory 市场安装后，`cache\<marketplace>\...` 是复制还是链接（决定改代码后是否要 `update`/重装；version 号递增可强制刷新，diagnosing-plugins 坑 9 提示 Git/URL 插件按版本/commit 检测更新）。
- 日常迭代最小回路：如需频繁改 server 代码，可临时在 `~/.zcode/cli/config.json` 的 `mcp.servers` 挂一个指向 dist 产出的 stdio server（配置文件级 MCP 不展开模板，用绝对路径）单独调试 server，面板装载再走插件路径。

## 3. 日志与调试

- 宿主日志目录：`C:\Users\86176\.zcode\cli\log\`（hook 执行记录 fired/timed out/blocked、MCP stdio 错误流都写这里——diagnosing-hooks §3、diagnosing-mcp §4）。
- 面板 `console.debug/log` 由宿主转发（pdf 面板大量依赖此调试）。
- MCP stdio server 的 stderr 被捕获进宿主日志；直接在终端跑 `node dist/server.mjs` 可看原始错误。

## 4. 构建工具链

本机环境：Node v22.21.1（内置 `node:sqlite`，experimental 但 DatabaseSync 可用，读 db 就用它，**不需要 better-sqlite3**）、npm 10.9.4、registry 已配 `https://registry.npmmirror.com`（npx 直装无障碍）。esbuild/vitest 按任务约定未实际安装，`npx esbuild`/`npx vitest` 首次会自动拉取（官方 browser-use 的 devDeps 就是 `esbuild ^0.25.0` + `vitest ^4.1.5`，版本可用性参照）。

MCP server 依赖选择：官方 server 用 `@modelcontextprotocol/server 2.0.0`（browser-use devDeps 实测）+ zod 4.x；面板侧打包 `@modelcontextprotocol/client` 2.x（含 Apps/UI 扩展，见 02 笔记 §8 待验证项）。

### 建议构建脚本形态（TS 源 → 自包含产物）

```
repo/
  src/server/*.ts          # MCP server（node:sqlite 只读、rollout 解析、心跳读取、组成估算）
  src/panel/*.ts + *.css   # 面板（调 callServerTool，uPlot 打包进来）
  scripts/build.mjs        # esbuild 驱动（官方 browser-use scripts/build.mjs 同思路）
  dist/
    server.mjs             # esbuild --bundle --platform=node --format=esm --outfile=dist/server.mjs
                           #   external: 无（自包含单文件）；banner 加 import.meta.url 兼容（ESM）
    ui/panel.html          # esbuild 打包 panel.ts → JS 文本 + css → 注入 HTML 模板的 <script>/<style>
    ui/assets.json         # 仅当选择懒加载模式才需要（02 笔记 §5 方案 B）
```

package.json scripts 骨架（照抄官方惯例：build/typecheck/test）：

```json
{
  "name": "zcode-context-insight",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run test"
  },
  "dependencies": { "@modelcontextprotocol/server": "2.0.0", "zod": "^4.6.5" },
  "devDependencies": { "esbuild": "^0.25.0", "typescript": "^5.9.0", "vitest": "^4.1.5",
                       "@modelcontextprotocol/client": "2.0.0", "uplot": "^1.6.x" }
}
```

构建要点：
- server.mjs 必须零依赖运行（宿主用 `ZCode.exe + zcode.cjs __zcode-plugin-host <path>` 起，环境只有 Node 内置模块 + 我们 bundle 进去的一切；**不能 require 第三方包**）。
- 面板 HTML 内联一切（02 笔记方案 A）：esbuild 先 `--bundle --format=iife` 出 panel.js 与 panel.css，build.mjs 读文本嵌进 panel.html 模板——产物单文件、无需 assets 通道。
- Windows 路径注意：plugin.json 里 JSON 转义 `\\`；hook 的 process command 用正斜杠路径在 Git Bash/Node 下均可用。
- 测试（vitest）：db 只读层用 fixture sqlite（构造小库或从真实库 COPY 出脱敏子集）；rollout 解析用脱敏 JSONL fixture（03 笔记的结构样例可直接当 fixture 模板）；心跳文件读写用 tmp 目录。

## 5. dev 回路验收清单（T1 完成定义）

1. `npm run build` 产出 dist/server.mjs + dist/ui/panel.html；`npm test` 绿。
2. `zcode plugins validate <插件目录>` 通过。
3. `plugins marketplace add` + `install` + 重启后 `plugins list` 显示 `skills/commands/hooks/mcp` 四项计数正确。
4. 会话内 `/mcp list` 显示 `plugin:zcode-context-insight:*` 已连接；模型可见 `mcp__plugin_zcode-context-insight_*__*` 工具。
5. 提交一条用户消息后，插件数据目录出现心跳文件（hook 生效）；server 工具能读到当前会话 ID。
6. 面板能打开（模型调用 open 类工具或 UI 入口），完成 ui/initialize 握手并 callServerTool 拿到数据。
