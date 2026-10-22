# 当前会话识别三路方案

宿主不向插件 MCP server 暴露会话 ID：`ZCODE_SESSION_ID` 只注入给 hooks 执行和斜杠命令的 shell 展开，在 plugin.json 中引用会在加载期直接报错（zcode.cjs 模板黑名单）。约束下的组合解：**主方案**——插件 hook 在用户提交时把 `ZCODE_SESSION_ID` 写入插件数据目录的心跳文件，server 读取即知当前会话；**兜底**——取 db.sqlite 中 `time_updated` 最新的 interactive 会话，界面标注"推断"；**命令路径**——/context 命令用 `` !`...` `` 展开把会话 ID 直接注入命令文本，永远精确。

## Consequences

- **已验证（2026-10-22）**：`prototype/hook-heartbeat` 分支留存了验证脚本与心跳日志。process 型 hook（Git Bash 执行）真实触发；`ZCODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `CLAUDE_CODE_SESSION_ID` 三个别名全部注入且与实际会话一致，`ZCODE_PROJECT_DIR` 同步注入；hook 可写文件、MCP server 可读。主方案成立。
- 附带发现：hook 配置**不热加载**，修改后需重启应用生效。对插件无害——插件 hook 随安装/启动注册，不存在运行中改配置的场景。
