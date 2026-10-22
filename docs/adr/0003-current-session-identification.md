# 当前会话识别三路方案

宿主不向插件 MCP server 暴露会话 ID：`ZCODE_SESSION_ID` 只注入给 hooks 执行和斜杠命令的 shell 展开，在 plugin.json 中引用会在加载期直接报错（zcode.cjs 模板黑名单）。约束下的组合解：**主方案**——插件 hook 在用户提交时把 `ZCODE_SESSION_ID` 写入插件数据目录的心跳文件，server 读取即知当前会话；**兜底**——取 db.sqlite 中 `time_updated` 最新的 interactive 会话，界面标注"推断"；**命令路径**（2026-10-22 修订，见文末）——/context 命令正文指示模型调用 `get_current_session_report` 工具，会话识别复用心跳，精度等价。

## Consequences

- **已验证（2026-10-22）**：`prototype/hook-heartbeat` 分支留存了验证脚本与心跳日志。process 型 hook（Git Bash 执行）真实触发；`ZCODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `CLAUDE_CODE_SESSION_ID` 三个别名全部注入且与实际会话一致，`ZCODE_PROJECT_DIR` 同步注入；hook 可写文件、MCP server 可读。主方案成立。
- 附带发现：hook 配置**不热加载**，修改后需重启应用生效。对插件无害——插件 hook 随安装/启动注册，不存在运行中改配置的场景。

## 修订（2026-10-22，T11 落地时）

**命令路径由"shell 展开注入会话 ID"改为"命令正文指示模型调用 MCP 工具"。**

宿主文档（zcode-guide 0.3.0 diagnosing-commands §3 与坑 8）明文：命令正文中的
inline dynamic shell（`` !`cmd` `` 或 fenced `` ! `` 块）**被拒绝**，原设想的
`` !`...` `` 注入路径在本宿主（3.16.2）不可行。替代方案：`/context` 命令正文指示
模型调用 model 可见的 `get_current_session_report` 工具，会话识别完全复用主方案的
心跳（工具在服务端读心跳文件，无需命令注入会话 ID），**精度与命令注入等价**；
无心跳时同样走推断兜底并标注。

- 影响范围：仅命令实现路径；主方案（心跳）与兜底（推断）不变。
- 验证口径（工单 T11 验收项 2 改述）：命令执行后模型调用的工具以**心跳会话**为准——
  测试夹具中使"心跳指向会话"与"无心跳推断会话"可区分（time_updated 错开），
  断言报告锚定心跳会话。
- 同前的宿主侧限制：命令文件与 hooks 一样不热加载，装载验证需重启宿主。
