# 01 ZCode 插件格式（实测于 ZCode 3.16.2 / Windows）

调查时间：2026-10-22。所有示例均摘自本机已安装官方插件，路径为绝对路径，可直接对照阅读。
参考样板插件（同时具备 MCP server + 面板 + 技能，最接近本项目形态）：
**pdf 0.2.1**（`C:\Users\86176\.zcode\cli\plugins\cache\zcode-plugins-official\pdf\0.2.1\`），
同构的还有 documents/0.2.0、presentations/0.2.0、spreadsheets/0.2.0（四者共用 office-runtime 打包器）。
带 commands + mcpServers + userConfig 的样板：android-emulator/0.1.0。

## 1. 目录结构与 manifest 位置

插件根目录下：

```
<pluginRoot>/
  .zcode-plugin/plugin.json   ← 插件 manifest（首选探测位置）
  .zcode-plugin-seed.json     ← 安装器生成的缓存元数据（hash/marketplace/版本），不需要自己写
  package.json                ← 仅是 npm 元数据，宿主不读它做插件声明
  skills/                     ← 技能目录（manifest "skills": "skills" 指向它）
  commands/                   ← 斜杠命令目录（manifest "commands": "commands"）
  hooks/hooks.json            ← 插件 hooks（也可用 manifest "hooks" 字段）
  agents/                     ← 子代理定义目录
  dist/server.mjs             ← 打包后的 MCP server（单文件，自包含）
  dist/ui/panel.html          ← 面板入口 HTML
  dist/ui/assets.json         ← 面板资产清单
  dist/ui/bundle-0.txt        ← 面板 JS（伪装成 .txt，见 02 笔记）
```

manifest 探测顺序（zcode-guide diagnosing-plugins SKILL.md 原文）：`.zcode-plugin/plugin.json`（首选）→ `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json`。本项目用 `.zcode-plugin/plugin.json`。

约束：
- `name` 必须匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`。
- 组件路径（skills/commands 等字段的值）必须是相对路径且不得逃逸插件根，绝对路径会被拒绝。
- manifest 里"记录但不执行"的字段：`agents`、`channels`、`lspServers`、`outputStyles`、`settings`（agents 目录照放，宿主只是记录）。
- 插件身份 ID 是 `<name>@<marketplace>`，例如 `pdf@zcode-plugins-official`。

## 2. 完整 plugin.json 真实示例（pdf 0.2.1，逐字段注释）

来源：`C:\Users\86176\.zcode\cli\plugins\cache\zcode-plugins-official\pdf\0.2.1\.zcode-plugin\plugin.json`

```json
{
  "name": "pdf",
  "version": "0.2.1",
  "description": "PDF production skills and a PDF viewer panel, published as an official ZCode plugin.",
  "description_i18n": {
    "en": "PDF production skills: ...(英文描述)",
    "zh-CN": "PDF 制作技能：...(中文描述)"
  },
  "author": { "name": "Z.ai" },
  "license": "Apache-2.0",
  "skills": "skills",
  "agents": "agents",
  "mcpServers": {
    "pdf": {
      "type": "stdio",
      "command": "C:\\Program Files\\ZCode\\ZCode.exe",
      "args": [
        "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
        "__zcode-plugin-host",
        "C:\\Users\\86176\\.zcode\\cli\\plugins\\cache\\zcode-plugins-official\\pdf\\0.2.1/dist/server.mjs"
      ],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "ZCODE_WORKSPACE_ROOT": "${ZCODE_PROJECT_DIR}",
        "ELECTRON_RUN_AS_NODE": "1",
        "ZCODE_PLUGIN_ID": "pdf@zcode-plugins-official"
      }
    }
  },
  "ui": {
    "surfaces": [
      {
        "id": "pdf",
        "title": { "zh-CN": "PDF", "en-US": "PDF" },
        "icon": "file-text",
        "server": "pdf",
        "resourceUri": "ui://pdf/panel.html",
        "availability": "session"
      }
    ]
  }
}
```

要点：
- **注意**：上例 `command`/`args` 里的绝对路径是官方插件安装时被**改写**后的产物（指向 cache 里的安装路径）。第三方插件开发时应写为模板变量形式：`command` 用 `"${ZCODE_PLUGIN_ROOT}/..."` 类似的相对化写法，或参照 android-emulator 用 `command` + `args` 数组 + `${ZCODE_PLUGIN_ROOT}` 模板（模板变量**只有插件提供的 MCP server 才会展开**，用户配置文件里的 MCP 不展开——diagnosing-mcp SKILL.md §2）。
- `type: "stdio"` 可省略（有 `command` 即推断为 stdio）。schema 严格：**未知顶层键会导致整个 server 被丢弃**。
- 可用模板变量（diagnosing-mcp SKILL.md §2）：`${CLAUDE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_ROOT}`、`${CLAUDE_PROJECT_DIR}` / `${ZCODE_PROJECT_DIR}`、`${user_config.KEY}`（引用 userConfig 定义的键）。
- MCP server 被命名空间化为 `plugin:<plugin>:<server>`；模型看到的工具名形如 `mcp__plugin_pdf_pdf__open_document`（`mcp__` + `plugin_pdf` + `pdf` + 工具名）。本项目预期：`mcp__plugin_zcode-context-insight_<server>__<tool>`（名字含连字符是否合法：插件 name 允许 `-`，工具前缀直接拼接，待验证 T1 调通即知）。
- mcpServers 还支持 `.mcp.json` 文件形式（`<pluginRoot>/.mcp.json`，顶层 `mcpServers` 键），cloudbase-skills 用的就是这种。

### ui.surfaces 字段说明（实测仅此一种形态）

| 字段 | 说明 |
|---|---|
| `id` | 面板 ID，与工具 `_meta.ui.surface` 对应 |
| `title` | `{ "zh-CN": "...", "en-US": "..." }` 本地化标题 |
| `icon` | 图标名，取 lucide 图标名（如 `file-text`），不是文件路径 |
| `server` | 指向 mcpServers 里的 server 键名；面板桥接的就是这个 server |
| `resourceUri` | `ui://<插件名>/panel.html`，server 必须以 resources/read 提供该 URI（见 02 笔记） |
| `availability` | 实测官方插件全部用 `"session"`。其他取值未见实例（可能支持 `global`/`always` 之类）——**待验证** |

`description_i18n` / `displayName_i18n`（marketplace 条目用）格式：`{ "zh-CN": "...", "en": "..." }`；icon 为 URL 字符串（marketplace 条目里），surfaces 里为 lucide 名。

## 3. userConfig（插件设置项，android-emulator 实例）

来源：`C:\Users\86176\.zcode\cli\plugins\cache\zcode-plugins-official\android-emulator\0.1.0\.zcode-plugin\plugin.json`

```json
"userConfig": {
  "sdk_path": {
    "type": "string",
    "default": "",
    "description": "Optional Android SDK root directory. ..."
  },
  "api_level": { "type": "string", "default": "35", "description": "Android API level ..." }
}
```

- `type` 取值：`string` / `number` / `boolean` / `directory` / `file`；可选 `title`、`description`、`default`、`required`、`sensitive`。
- `sensitive: true` 的值当前**无法在界面输入或持久化**（无凭据存储），本项目不要用。
- 消费方式：MCP server env 里 `${user_config.KEY}`，如 android-emulator 的 `"ANDROID_PLUGIN_API_LEVEL": "${user_config.api_level}"`。T12 设置项走这条路。

## 4. 斜杠命令文件格式（commands/*.md）

真实示例：`C:\Users\86176\.zcode\cli\plugins\cache\zcode-plugins-official\android-emulator\0.1.0\commands\android-dev.md`

```markdown
---
description: Start the Android emulator development loop.
argument-hint: "[goal or issue description]"
skills: android-dev
---

Use the `android-dev` skill for this request:

$ARGUMENTS

Start with `android_preflight`. ...
```

规则（zcode-guide 0.3.0 diagnosing-commands SKILL.md，权威）：
- **文件名即命令名**，须匹配 `^[a-z0-9][a-z0-9_:-]{0,63}$`；子目录用 `:` 连接（`context/detail.md` → `/context:detail`）。
- front-matter 是**扁平解析器**：只认单行顶层键，支持 `description`、`argument-hint`、`allowed-tools`、`model`、`skills`、`disable-noninteractive`（全部连字符）；未知键忽略但命令仍加载；缩进/多行值会被丢弃。
- 必须有 `description` 或非空正文，否则整条命令被丢弃。
- 参数替换：`$ARGUMENTS`（全量）、`$1`/`$2`（位置参数，越界为空）；`${ARGUMENTS}` 形式**不**识别。
- `skills` 键自动挂载技能。
- **【重大风险】插件命令正文中的动态 shell 展开（`` !`cmd` `` 或 fenced `!` 块）会被拒绝**（diagnosing-commands §3 与坑 8："Inline dynamic shell (!`cmd` or a fenced `!` block) is rejected"）。ADR-0003 设想 /context 用 `` !`...` `` 注入会话 ID，与该文档冲突。文档措辞未区分插件级/用户级命令，保守假设全部拒绝。**T11 开工前必须实测**：在 `~/.zcode/commands/` 和插件 commands/ 各放一条 `` !`echo hi` `` 命令验证。若确认拒绝，/context 改为：命令正文指示模型调用 MCP 工具 `get_current_session_report`（server 端已通过心跳知道当前会话，不依赖命令注入）。
- 命令发现优先级：显式配置根 > 用户 `~/.zcode/commands` > `~/.agents/commands` > 工作区 `.zcode/commands` > `.agents/commands` > 插件命令根（最低）。

## 5. Hooks 声明（本项目心跳依赖，两处来源已交叉验证）

### 5.1 插件内 hooks/hooks.json（Claude 兼容格式，superpowers 实例）

来源：`C:\Users\86176\.zcode\cli\plugins\cache\claude-plugins-official\superpowers\6.1.1\hooks\hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false
          }
        ]
      }
    ]
  }
}
```

### 5.2 ZCode 宿主 hooks 权威 schema（zcode-guide 0.3.0 diagnosing-hooks SKILL.md）

- 插件 hooks 文件为 `hooks/hooks.json`（或 manifest `hooks` 字段），形状：`{ "hooks": { "<Event>": [ { "matcher"?, "hooks": [ {hook} ] } ] } }`。配置文件（`~/.zcode/cli/config.json`）则用 `hooks.events.<Event>` 包一层，内层数组相同。
- **事件名恰好 7 个**：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。`Notification`/`SubagentStop`/`PreCompact` **不支持**。
- `matcher` 是**区分大小写的正则**，匹配值：SessionStart→`startup|resume|clear|compact`；工具事件→工具名（`Bash`、`Read`、`Write`、`Edit`、`Agent`，别名 `Task`↔`Agent`、`Write`/`Edit`←`ApplyPatch`）；UserPromptSubmit→提示词文本；Stop→回复预览。省略 matcher 匹配一切。
- `type: "command"`：`command`（shell 字符串）、可选 `shell`、`timeout`（**秒**）、`timeoutMs`、`statusMessage`。`async` 目前无运行时效果（总是内联执行）。
- `type: "process"`：`command`（可执行文件）+ `args[]`（不经 shell 的参数向量，跨平台首选）+ `timeoutMs`（**毫秒**）+ `statusMessage`。**两种类型的字段混用会导致 hook 被丢弃**。
- 超时解析顺序：`timeoutMs` → `timeout×1000` → 配置级 `timeoutMs` → 默认 60000ms。
- 模板变量（在 command 和每个 arg 中展开，同时注入为环境变量）：`${CLAUDE_PROJECT_DIR}`/`${ZCODE_PROJECT_DIR}`、`${CLAUDE_SESSION_ID}`；**仅插件 hooks 额外有** `${CLAUDE_PLUGIN_ROOT}`/`${ZCODE_PLUGIN_ROOT}` 和插件数据目录变量。
- 输出约定：stdout 按**严格 schema** 解析为 JSON（多余键直接校验失败）；也可不发 stdout 只用退出码：0=放行，2=阻断（PreToolUse/PermissionRequest 的 deny），其他非零=错误。`additionalContext` 会被注入对话。**空输出合法**（心跳脚本 `exit 0` 且不输出即可）。
- 插件 hooks 不需要 `hooks.enabled: true`（那是配置文件 hooks 的开关）；**只要任一插件贡献了 hook，hook runner 自动启用**。
- 第三方插件 hooks 与内置一样直接可运行（无信任门）。
- hook 执行记录（fired/timed out/blocked + 错误流预览）写入 ZCode 日志。
- hook 的 stdin 是否有 JSON 输入：文档只说"Feed a sample hook input to the script"，原型未用 stdin——**待验证**，心跳不依赖它。

### 5.3 心跳原型实测（repo prototype/hook-heartbeat 分支，已裁定通过）

`git -C D:\.opensource\zcode-context-insight show prototype/hook-heartbeat` 提交 d706dbd，含 3 个文件：

**inject_hook.py**（向 `C:/Users/86176/.zcode/cli/config.json` 注入的 hooks 确切形状——这就是配置文件路径的格式）：

```python
cfg['hooks'] = {
    'enabled': True,
    'events': {
        'UserPromptSubmit': [
            {'hooks': [{
                'type': 'process',
                'command': 'C:/Program Files/Git/usr/bin/bash.exe',
                'args': ['D:/.opensource/zcode-context-insight/prototype/hook-heartbeat/heartbeat.sh'],
                'timeoutMs': 5000,
                'statusMessage': 'PROTOTYPE hook-heartbeat'
            }]}
        ]
    }
}
```

**heartbeat.log**（验证结论，2026-10-22）：
- 16:03:39 首次触发：所有环境变量 `<missing>`（注入后未重启，走了旧配置）。
- 16:16:49 重启后触发：`ZCODE_SESSION_ID`/`CLAUDE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID` 三个别名全部注入且等于真实会话 ID（`session_<32hex>`），`ZCODE_PROJECT_DIR` 同步注入；cwd 即项目目录。hook 可写文件、外部进程可读。
- 附带发现：**hook 配置不热加载，需重启应用生效**（对插件分发无碍：插件 hook 随安装/启动注册）。

本项目落地：插件自带 `hooks/hooks.json`，UserPromptSubmit process 型 hook → 写 `${ZCODE_PLUGIN_DATA}/heartbeat.json`（插件数据目录 `C:\Users\86176\.zcode\cli\plugins\data\<name>@<marketplace>\`，实测按该命名自动创建；android-emulator 用 `${ZCODE_PLUGIN_DATA}` 模板变量引用）。注意 process 型 command 需要可执行文件路径——Windows 下无 shebang 执行，参照原型用 `command: bash.exe + args: [脚本]`，但 bash 路径因机而异；**更稳的方案**：`command` 指向 Node（`C:\Program Files\nodejs\node.exe` 或模板变量，待验证是否有 `${ZCODE_NODE}` 类变量；官方插件 MCP 用 `ZCode.exe + zcode.cjs + __zcode-plugin-host` 启动，hook 是否也能这样组合**待验证**），args 指向插件内 `.mjs` 心跳脚本。

## 6. 工具可见性（app 可见 vs model 可见）

来源：pdf 0.2.1 `dist/server.mjs`（office-runtime 打包产物）中的 register 辅助函数，位于文件偏移约 5082694：

```js
server.registerTool(name, {
  description,
  inputSchema,
  annotations: { readOnlyHint: config.readOnly ?? true },
  _meta: {
    ui: config.panel
      ? { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: config.visibility }
      : { visibility: config.visibility },
    ...config.openPanel ? { "openai/ui": { preferredModelDisplayMode: "fullscreen" } } : {}
  }
}, execute)
```

- `visibility: ["model", "app"]`：模型可见 + 面板可见（如 `open_document`、`read_document`）。
- `visibility: ["app"]`：**仅面板可用**，模型看不到（如 `get_view`、`report_view`、`release_view`——面板桥内部调用）。
- `panel: true` 会在 `_meta.ui` 附加 `resourceUri` + `surface`，宿主据此把工具与面板关联。
- `openPanel: true` 附加 `"openai/ui": {"preferredModelDisplayMode": "fullscreen"}`，模型调用该工具时宿主自动打开面板。
- 本项目用法：DB/rollout 读取工具给 `["model","app"]`（模型可查、面板可查）；面板专用刷新/订阅类给 `["app"]`；`/context` 后端工具给 `["model","app"]`。

## 7. 官方插件功能矩阵（横向盘点结论）

| 插件 | skills | commands | agents | mcpServers | ui.surfaces | userConfig |
|---|---|---|---|---|---|---|
| pdf 0.2.1 | 2 | - | 1 | 1 | 1 | - |
| documents/presentations/spreadsheets 0.2.x | 2 | - | 1 | 1 | 1 | - |
| android-emulator 0.1.0 | - | 1 | - | 1 | - | 9 项 |
| image-search 0.1.1 | - | - | - | 1 | - | - |
| zcode-guide 0.2.0 | + | 1 | - | - | - | - |
| superpowers（claude 兼容） | + | - | - | - | - | hooks/hooks.json |

**没有任何本机官方插件同时声明 ui.surfaces + commands + hooks**；本项目是三者叠加，plugin.json 各字段互不冲突（diagnosing-plugins §2 把它们并列为可选字段），风险低但 T1 应最先做"最小 manifest 全字段加载"验证。
