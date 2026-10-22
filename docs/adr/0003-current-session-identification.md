# 当前会话识别三路方案

宿主不向插件 MCP server 暴露会话 ID：`ZCODE_SESSION_ID` 只注入给 hooks 执行和斜杠命令的 shell 展开，在 plugin.json 中引用会在加载期直接报错（zcode.cjs 模板黑名单）。约束下的组合解：**主方案**——插件 hook 在用户提交时把 `ZCODE_SESSION_ID` 写入插件数据目录的心跳文件，server 读取即知当前会话；**兜底**——取 db.sqlite 中 `time_updated` 最新的 interactive 会话，界面标注"推断"；**命令路径**——/context 命令用 `` !`...` `` 展开把会话 ID 直接注入命令文本，永远精确。

## Consequences

- hook 心跳的可行性（事件名、写权限）尚未运行验证；若原型验证失败，整体退化为"最近活跃推断"为主方案，面板交互需相应调整。
