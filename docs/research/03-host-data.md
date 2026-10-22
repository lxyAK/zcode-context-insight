# 03 宿主本地数据：db.sqlite schema + rollout JSONL + 心跳原型

调查方式：db.sqlite 位于 `C:\Users\86176\.zcode\cli\db\db.sqlite`（另有 -shm/-wal，WAL 模式，宿主持续写入）。
本次调查将三份文件**复制到临时目录后**用 `node:sqlite`（Node v22.21.1 内置，`new DatabaseSync(path, {open:true, readOnly:true})`）只读打开，未触碰原库。
**生产代码必须**用只读 URI 打开原库：`new DatabaseSync('file:C:/Users/86176/.zcode/cli/db/db.sqlite?mode=ro', { open: true })`——即便如此仍可能在宿主写 WAL 时遇到 schema 锁，稳妥做法是优先 `immutable=1` 或先复制（复制三件套 sqlite+wal+shm）再查（ADR-0001 红线：绝不写入）。

## 1. 全部表清单（27 张）

dwf_actor, dwf_event, dwf_node, dwf_run, input_history, local_setting, **message**, **model_usage**, **part**, permission, schema_migration, **session**, session_entry, session_input, session_target, session_task_link, todo, **tool_usage**, **turn_usage**, workflow_activity, workflow_definition, workflow_event, workflow_run, zcode_database_identity
（加粗者为本项目相关。另有 `C:\Users\86176\.zcode\v2\tasks-index.sqlite` 任务索引库，与 token 统计无关，忽略。）

**所有时间戳字段均为 Unix 毫秒**（实测 1792659481536 → 2026-10-22T08:58:01.536Z）。

## 2. session 表

```sql
CREATE TABLE session (
  id text primary key,                -- 'session_<32hex>' 主会话；'sess_subagent_agent_<uuid>' 子代理
  project_id text not null,           -- 如 'proj_d-.opensource-zcode-context-insight'（目录编码进 ID）
  workspace_id text,
  parent_id text,                     -- 父会话 ID（子代理→父）；主会话为 NULL —— Fleet 树的父子边
  slug text not null,                 -- 同 id 形式的 slug
  directory text not null,            -- 工作目录绝对路径 'D:\.opensource\zcode-context-insight'
  path text,
  title text not null,                -- 首条输入截断（title_source='first_input'）
  version text not null,
  share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs text, revert text, permission text,
  time_created integer not null,      -- ms
  time_updated integer not null,      -- ms —— 兜底识别"当前会话"用：最新 interactive
  time_compacting integer,            -- 压缩时间（有值=发生过压缩）
  time_archived integer,
  task_type text not null default 'interactive',
    -- 实测取值: interactive(294) subagent_child(344) workflow_child(195) fork(15) selection_side_chat(19)
  title_source text not null default 'first_input'
    check(title_source in ('default','first_input','generated','custom')),
  title_message_id text, time_title_updated integer, trace_id text,
  time_deleted integer,               -- 软删除标记，查询要过滤 IS NULL
  last_outcome text
)
```

脱敏示例（2 行）：

```json
{"id":"sess_subagent_agent_31f0...","project_id":"proj_d-.opensource-zcode-context-insight","parent_id":"session_b8bbf163aac381f1bbcfe899be4ba0df","directory":"D:\\.opensource\\zcode-context-insight","title":"你是探索代理，为插件...","task_type":"subagent_child","title_source":"first_input","time_created":1792659481536,"time_updated":1792659679458,"time_compacting":null}
{"id":"session_b8bbf163aac381f1bbcfe899be4ba0df","parent_id":null,"task_type":"interactive","title":"[$implem...","time_created":1792659159340}
```

## 3. model_usage 表（请求级精确用量 —— T2/T4/T8 数据源）

```sql
CREATE TABLE model_usage (
  id text primary key,
  logical_request_id text not null,   -- 一次逻辑请求（多 attempt 共用）
  attempt_index integer not null default 0,
  session_id text not null references session(id),
  turn_id text,                       -- 'turn_<id>'，关联 turn_usage
  trace_id text, span_id text,
  assistant_message_id text, parent_user_message_id text,
  query_source text not null,
    -- 实测取值: main_turn(12514) workflow_child(3943) subagent(1410) session_title(75) compact(23)
    -- 统计"用户可见对话成本"应排除 session_title；compact 行本身记录压缩请求的用量
  provider_id text not null,          -- 'account:bigmodel-individual-coding-plan'
  model_id text not null,             -- 'GLM-5.3'
  variant text, agent text,           -- agent 如 'zcode-general-purpose'（子代理类型）
  mode text,                          -- 'yolo' 等权限模式
  task_type text,                     -- 冗余 session.task_type
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, completed_at integer, duration_ms integer,
  first_token_at integer, time_to_first_token_ms integer, finish_reason text,
  tool_call_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  provider_total_tokens integer,      -- API 返回 total（可能 NULL）
  computed_total_tokens integer not null default 0,  -- 宿主算的 total
  retry_count integer, retryable integer,
  cancelled_by_user integer, context_exceeded integer,  -- 0/1 超上下文标记
  error_type text, error_code text, error_message text,
  raw_usage_json text,                -- 原始 usage JSON
  provider_metadata_json text
)
-- 索引: model_usage_session_turn_idx, model_usage_query_source_idx, model_usage_started_model_idx, model_usage_trace_idx
```

脱敏示例（注意 input_tokens 含 cache_read，精确总量= computed_total_tokens）：

```json
{"logical_request_id":"msg_mvjb...","attempt_index":0,"session_id":"sess_subagent_agent_31f0...","turn_id":"turn_5c9...","query_source":"subagent","provider_id":"account:bigmodel-individual-coding-plan","model_id":"GLM-5.3","agent":"zcode-general-purpose","mode":"yolo","task_type":"subagent_child","status":"completed","started_at":1792659673357,"completed_at":1792659679449,"input_tokens":77303,"output_tokens":254,"reasoning_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":75904,"computed_total_tokens":77557,"context_exceeded":0}
```

## 4. turn_usage 表（轮级聚合 —— T5/T8）

```sql
CREATE TABLE turn_usage (
  session_id text not null references session(id),
  turn_id text not null, trace_id text,
  user_message_id text,
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, first_model_start_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer,
  model_request_count integer not null default 0,   -- 轮内请求数
  model_retry_count integer, tool_call_count integer, tool_error_count integer,
  input_tokens/output_tokens/reasoning_tokens/
  cache_creation_input_tokens/cache_read_input_tokens/computed_total_tokens integer,
  retryable integer, cancelled_by_user integer, context_exceeded integer,
  error_type text, error_code text,
  primary key(session_id, turn_id)
)
```

## 5. message / part 表（正文 JSON —— 压缩事件、事件流、Context Browser）

```sql
CREATE TABLE message (
  id text primary key, session_id text not null references session(id),
  time_created integer not null, time_updated integer not null,
  data text not null,     -- JSON: {role, time, agent, model, contextSnapshot, tools, modelSelection}
  sequence integer        -- 会话内序号（message_session_sequence_idx）
)
CREATE TABLE part (
  id text primary key, message_id text not null references message(id),
  session_id text not null, time_created integer not null, time_updated integer not null,
  data text not null,     -- JSON: {type, ...}
  sequence integer
)
```

- message.role 实测只有 `user`(13876) / `assistant`(70816)。`contextSnapshot` 仅部分 user 消息有（6325 条），内容是**环境信息**（cwd/platform/shell/osVersion/nodeVersion/isGitRepository/gitBranch/gitStatus/recentCommits）——不是 token 组成，但可做"文件活动"补充数据。
- part.type 实测分布：tool(77519) step-start(69817) step-finish(69483) text(54959) reasoning(42450) timeline(740) file(275) **compaction(232)**。
- tool part data 形状：`{type:'tool', callID, tool, state}`；timeline/file 类型是事件流/文件活动的现成来源（T6/T7 优先读它们，别自己解析 tool 正文）。

**compaction part 完整结构**（脱敏，T4 压缩标记的权威来源）：

```json
{
  "type": "compaction",
  "auto": true,                  // boolean
  "trigger": "...", "phase": "...", "compactReason": "...",
  "tail_start_id": "msg_...",
  "compactBoundary": {
    "boundaryId": "...",
    "preCompactDiscoveredTools": [],
    "trigger": "...", "phase": "...", "compactReason": "...", "summarySource": "...",
    "preCompactTokenCount": 123456,     // 压缩前 token
    "postCompactTokenCount": 12345,     // 压缩后 token
    "truePostCompactTokenCount": 12345,
    "summarizedMessageCount": 42,       // 被总结消息数
    "keptMessageCount": 8,
    "lastSummarizedMessageId": "msg_...",
    "summaryMessageIds": ["msg_..."],
    "customInstructions": false,
    "traceId": "...", "turnId": "turn_..."
  },
  "operationId": "..."
}
```

查询压缩事件：`SELECT session_id, time_created, data FROM part WHERE json_extract(data,'$.type')='compaction' ORDER BY time_created`（注意无函数索引，全表扫 part 较慢——part 很大，建议先用 session_id 过滤走 part_session_idx）。

## 6. 其余相关表速记

- `session_task_link`：工作流派生的会话父子链（parent_session_id/child_session_id/role/depth/path/agent_type/model/status），child 唯一。Fleet 树除 session.parent_id 外的第二来源（workflow 型子代理）。
- `workflow_activity`：工作流活动，含 `child_session_id`、prompt、status、label——Fleet 视图的节点元数据。
- `tool_usage`：工具调用统计（tool_name/read_only/destructive/approval_status/output_bytes/stdout_bytes/...）——T7 文件活动/Bash 用量可参考。
- `session_entry`：运行时杂项（type 分布：runtime/workspace_checkpoint 7817、runtime/execution_state、v4/command_fact 等）。
- `input_history`：历史输入（有 project+time 索引）。

## 7. rollout 目录（model-io JSONL —— T3/T4 组成估算数据源）

位置：`C:\Users\86176\.zcode\cli\rollout\`

- **文件命名**：`model-io-<sessionId>.jsonl`。sessionId 原样嵌入：主会话 `model-io-session_<32hex>.jsonl`，子代理 `model-io-sess_subagent_agent_<uuid>.jsonl`。因此**从心跳拿到会话 ID 即可直拼文件名**。
- 目录按宿主清理策略只保留近期会话（当前仅 3 个文件）；spec 另提到 `model-io-no-session.jsonl`（无会话请求的落点），当前目录不存在该文件——**待验证**（推测在无 sessionId 的请求如启动期标题生成时出现）。
- 每行一个 JSON 对象 = 一次完整模型请求-响应记录。逐行结构（实测）：

```jsonc
{
  "type": "model_io",
  "sessionId": "session_0d0325352bbf74f419bd06eb7dc00c3a",
  "requestId": "45068410-1f60-4cbb-b420-58fb645148d3",   // UUID
  "attempt": 1,
  "traceId": "b8e8ff1a-...", "turnId": "turn_...",
  "startedAt": "2026-10-22T08:51:21.328Z",                // ISO 字符串（db 里是 ms 整数，注意换算）
  "completedAt": "2026-10-22T08:51:26.530Z", "durationMs": 5202,
  "querySource": "main_turn",                              // 同 db.query_source 枚举
  "model": { "modelId": "GLM-5.3", "providerId": "account:bigmodel-individual-coding-plan" },
  "request": {
    "body": { "model", "max_tokens", "metadata", "system", "tools", "tool_choice", "stream", "thinking", "output_config" },
    "headers": {...},
    "messages": [ { "role": "system|user|assistant|tool", "content": "..." }, ... ],  // 明文报文
    "toolNames": ["Read","Bash",...],                      // 本次请求的工具名数组（实测 97 个）
    "messageCount": 6,                                     // messages.length
    "messagesKind": "full|delta|tail",                     // 见下
    "messageOffset": 0                                     // 该请求上下文在会话消息流中的起始偏移
  },
  "response": {
    "finishReason": "...", "modelId": "...", "responseId": "...",
    "text": "...", "reasoningText": "...", "toolCalls": [...],
    "usage": { "inputTokens": 63965, "outputTokens": 179, "totalTokens": 64144,
               "cacheReadTokens": 54848, "cacheWriteTokens": 0 },
    "headers": {...}, "providerMetadata": {...}
  }
}
```

**messagesKind 实测有三种取值**（ADR-0002 只提了 full/delta）：
- `full`：messageOffset=0，携带完整上下文快照（组成估算只锚定它，ADR-0002 口径）。
- `delta`：messageOffset=N>0，只带尾部增量（如 offset=6/count=8：前 6 条已缓存，仅发 2 条新）。
- `tail`：messageOffset=N>0 且 count>offset 的中间形态（子代理会话中大量出现，如 offset=30/count=94）——**语义待验证**（推测：prefix 缓存命中 + 从 N 起的重发尾部）。组成估算遇到 tail 同样不可作基准。
- 一个会话通常是 full 与 delta/tail 交替；纯 delta 会话按 ADR-0002 只展示精确总量。

组成估算的分组锚点（T3）：`request.messages` 按 role 分组（system 4 条 + tools 97 个 → system/工具定义组；user/assistant 历史消息组；最后一条 user → 当前轮），`request.body.system`/`request.body.tools` 是原始定义文本，token 折算按内容特征（字符/词元比）自行估算并标注"估算"。

## 8. 心跳原型（prototype/hook-heartbeat 分支）

提交 d706dbd（2026-10-22），三文件：`heartbeat.sh`（追加写日志：时间戳 + ZCODE_SESSION_ID/CLAUDE_SESSION_ID/CLAUDE_CODE_SESSION_ID/ZCODE_PROJECT_DIR/cwd）、`inject_hook.py`（把 hooks 注入 `C:/Users/86176/.zcode/cli/config.json`，确切 JSON 形状见 01 笔记 §5.3）、`heartbeat.log`（两次触发记录）。

验证裁定（ADR-0003 Consequences 已记录）：
- **通过**：process 型 hook（Git Bash 执行）真实触发；三个会话 ID 别名环境变量全部注入且与实际会话一致；ZCODE_PROJECT_DIR 注入；hook 可写文件、MCP server 可读。
- 前提：**应用重启后 hook 配置才生效**（16:03 未重启触发时变量全 missing，16:16 重启后正常）。
- 当前 `C:/Users/86176/.zcode/cli/config.json` 已无 hooks 键（验证后清理，只剩 plugins/skills 两键）。

## 9. 兜底与健壮性要点（T2/T13 直接引用）

- 当前会话兜底：`SELECT id FROM session WHERE task_type='interactive' AND time_deleted IS NULL ORDER BY time_updated DESC LIMIT 1`，界面标注"推断"（ADR-0003）。
- db 是宿主活跃 WAL 库：只读打开可能偶发 `SQLITE_BUSY`——复制后查 or 重试 + `busy_timeout`；schema 漂移要容错（PRAGMA table_info 对比列存在性再查，缺列降级）。
- rollout 文件被清理属预期：组成类视图对旧会话显示"明细不可用"（ADR-0001）。
- 子代理会话 ID 形如 `sess_subagent_agent_<uuid>`，rollout 文件名与 db session.id 完全一致，直接字符串拼接。
