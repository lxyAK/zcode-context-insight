# 04 ADR 与术语决策摘要（实现必须遵守的约束清单）

来源：`D:\.opensource\zcode-context-insight\docs\adr\0001-dual-data-sources.md`、`0002-composition-estimation.md`、`0003-current-session-identification.md`、`D:\.opensource\zcode-context-insight\GLOSSARY.md`。每条注明出处，实现子代理不得违背。

## ADR-0001 双数据源分工（docs/adr/0001-dual-data-sources.md）

1. **db.sqlite 管历史与统计**（`~/.zcode/cli/db/db.sqlite`，实际路径 `C:\Users\86176\.zcode\cli\db\db.sqlite`）：请求级 `model_usage`、轮级 `turn_usage`、会话元数据、压缩事件 `part.type='compaction'`。→ T2/T4/T5/T7/T8 全部以 db 为准。
2. **rollout JSONL 管当前会话组成**（`rollout/model-io-session_*.jsonl`）：完整请求报文（system/工具定义/消息正文），但目录只保留近期会话。→ T3/T6 组成拆分。
3. **只读红线**：db.sqlite 是宿主活跃写入的库，插件只能以 `mode=ro` 只读 URI 打开（WAL），**绝不写入**；schema 变更由 ZCode 版本演进决定，**字段漂移需要容错**（缺列/改列名要降级，不能崩）。
4. **预期行为**：组成类视图（组成条、Context Browser/DNA）在 rollout 文件被清理后对旧会话**不可用**，属预期，UI 明示而非报错。

## ADR-0002 组成估算口径（docs/adr/0002-composition-estimation.md）

5. API usage 只有 input/output/缓存**总量**，无分组；组成条用**启发式折算**（按内容特征估算 token）并且**必须标注"估算"**；顶部总量数字**始终用 API 精确值**（db.model_usage / rollout response.usage）。两者并存、互不冒充。
6. 组成估算**只锚定 `messagesKind=full` 的请求快照**（delta 只含尾部增量，不能作基准）；**纯 delta 会话只展示精确总量**。（实测补充：还存在 `tail` 形态，同样不能作组成基准——见 03 笔记 §7，实现时按"非 full 不估算"处理即可，与 ADR 精神一致。）

## ADR-0003 当前会话识别三路方案（docs/adr/0003-current-session-identification.md）

7. 宿主**不向插件 MCP server 暴露会话 ID**：`ZCODE_SESSION_ID` 只注入给 hooks 执行和斜杠命令 shell 展开；**在 plugin.json（mcpServers env 等）里引用会在加载期直接报错**（zcode.cjs 模板黑名单）——plugin.json env 只能用 `${ZCODE_PROJECT_DIR}`、`${ZCODE_PLUGIN_ROOT}`、`${user_config.*}` 等白名单变量。
8. **主方案（已验证 2026-10-22）**：插件 hook 在用户提交时把 `ZCODE_SESSION_ID` 写入插件数据目录的心跳文件，server 读取即知当前会话。验证细节：process 型 hook 真实触发；`ZCODE_SESSION_ID`/`CLAUDE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID` 三别名全部注入且与实际会话一致；`ZCODE_PROJECT_DIR` 同步注入；hook 可写文件、server 可读。
9. **兜底**：取 db.sqlite 中 `time_updated` 最新的 interactive 会话，界面**标注"推断"**。
10. **命令路径**：/context 用 `` !`...` `` shell 展开把会话 ID 直接注入命令文本，"永远精确"。
    **【冲突警示】**zcode-guide 0.3.0 diagnosing-commands 明文：命令正文中的 inline dynamic shell（`` !`cmd` `` / fenced `!` 块）**被拒绝**。ADR-0003 的命令路径在本宿主（3.16.2）上很可能走不通。T11 必须先实测；若确认拒绝，改为"命令正文指示模型调用 `get_current_session_report` 工具"（主方案心跳已保证 server 知道当前会话，精度等价），并回写修订 ADR-0003。
11. 附带发现：hook 配置**不热加载**，修改需重启应用生效；对插件无害（插件 hook 随安装/启动注册）。

## GLOSSARY 术语与口径（GLOSSARY.md，UI 文案与命名必须一致）

12. 概念名：模型请求（Model Request）/ 轮次（Turn）/ 会话（Session）/ 子代理会话（Subagent Session，Avoid: 任务、子任务）/ 压缩事件（Compaction Event，Avoid: 裁剪、截断）/ full 请求 / delta 请求。
13. 口径名：**精确用量**（Exact Usage，Avoid: 真实用量、实际 token）/ **组成估算**（Estimated Composition，展示必须标注估算，Avoid: 精确组成、准确拆分）/ **上下文组成**（Context Composition：system 提示、工具定义、历史消息、当前轮 四分组；Avoid: token 分布、上下文分布）。
14. 视图名：**Insights（跨会话总览**，Avoid: 首页、总览页）/ **Context 仪表盘**（会话内）/ **Fleet（代理网络**，父子关系组织的代理视图）/ **/context 命令**（结果留在对话流中）。
15. 组成四分组固定为：system 提示、工具定义、历史消息、当前轮。

## 跨 ADR 的实现红线汇总（T13 健壮性验收对照）

- 只读打开 db（mode=ro），任何写路径禁止，包括 WAL/SHM 侧写（readOnly 连接本身保证）。
- db schema 漂移容错：逐表 PRAGMA table_info 探测，缺表缺列降级为"部分数据不可用"，不抛异常炸面板。
- rollout 缺文件/被清理：组成视图显示不可用提示，统计仍走 db。
- 估算与精确并存且视觉可区分（"估算"角标），不冒充。
- 心跳缺失走兜底推断并标注"推断"。
- 子代理/工作流会话（task_type != interactive）在 Insights 计入统计，但在"当前会话"识别与 Fleet 主节点选择中排除。
- query_source 过滤口径：session_title 类请求不计入用户对话成本（03 笔记 §3 取值分布）。
