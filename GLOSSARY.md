# zcode-context-insight

ZCode 的上下文与 token 可视化插件：跨会话总览、会话内上下文仪表盘、代理网络与 /context 命令。inspired by bowenliang123/dsh-context (Apache-2.0)，界面与实现独立重写。

## 数据

**模型请求 (Model Request)**:
一次发往模型的 API 调用，携带请求时刻的上下文内容与返回的用量数据。
_Avoid_: 调用、请求（单独使用）

**轮次 (Turn)**:
一次用户输入到回复完成的过程，聚合若干模型请求与工具调用。

**会话 (Session)**:
一个完整对话的载体，含标题、所属项目与时间范围；派生关系见「子代理会话」。

**子代理会话 (Subagent Session)**:
由父会话派生的独立会话，构成代理网络的父子关系。
_Avoid_: 任务、子任务

**压缩事件 (Compaction Event)**:
上下文逼近上限时，将历史消息总结为摘要的事件；记录压缩前后 token 数与被总结消息数。
_Avoid_: 裁剪、截断

**full / delta / tail 请求**:
模型请求载荷的三种形态：full 携带完整上下文快照，delta 与 tail 只携带尾部增量（tail 为实测补充，常见于子代理会话，详见 `docs/research/03-host-data.md` §7）。组成估算仅锚定于 full 请求。

## 口径

**精确用量 (Exact Usage)**:
API 返回的用量数字（input/output/缓存），只有总量，无分组。
_Avoid_: 真实用量、实际 token

**组成估算 (Estimated Composition)**:
按内容特征折算出的分组 token 数，展示时必须标注为估算。
_Avoid_: 精确组成、准确拆分

**上下文组成 (Context Composition)**:
上下文窗口按 system 提示、工具定义、历史消息、当前轮四个分组的构成。
_Avoid_: token 分布、上下文分布

## 视图

**Insights（跨会话总览）**:
跨全部会话的统计页：KPI、趋势图、热力图、模型组成、会话卡片。
_Avoid_: 首页、总览页

**Context 仪表盘（会话内）**:
单个会话的上下文视图：用量统计、组成条、趋势、事件流、文件活动、请求浏览器。

**Fleet（代理网络）**:
以父子关系组织的代理视图：主会话与各子代理会话的用量与状态卡片。

**/context 命令**:
对话内快捷入口，输出当前上下文组成摘要；结果留在对话流中。
