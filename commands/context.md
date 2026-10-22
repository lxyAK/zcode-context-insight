---
description: 输出当前会话的上下文组成摘要（精确用量、组成估算与接近压缩提醒），结果留在对话流中。
---

调用 Context Insight 插件的 MCP 工具 `get_current_session_report`（模型侧全名形如
`mcp__plugin_zcode-context-insight_zci__get_current_session_report`），获取当前会话的
组成摘要，并把摘要整理为简明的中文报告输出到对话流。

会话识别由该工具在服务端完成（用户提交心跳优先，精确锚定当前会话），无需向命令
或工具传入会话 ID。

输出要求：

1. **会话**：会话标识（脱敏展示前 8 位即可）、标题、识别来源（heartbeat=心跳精确；
   inferred=最近活跃推断）。
2. **精确用量**：请求数与 input/output/缓存读/缓存写/推理 token 合计；总量以
   computed_total_tokens 口径为准，并注明 input 已含缓存读部分。
3. **组成估算**：按返回的 composition 字段呈现——若 `estimated=true` 按四分组
   （system 提示 / 工具定义 / 历史消息 / 当前轮）列出各组数字并**标注"估算"**；
   若 `estimated=false` 则说明组成估算暂不可用，展示 API 精确总量兜底，不得把
   兜底值冒充分组。
4. **接近压缩提醒**：若返回 `compactionWarning` 且 `present=true`，醒目提示当前
   上下文占用已接近压缩阈值（给出 ratio 与依据）；`present=false` 时简要给出
   占用率；字段为 null 时省略本条。

若工具返回 `available=false`，直接说明数据不可用及原因（如宿主库尚未生成），
不要编造数字。
