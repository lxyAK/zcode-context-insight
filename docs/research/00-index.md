# 00 索引：zcode-context-insight 实现研究笔记

调查日期：2026-10-22；宿主 ZCode 3.16.2（CLI 0.17.0）/ Windows / Node v22.21.1。
调查约束：`D:\.opensource\zcode-context-insight` 与 `C:\Users\86176\.zcode\` 严格只读；db.sqlite 经复制到临时目录后只读查询。
注意：本目录（`D:\.opensource\zci-impl-notes\`）是唯一可写位置。

## 笔记清单与摘要

### 01-plugin-format.md — ZCode 插件格式
manifest 位于 `.zcode-plugin/plugin.json`（name 正则、组件目录字段、mcpServers stdio 声明含 `${ZCODE_PLUGIN_ROOT}`/`${ZCODE_PROJECT_DIR}`/`${user_config.*}` 模板白名单）；`ui.surfaces` 面板声明五字段（id/title/icon/server/resourceUri/availability:session）；commands/*.md 扁平 front-matter（description/argument-hint/skills/... + `$ARGUMENTS`）；hooks 恰好 7 个事件、process/command 两型字段严格不混用、插件 hooks/hooks.json 自动启用 runner；工具可见性用 `_meta.ui.visibility: ["model","app"]|["app"]`。参考样板 pdf 0.2.1（MCP+面板+技能）与 android-emulator 0.1.0（commands+userConfig）。

### 02-panel-protocol.md — MCP Apps 面板协议
面板=window.parent postMessage 上的 JSON-RPC 2.0（`ui/initialize`→`ui/notifications/initialized` 握手，protocolVersion "2026-01-26"）；`callServerTool({name,arguments})`=tools/call；stateKey 从 `hostCapabilities.experimental["zcode/surface"].stateKey` 取，作 localStorage 键；资产无网络/无外链，经 `resources/read` 的 `ui://<name>/assets/*` 文本通道取回后 inline 注入（JS 存成 .txt）；主题用宿主 `--color-*` CSS 变量；面板可反向注册工具（oncalltool）。含最小 panel.html 骨架与 uPlot 两条打包路径（推荐全量内联）。

### 03-host-data.md — 宿主数据 schema
db 在 `C:\Users\86176\.zcode\cli\db\db.sqlite`（WAL，必须 mode=ro）；session（parent_id/task_type/time_updated 兜底）、model_usage（请求级精确 token，query_source 枚举含 main_turn/subagent/workflow_child/session_title/compact）、turn_usage、part（data JSON，type='compaction' 含压缩前后 token 与消息数完整结构）全列清单+脱敏样例；时间戳一律 Unix 毫秒。rollout 在 `C:\Users\86176\.zcode\cli\rollout\model-io-<sessionId>.jsonl`，每行=完整请求（request.messages 明文/messagesKind full|delta|tail/messageOffset、response.usage camelCase）；心跳原型裁定通过（三别名环境变量注入、写文件可读、需重启生效）。

### 04-adr-decisions.md — ADR 决策清单
15 条硬约束浓缩：db 管历史/rollout 管组成、只读红线、schema 漂移容错、组成只锚定 full 请求且必须标"估算"、精确总量用 API 值、当前会话=心跳主方案+time_updated 兜底标注"推断"、/context 命令路径与宿主文档存在冲突（!`` 动态 shell 被拒）需实测、术语表命名规范（精确用量/组成估算/Insights/Context 仪表盘/Fleet）。

### 05-dev-loop.md — dev 回路与工具链
CLI 真实入口 `ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs <cmd>`；`plugins validate/install/marketplace add` 全集；本地市场 marketplace.json 作者格式（source 相对路径，不支持 npm）；插件装进 cache\<marketplace>\<name>\<ver>\，数据目录 data\<name>@<marketplace>\（心跳落点），启停在 config.json plugins.enabledPlugins；Node 22 内置 node:sqlite 免依赖读库；esbuild+vitest npx 可用；建议目录结构与 package.json 脚本骨架；T1 验收清单 6 条。

## 工单 → 笔记映射

| 工单 | 必读 | 重点章节 |
|---|---|---|
| T1 插件骨架/面板调通/dev 回路 | 01 + 02 + 05 | 01 §1-2（manifest/MCP）、02 §3/§6/§7（握手/骨架/server 最小面）、05 全部 |
| T2 会话识别+DB 精确用量 | 03 + 01 | 03 §2-4（session/model_usage/turn_usage）、§8-9（心跳/兜底）、01 §5（hook 配置） |
| T3 rollout 组成估算 | 03 + 04 | 03 §7（JSONL 结构/messagesKind 三态）、04 第 5-6 条（口径红线） |
| T4 逐请求趋势+压缩标记 | 03 | §3（model_usage 时间序列）、§5（compaction part 完整结构） |
| T5 统计卡 | 03 | §3-4（token 字段语义：input 含 cache_read，总量用 computed_total_tokens） |
| T6 Context Browser 明细 | 03 + 02 | 03 §5（message/part JSON）、§7（messages 明文）、02 §4（面板取数） |
| T7 事件流+文件活动 | 03 | §5（part.type=timeline/file/tool、contextSnapshot 环境信息）、§6（tool_usage） |
| T8 Insights KPI | 03 + 04 | §3（query_source 过滤口径）、§6（session_task_link/workflow_activity）、04 第 16 条 |
| T9 热力图+环形图 | 02 + 04 | 02 §5（uPlot 打包）、04 第 15 条（四分组命名） |
| T10 Fleet 树 | 03 | §2（parent_id）、§6（session_task_link/workflow_activity 双来源） |
| T11 /context 命令 | 01 + 04 | 01 §4（命令格式+动态 shell 被拒风险）、04 第 10 条（冲突警示与替代方案） |
| T12 设置+自动刷新 | 01 + 02 | 01 §3（userConfig/${user_config.*}）、02 §3（stateKey 持久化/hostcontextchanged） |
| T13 健壮性 | 04 + 03 | 04 全部红线、03 §9（BUSY/漂移/rollout 清理容错） |
| T14 打磨 | 04 + 02 | 04 术语规范、02 §3（主题 CSS 变量/显示模式/多面板待验证项） |

## 最重要的三个风险（开工前先看）

1. **/context 的 `` !`...` `` 注入路径很可能被宿主拒绝**（01 §4 / 04 第 10 条）：zcode-guide 0.3.0 明文 inline dynamic shell is rejected，与 ADR-0003 冲突。T11 第一步实测，失败即切换到"命令→MCP 工具"方案并修订 ADR。
2. **rollout 存在第三种 messagesKind=tail**（03 §7）：ADR-0002 只写了 full/delta。组成估算逻辑必须按"非 full 不估算"实现，遇到 tail 不可当基准。
3. **manifest 模板变量黑名单**（04 第 7 条）：plugin.json 引用 `${ZCODE_SESSION_ID}` 会在加载期直接报错；会话 ID 只能经 hook 心跳文件进 server。同时 hook 配置不热加载，调试 hook 改动必须重启应用。
