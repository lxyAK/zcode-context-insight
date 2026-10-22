/**
 * 合成夹具生成脚本（T2 db 基线 + T3 rollout JSONL，后续工单在此追加行集）：
 *  - test/fixtures/db.sqlite：结构与真实宿主库 schema 一致（DDL 对照研究笔记 03 §2-§5），
 *    行集为手工设计的最小集，期望值见 test/session-usage.test.mjs 的手算常量。
 *  - test/fixtures/heartbeat.json：手工静态文件，直接落仓，不经本脚本。
 *  - test/fixtures/rollout/model-io-<sessionId>.jsonl：rollout JSONL 夹具（T3），
 *    结构对照研究笔记 03 §7（内容脱敏合成），期望值见 test/composition.test.mjs 手算常量。
 *
 * 红线：本脚本只写仓库内夹具路径，绝不触碰 ~/.zcode 真实库。
 * 幂等：每次删除重建。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(repoRoot, "test", "fixtures");
const dbPath = join(fixtureDir, "db.sqlite");
const rolloutDir = join(fixtureDir, "rollout");

/** 夹具时间基准（固定毫秒，测试不依赖墙钟） */
const T0 = 1792600000000;

/** DDL：与真实 db.sqlite 一致（研究笔记 03 §2-§5 逐列对照） */
const DDL = [
  `CREATE TABLE session (
  id text primary key,
  project_id text not null,
  workspace_id text,
  parent_id text,
  slug text not null,
  directory text not null,
  path text,
  title text not null,
  version text not null,
  share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs text, revert text, permission text,
  time_created integer not null,
  time_updated integer not null,
  time_compacting integer,
  time_archived integer,
  task_type text not null default 'interactive',
  title_source text not null default 'first_input'
    check(title_source in ('default','first_input','generated','custom')),
  title_message_id text, time_title_updated integer, trace_id text,
  time_deleted integer,
  last_outcome text
)`,
  `CREATE TABLE model_usage (
  id text primary key,
  logical_request_id text not null,
  attempt_index integer not null default 0,
  session_id text not null references session(id),
  turn_id text,
  trace_id text, span_id text,
  assistant_message_id text, parent_user_message_id text,
  query_source text not null,
  provider_id text not null,
  model_id text not null,
  variant text, agent text,
  mode text,
  task_type text,
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, completed_at integer, duration_ms integer,
  first_token_at integer, time_to_first_token_ms integer, finish_reason text,
  tool_call_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  provider_total_tokens integer,
  computed_total_tokens integer not null default 0,
  retry_count integer, retryable integer,
  cancelled_by_user integer, context_exceeded integer,
  error_type text, error_code text, error_message text,
  raw_usage_json text, provider_metadata_json text
)`,
  `CREATE TABLE turn_usage (
  session_id text not null references session(id),
  turn_id text not null, trace_id text,
  user_message_id text,
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, first_model_start_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer,
  model_request_count integer not null default 0,
  model_retry_count integer, tool_call_count integer, tool_error_count integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer, computed_total_tokens integer,
  retryable integer, cancelled_by_user integer, context_exceeded integer,
  error_type text, error_code text,
  primary key(session_id, turn_id)
)`,
  `CREATE TABLE message (
  id text primary key, session_id text not null references session(id),
  time_created integer not null, time_updated integer not null,
  data text not null,
  sequence integer
)`,
  `CREATE TABLE part (
  id text primary key, message_id text not null references message(id),
  session_id text not null, time_created integer not null, time_updated integer not null,
  data text not null,
  sequence integer
)`,
];

/** 会话 ID（对照真实形态：主会话 session_<32hex>，子代理 sess_subagent_agent_<uuid>） */
const S_MAIN = "session_00000000000000000000000000000001"; // interactive，心跳夹具指向的会话
const S_OLD = "session_00000000000000000000000000000002"; // interactive，较旧
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003"; // subagent_child，time_updated 比 S_OLD 新 → 验证兜底必须过滤 task_type
const S_NEAR = "session_00000000000000000000000000000004"; // interactive，time_updated 全场最新（T11）→ 无心跳兜底应选中；与心跳指向的 S_MAIN 错开，使"心跳会话 vs 推断会话"在夹具中可区分；带压缩历史且最近占用达阈值 90%（T11 接近压缩提醒场景）

function insertSessions(db) {
  const stmt = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
       time_created, time_updated, task_type, title_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'first_input')`,
  );
  const dir = "D:\\.opensource\\zcode-context-insight";
  const proj = "proj_d-.opensource-zcode-context-insight";
  stmt.run(S_MAIN, proj, null, S_MAIN, dir, "夹具主会话（当前）", "3.16.2", T0, T0 + 60000, "interactive");
  stmt.run(S_OLD, proj, null, S_OLD, dir, "夹具旧会话", "3.16.2", T0, T0 + 30000, "interactive");
  stmt.run(S_SUB, proj, S_MAIN, S_SUB, dir, "夹具子代理会话", "3.16.2", T0, T0 + 50000, "subagent_child");
  stmt.run(S_NEAR, proj, null, S_NEAR, dir, "夹具接近压缩会话", "3.16.2", T0 + 80000, T0 + 90000, "interactive");
}

/**
 * model_usage 行集。S_MAIN 的期望聚合（全请求 6 行）：
 *   requests=6, input=4000, output=405, reasoning=50,
 *   cacheRead=3400, cacheWrite=100, computedTotal=4405,
 *   ttft 非空合计=4200（mu_main_5 失败行 ttft 为 NULL，SUM 不计）
 * 其中 main_turn 小计：requests=5, input=3990, output=400, computedTotal=4390；
 * session_title 小计：requests=1, input=10, output=5, computedTotal=15。
 * T5 统计口径期望（手算，见 test/session-stats.test.mjs 注释）：
 *   缓存命中率 = cacheRead/input = 3400/4000 = 0.85；
 *   重试计数 = SUM(retry_count) = mu_main_4 的 2；
 *   超限计数 = SUM(context_exceeded) = mu_main_5 的 1；
 *   TTFT 样本（非空排序）[200,600,900,1000,1500]，n=5。
 */
function insertModelUsage(db) {
  const stmt = db.prepare(
    `INSERT INTO model_usage (id, logical_request_id, session_id, turn_id, query_source,
       provider_id, model_id, task_type, status,
       started_at, completed_at, duration_ms, time_to_first_token_ms,
       input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens,
       retry_count, retryable, context_exceeded, error_type)
     VALUES (?, ?, ?, ?, ?, 'account:fixture', 'GLM-5.3', ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const row = (id, session, turn, source, taskType, startedAt, dur, ttft, inp, out, reason, cacheW, cacheR, total,
    extra = {}) =>
    stmt.run(id, `lrq_${id}`, session, turn, source, taskType, extra.status ?? "completed",
      startedAt, startedAt + dur, dur, ttft, inp, out, reason, cacheW, cacheR, total,
      extra.retryCount ?? null, extra.retryable ?? null, extra.contextExceeded ?? null, extra.errorType ?? null);

  // S_MAIN：四次 main_turn + 一次 session_title + 一次失败的超限请求
  row("mu_main_1", S_MAIN, "turn_fixture_1", "main_turn", "interactive",
    T0 + 10000, 5000, 1500, 1000, 200, 50, 100, 800, 1200);
  row("mu_main_2", S_MAIN, "turn_fixture_1", "main_turn", "interactive",
    T0 + 20000, 3000, 1000, 500, 100, 0, 0, 400, 600);
  row("mu_main_3", S_MAIN, null, "session_title", "interactive",
    T0 + 5000, 200, 200, 10, 5, 0, 0, 0, 15);
  // T5 重试场景：重试 2 次后成功（retry_count 计入会话重试总数）
  row("mu_main_4", S_MAIN, "turn_fixture_4", "main_turn", "interactive",
    T0 + 30000, 2500, 900, 400, 80, 0, 0, 300, 480,
    { retryCount: 2, retryable: 1 });
  // T5 上下文超限场景：error 行无首 token（ttft NULL，不进 TTFT 分布）
  row("mu_main_5", S_MAIN, "turn_fixture_5", "main_turn", "interactive",
    T0 + 40000, 1200, null, 2000, 0, 0, 0, 1900, 2000,
    { status: "error", contextExceeded: 1, errorType: "context_length_exceeded" });
  row("mu_main_6", S_MAIN, "turn_fixture_6", "main_turn", "interactive",
    T0 + 45000, 800, 600, 90, 20, 0, 0, 0, 110);
  // S_OLD：一行
  row("mu_old_1", S_OLD, "turn_fixture_old", "main_turn", "interactive",
    T0 + 1000, 2000, 800, 300, 50, 0, 0, 250, 350);
  // S_SUB（子代理）：一行，验证聚合按 session_id 隔离
  row("mu_sub_1", S_SUB, "turn_fixture_sub", "subagent", "subagent_child",
    T0 + 40000, 4000, 900, 2000, 300, 0, 0, 1500, 2300);
  // S_NEAR（T11）：一行 completed main_turn；最近上下文占用近似 = input 900（含缓存读 700），
  // 压缩阈值依据 preCompactTokenCount=1000（下方 part 行）→ 占用率 0.9 ≥ 0.8，触发接近压缩提醒。
  // S_NEAR 期望聚合：requests=1, input=900, output=100, reasoning=0,
  //   cacheRead=700, cacheWrite=0, computedTotal=1000, ttft=700。
  row("mu_near_1", S_NEAR, "turn_fixture_near", "main_turn", "interactive",
    T0 + 85000, 1500, 700, 900, 100, 0, 0, 700, 1000);
}

function insertTurnUsage(db) {
  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, duration_ms,
       time_to_first_token_ms, model_request_count, tool_call_count,
       input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(S_MAIN, "turn_fixture_1", T0 + 10000, T0 + 23000, 13000, 1250, 2, 1, 1500, 300, 50, 100, 1200, 1800);
}

/** message + part 最小行集：一条 user 消息 + 一条 compaction part（T4 压缩标记的锚点示例） */
function insertMessageAndPart(db) {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("msg_fixture_1", S_MAIN, T0 + 9000, T0 + 9000,
    JSON.stringify({ role: "user", time: T0 + 9000 }), 1);
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("part_fixture_compact_1", "msg_fixture_1", S_MAIN, T0 + 55000, T0 + 55000,
    JSON.stringify({
      type: "compaction",
      auto: true,
      compactBoundary: {
        boundaryId: "cb_fixture_1",
        preCompactTokenCount: 1800,
        postCompactTokenCount: 300,
        truePostCompactTokenCount: 300,
        summarizedMessageCount: 2,
        keptMessageCount: 1,
      },
    }), 2);
  // S_NEAR（T11）的压缩历史：preCompactTokenCount=1000 是该会话的实测压缩阈值代理
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("msg_fixture_near", S_NEAR, T0 + 82000, T0 + 82000,
    JSON.stringify({ role: "user", time: T0 + 82000 }), 1);
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("part_fixture_compact_near", "msg_fixture_near", S_NEAR, T0 + 86000, T0 + 86000,
    JSON.stringify({
      type: "compaction",
      auto: true,
      compactBoundary: {
        boundaryId: "cb_fixture_near",
        preCompactTokenCount: 1000,
        postCompactTokenCount: 200,
        truePostCompactTokenCount: 200,
        summarizedMessageCount: 3,
        keptMessageCount: 1,
      },
    }), 2);
}

/**
 * T7 行集：事件流（model_change timeline + 第二条 compaction）与文件活动（tool part）。
 * 数据形状对照真实宿主库实测（研究笔记 03 §5）：
 *  - timeline：{type:'timeline', timelineType:'model_change', toModelSelection:{providerId,modelId,label}, toModel:{providerID,modelID}}
 *  - compaction：{type:'compaction', auto:bool, trigger:'manual'|'auto', compactBoundary:{pre/post/truePost/summarized/kept}}
 *  - tool：{type:'tool', tool:'Read|Write|Edit|Grep|Glob|Bash', state:{status, input:{file_path|path+pattern|content|old_string+new_string}}}
 *
 * 注意：行按"时间乱序"插入（compaction_2 先于 compact_1、tl GLM-5.4 先于 GLM-5.3、tool 乱序），
 * 测试据此证明排序由查询层完成而非落库顺序。
 *
 * S_MAIN 期望（手算，测试常量的真值来源）：
 *  - 事件流（时间升序）：
 *      1) model_change @T0+15000 → GLM-5.3
 *      2) model_change @T0+35000 → GLM-5.4
 *      3) compaction  @T0+55000 trigger=auto（part_fixture_compact_1：1800→300，总结 2 保留 1）
 *      4) compaction  @T0+58000 trigger=manual（4000→900/truePost 500，总结 5 保留 2）
 *  - 文件活动（时间升序，行数按 \n 分割计、空串 0 行）：
 *      1) read  @T0+16000 D:\repo\src\a.ts（无行数）
 *      2) search@T0+17000 D:\repo\src pattern=handleRequest（Grep）
 *      3) edit  @T0+18000 D:\repo\src\a.ts +4/-3（old 3 行 → new 4 行）
 *      4) write @T0+19000 D:\repo\out\new.ts +5（content 5 行）
 *      5) search@T0+20000 D:\repo pattern=*.ts（Glob）
 *      6) edit  @T0+21000 D:\repo\src\missing.ts +1/-0 status=error（old 空串 0 行，new 1 行）
 *      （Bash @T0+22000 不属于文件活动，必须被排除）
 *  - S_OLD 无任何 part 行 → 事件流与文件活动均为空数组（空态）。
 */
function insertT7Parts(db) {
  const part = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const msg = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // 工具 part 挂在 assistant 消息上（与真实形态一致）
  msg.run("msg_fixture_2", S_MAIN, T0 + 12000, T0 + 12000,
    JSON.stringify({ role: "assistant", time: T0 + 12000, model: "GLM-5.3" }), 2);

  // —— 事件流行（乱序插入：先 35000 的 GLM-5.4，再 15000 的 GLM-5.3；manual 压缩先于 auto 压缩）——
  part.run("part_t7_tl_glm54", "msg_fixture_2", S_MAIN, T0 + 35000, T0 + 35000,
    JSON.stringify({
      type: "timeline",
      timelineType: "model_change",
      display: "separator",
      status: "completed",
      time: { start: T0 + 35000, end: T0 + 35000 },
      toModel: { providerID: "account:fixture", modelID: "GLM-5.4", variant: "max", label: "account:fixture/GLM-5.4" },
      toModelSelection: { providerId: "account:fixture", modelId: "GLM-5.4", options: { reasoningLevel: "max" }, label: "account:fixture/GLM-5.4" },
    }), 11);
  part.run("part_t7_tl_glm53", "msg_fixture_2", S_MAIN, T0 + 15000, T0 + 15000,
    JSON.stringify({
      type: "timeline",
      timelineType: "model_change",
      display: "separator",
      status: "completed",
      time: { start: T0 + 15000, end: T0 + 15000 },
      toModel: { providerID: "account:fixture", modelID: "GLM-5.3", label: "account:fixture/GLM-5.3" },
      toModelSelection: { providerId: "account:fixture", modelId: "GLM-5.3", label: "account:fixture/GLM-5.3" },
    }), 10);
  part.run("part_t7_compact_2", "msg_fixture_1", S_MAIN, T0 + 58000, T0 + 58000,
    JSON.stringify({
      type: "compaction",
      auto: false,
      trigger: "manual",
      compactBoundary: {
        boundaryId: "cb_fixture_2",
        preCompactTokenCount: 4000,
        postCompactTokenCount: 900,
        truePostCompactTokenCount: 500,
        summarizedMessageCount: 5,
        keptMessageCount: 2,
      },
    }), 20);

  // —— 文件活动行（tool part，乱序插入）——
  const tool = (id, time, toolName, input, status = "completed", sequence) =>
    part.run(id, "msg_fixture_2", S_MAIN, time, time,
      JSON.stringify({ type: "tool", callID: `call_${id}`, tool: toolName, state: { status, input } }), sequence);

  tool("part_t7_tool_edit_1", T0 + 18000, "Edit",
    { file_path: "D:\\repo\\src\\a.ts", old_string: "a\nb\nc", new_string: "a\nx\nc\nd" }, "completed", 31);
  tool("part_t7_tool_read_1", T0 + 16000, "Read",
    { file_path: "D:\\repo\\src\\a.ts" }, "completed", 30);
  tool("part_t7_tool_bash_1", T0 + 22000, "Bash",
    { command: "npm test" }, "completed", 36);
  tool("part_t7_tool_glob_1", T0 + 20000, "Glob",
    { pattern: "*.ts", path: "D:\\repo" }, "completed", 34);
  tool("part_t7_tool_write_1", T0 + 19000, "Write",
    { file_path: "D:\\repo\\out\\new.ts", content: "l1\nl2\nl3\nl4\nl5" }, "completed", 32);
  tool("part_t7_tool_edit_2", T0 + 21000, "Edit",
    { file_path: "D:\\repo\\src\\missing.ts", old_string: "", new_string: "only" }, "error", 35);
  tool("part_t7_tool_grep_1", T0 + 17000, "Grep",
    { pattern: "handleRequest", path: "D:\\repo\\src" }, "completed", 33);
}

// ============================================================================
// rollout JSONL 夹具（T3 组成估算真值来源）
//
// 启发式折算口径（与被测实现一致的规格声明）：
//   tokens(text) = ceil(ASCII 字符数 / 4) + CJK 字符数 × 1
// 锚点校准：scale = anchor.usage.inputTokens / Σraw；各组 floor(raw×scale) 后按
// 最大余数法补齐差值（余数并列按 system→tools→history→currentTurn 组序），保证
// Σcalibrated === anchor.usage.inputTokens。
//
// 工具定义（JSON.stringify 序列化后精确字符数已离线核验）：
//   TOOL1 序列化 245 字符（全 ASCII）→ ceil(245/4) = 62 tokens
//   TOOL2 序列化 145 字符（全 ASCII）→ ceil(145/4) = 37 tokens
const TOOL1 = { name: "Read", description: "d".repeat(120), input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const TOOL2 = { name: "Bash", description: "d".repeat(80), input_schema: { type: "object" } };

/** 构造一行 rollout 记录（结构对照真实 model-io JSONL，研究笔记 03 §7） */
function rolloutLine({ requestId, startedAt, kind, offset, messages, usage, systemBlocks = [], tools = [TOOL1, TOOL2], querySource = "main_turn", sessionId }) {
  return JSON.stringify({
    type: "model_io",
    sessionId,
    requestId,
    attempt: 1,
    startedAt,
    completedAt: startedAt, // 简化：夹具不断言完成时间
    querySource,
    model: { modelId: "GLM-5.3", providerId: "account:fixture" },
    request: {
      body: { model: "GLM-5.3", max_tokens: 4096, system: systemBlocks, tools, stream: true },
      messages,
      toolNames: tools.map((t) => t.name),
      // 语义契约：messages 携带会话消息流的 [messageOffset, messageCount) 区间
      messageCount: offset + messages.length,
      messagesKind: kind,
      messageOffset: offset,
    },
    response: { finishReason: "tool_calls", usage },
  });
}

const usage = (inputTokens, outputTokens, cacheReadTokens) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
});

/** 简写构造器：system/user/tool 为字符串 content，assistant 为分块数组 */
const sysMsg = (text) => ({ role: "system", content: text, cacheControl: "ephemeral" });
const userMsg = (text) => ({ role: "user", content: text });
const toolMsg = (text) => ({ role: "tool", content: text, toolCallId: "call_fixture", toolName: "Read" });
const textMsg = (role, text) => ({ role, content: [{ type: "text", text }] });
const reasoningMsg = (reasoningLen, textLen) => ({
  role: "assistant",
  content: [
    { type: "reasoning", text: "r".repeat(reasoningLen) },
    { type: "text", text: "a".repeat(textLen) },
  ],
});

/**
 * S_MAIN 主会话 rollout（5 行：full / delta / full(锚点,压缩后) / delta / tail）。
 *
 * 锚点 = 第 3 行（req-main-3，messagesKind=full，压缩后完整快照）四分组原始折算推导：
 *  - system 组 = body.system 块 + messages 中 role=system 的消息
 *      'S'×100（ASCII）→ ceil(100/4)=25；'系统提示'×6（24 个 CJK）→ 24
 *      'm'×40 → 10；'摘要'×31（62 个 CJK，压缩摘要消息）→ 62            合计 121
 *  - tools 组 = TOOL1(62) + TOOL2(37)                                    合计 99
 *  - history 组 = 最后一条 user 之前的非 system 消息：
 *      '任务'×10（20 CJK）→ 20；'a'×200 → 50；'t'×400 → 100             合计 170
 *  - currentTurn 组 = 最后一条 user（'q'×80 → 20）及其后：
 *      reasoning 'r'×40 → 10 + text 'a'×80 → 20；'t'×240 → 60           合计 110
 *  Σraw = 500；锚点 usage.inputTokens = 625 → scale = 1.25
 *  校准：floor 值 151/123/212/137（和 623），余 2 按最大余数（tools .75 > history .5
 *  = currentTurn .5 > system .25，并列按组序）补 tools→124、history→213
 *  → calibrated = { system:151, tools:124, history:213, currentTurn:137 }，Σ = 625
 */
function buildMainRolloutLines() {
  return [
    // 第 1 行：turn 1 首次请求，完整快照（早于压缩）
    rolloutLine({
      sessionId: S_MAIN,
      requestId: "req-main-1",
      startedAt: "2026-10-22T08:00:00.000Z",
      kind: "full",
      offset: 0,
      systemBlocks: [{ type: "text", text: "S".repeat(100) }],
      messages: [sysMsg("m".repeat(40)), userMsg("q".repeat(80))],
      usage: usage(300, 50, 250),
    }),
    // 第 2 行：turn 1 续发，只带尾部增量（前 2 条已缓存）
    rolloutLine({
      sessionId: S_MAIN,
      requestId: "req-main-2",
      startedAt: "2026-10-22T08:00:10.000Z",
      kind: "delta",
      offset: 2,
      messages: [textMsg("assistant", "a".repeat(120)), toolMsg("t".repeat(240))],
      usage: usage(450, 30, 420),
    }),
    // 第 3 行（锚点）：压缩发生后宿主重发完整上下文；idx4 的 system 消息为压缩摘要
    rolloutLine({
      sessionId: S_MAIN,
      requestId: "req-main-3",
      startedAt: "2026-10-22T08:00:30.000Z",
      kind: "full",
      offset: 0,
      systemBlocks: [
        { type: "text", text: "S".repeat(100) },
        { type: "text", text: "系统提示".repeat(6) },
      ],
      messages: [
        sysMsg("m".repeat(40)), // idx0 → system 组（10）
        userMsg("任务".repeat(10)), // idx1 → 历史消息（20）
        textMsg("assistant", "a".repeat(200)), // idx2 → 历史消息（50）
        toolMsg("t".repeat(400)), // idx3 → 历史消息（100）
        sysMsg("摘要".repeat(31)), // idx4 压缩摘要 → system 组（62）
        userMsg("q".repeat(80)), // idx5 最后一条 user → 当前轮（20）
        reasoningMsg(40, 80), // idx6 → 当前轮（10+20）
        toolMsg("t".repeat(240)), // idx7 → 当前轮（60）
      ],
      usage: usage(625, 100, 575),
    }),
    // 第 4 行：turn 续发增量（锚点后第 1 条 delta，offset=8）
    rolloutLine({
      sessionId: S_MAIN,
      requestId: "req-main-4",
      startedAt: "2026-10-22T08:00:40.000Z",
      kind: "delta",
      offset: 8,
      messages: [textMsg("assistant", "x".repeat(80))],
      usage: usage(700, 20, 680),
    }),
    // 第 5 行：tail 中间形态（最后一条请求，但非 full——不得被选为锚点）
    rolloutLine({
      sessionId: S_MAIN,
      requestId: "req-main-5",
      startedAt: "2026-10-22T08:00:50.000Z",
      kind: "tail",
      offset: 4,
      messages: [userMsg("u".repeat(60)), textMsg("assistant", "y".repeat(100)), toolMsg("z".repeat(120))],
      usage: usage(800, 10, 790),
    }),
  ];
}

/**
 * S_SUB 子代理会话 rollout：纯 delta/tail（无 full 快照）+ 1 行损坏 JSON。
 * 期望（test/composition.test.mjs）：解析记录 2 行（损坏行跳过），anchor=null，
 * compositionReason='no-full-snapshot'，精确总量取末行 usage.inputTokens=520。
 */
function buildSubRolloutLines() {
  return [
    "{ broken json（模拟宿主写一半崩溃的行）",
    rolloutLine({
      sessionId: S_SUB,
      requestId: "req-sub-1",
      startedAt: "2026-10-22T08:01:00.000Z",
      kind: "delta",
      offset: 6,
      querySource: "subagent",
      messages: [textMsg("assistant", "b".repeat(100)), toolMsg("t".repeat(200))],
      usage: usage(500, 40, 460),
    }),
    rolloutLine({
      sessionId: S_SUB,
      requestId: "req-sub-2",
      startedAt: "2026-10-22T08:01:10.000Z",
      kind: "tail",
      offset: 6,
      querySource: "subagent",
      messages: [textMsg("assistant", "c".repeat(80))],
      usage: usage(520, 5, 500),
    }),
  ];
}

/** 写 rollout 夹具文件（幂等：先清目录） */
async function writeRolloutFixtures() {
  await rm(rolloutDir, { recursive: true, force: true });
  await mkdir(rolloutDir, { recursive: true });
  const files = [
    [`model-io-${S_MAIN}.jsonl`, buildMainRolloutLines()],
    [`model-io-${S_SUB}.jsonl`, buildSubRolloutLines()],
  ];
  for (const [name, lines] of files) {
    await writeFile(join(rolloutDir, name), lines.join("\n") + "\n", "utf8");
  }
}

await rm(dbPath, { force: true });
await mkdir(fixtureDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("BEGIN");
for (const ddl of DDL) db.exec(ddl);
insertSessions(db);
insertModelUsage(db);
insertTurnUsage(db);
insertMessageAndPart(db);
insertT7Parts(db);
db.exec("COMMIT");
db.close();

await writeRolloutFixtures();

console.log(`夹具已生成: ${dbPath} + ${rolloutDir}{${S_MAIN.slice(0, 18)}…, ${S_SUB.slice(0, 22)}…}`);
