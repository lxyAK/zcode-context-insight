# 双数据源分工：db.sqlite 管历史，rollout JSONL 管当前

ZCode 的两个会话数据存储各缺一半：`~/.zcode/cli/db/db.sqlite` 有完整历史（请求级 `model_usage`、轮级 `turn_usage`、会话元数据、压缩事件 `part.type='compaction'`），但没有报文明文，上下文组成拆不出来；`rollout/model-io-session_*.jsonl` 有完整请求报文（system/工具定义/消息正文），但目录只保留近期会话。因此统计与历史走 db.sqlite（WAL 只读 URI 打开，绝不写入），当前会话的组成拆分走 rollout JSONL，两轨并存。

## Consequences

- db.sqlite 是宿主活跃写入的库，插件只能以 `mode=ro` 只读打开，schema 变更由 ZCode 版本演进决定，字段漂移需要容错。
- 组成类视图（组成条、Context Browser/DNA）在 rollout 文件被清理后对旧会话不可用，属预期行为。
