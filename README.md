# zcode-context-insight

<p align="center">
  <img src="assets/icon.svg" width="96" alt="Context Insight 图标" />
</p>

ZCode 的上下文与 token 可视化插件：跨会话总览（Insights）、会话内 Context 仪表盘、代理网络（Fleet）与 /context 命令。inspired by [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) (Apache-2.0)，界面与实现独立重写。

> **致谢与许可证声明**：本项目的产品灵感来自 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)（采用 Apache-2.0 许可证发布）。本项目的界面与实现均为独立重写，未复用其代码；此处保留对其许可证的声明以示尊重。

## 功能总览

三入口一引擎，数据全部来自本机 ZCode 产生的数据：

- **Insights（跨会话总览）**：跨全部会话的 KPI、7 天趋势、活跃热力图、模型组成与会话卡片
- **Context 仪表盘（会话内）**：当前会话的精确用量、上下文组成条（system / 工具定义 / 历史消息 / 当前轮）、逐请求趋势与压缩事件标记、事件流、文件活动、请求浏览器
- **Fleet（代理网络）**：以父子关系组织的主会话与子代理会话树，量化每个代理的成本
- **/context 命令**：对话内输出当前上下文组成摘要，结果留在对话流中
- **MCP server 引擎**：解析 ZCode 本地数据（db.sqlite 只读 + rollout model-io JSONL），聚合统计，向面板与命令提供工具

口径约定（详见 `GLOSSARY.md`）：总量数字一律使用 API 返回的**精确用量**；分组拆分为**组成估算**，展示时明确标注"估算"。"当前会话"的识别来源（心跳精确 / 最近活跃推断）在界面上可区分。

## 数据与隐私：严格只读

- 对宿主数据**严格只读**：db.sqlite 以只读 URI（`mode=ro`）打开，rollout JSONL 仅读取，绝不写入、修改或删除任何 ZCode 数据
- 插件自身只写自己的插件数据目录（心跳文件与设置）
- **不向外部发送任何内容**：无遥测、无上报；面板与 server 资产全部内嵌，零外部网络依赖

## 本地安装（dev 回路）

前提：已安装 ZCode 桌面版（自带 `zcode` CLI）与 Node.js 22+。

```bash
npm install
npm run dev        # 升版本(patch) + 构建 + 重建本地市场清单 market/zci-local/
```

随后用 zcode CLI 添加本地市场并安装（Windows Git Bash 下 CLI 真实入口：
`ELECTRON_RUN_AS_NODE=1 "C:/Program Files/ZCode/ZCode.exe" "C:/Program Files/ZCode/resources/glm/zcode.cjs" <command>`）：

```bash
zcode plugins marketplace add <仓库路径>/market/zci-local
zcode plugins install zcode-context-insight@zci-local
```

安装/更新后**重启 ZCode 桌面应用**生效（MCP server、面板与 hook 均不热加载）。冒烟检查：

```bash
zcode plugins list          # 应显示 zcode-context-insight 及 mcp/hooks 计数
```

面板从侧栏打开（标题"上下文洞察"）；发送一条用户消息后，插件数据目录会出现心跳文件。

> 注意：`npm run dev` 会递增 patch 版本号（`package.json` 与 `.zcode-plugin/plugin.json` 同步，版本单一真值在 `package.json`）；已安装插件通过版本号感知更新，改代码后需再跑 `npm run dev` + `zcode plugins update zcode-context-insight@zci-local` + 重启。

## 开发

```bash
npm run build      # 构建 dist/server.mjs + dist/ui/panel.html（esbuild，自包含单文件）
npm test           # 构建 + vitest 全量（契约 / 工具口径 / 面板挂载冒烟 / hook 行为）
npm run typecheck  # tsc --noEmit
```

- 面板产物 `dist/ui/panel.html` 由 esbuild 整体内联生成（源在 `src/panel/`），零外链资产（沙箱 CSP 禁网）
- 面板文案经 `src/panel/i18n.ts`（i18n 骨架：zh-CN 为默认且当前唯一语言；既有文案已迁入，其余视图文案渐进迁入）
- 领域术语与口径见 `GLOSSARY.md`；架构决策记录见 `docs/adr/`
- 宿主与插件协议的一手研究笔记（manifest 格式 / 面板桥 / db schema）见 `docs/research/`；代码审查用的判断题标准见 `CODING_STANDARDS.md`

## 目录结构

```
├── .zcode-plugin/plugin.json   # 插件 manifest（MCP server / 面板声明，description_i18n 中英双语）
├── assets/icon.svg             # 插件图标（内嵌 SVG，零外链；市场条目以 data URI 引用）
├── docs/
│   ├── adr/                    # 架构决策记录（双数据源 / 组成口径 / 会话识别）
│   └── agents/                 # agent 协作约定（工单 / 分诊 / 领域文档）
├── hooks/                      # UserPromptSubmit 心跳 hook（当前会话识别）
├── scripts/                    # build / dev / 本地市场清单生成 / 合成夹具
├── src/
│   ├── panel/                  # 面板：bridge（协议层）/ panel（装配层）/ i18n（文案中心）
│   └── server/                 # MCP server：db 只读层 / 心跳读取 / 工具注册
├── test/                       # vitest：插件契约 / 工具口径 / 面板挂载冒烟 / hook 行为
├── GLOSSARY.md                 # 领域术语与数据口径（单一领域上下文）
└── package.json                # 版本单一真值
```

（`dist/` 与 `market/` 为构建生成物，已 gitignore。）
