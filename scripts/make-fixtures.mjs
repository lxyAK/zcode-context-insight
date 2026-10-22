/**
 * 合成夹具生成脚本（T2 基线，后续工单在此追加行集）：
 *  - test/fixtures/db.sqlite：结构与真实宿主库 schema 一致（DDL 对照研究笔记 03 §2-§5），
 *    行集为手工设计的最小集，期望值见 test/session-usage.test.mjs 的手算常量。
 *  - test/fixtures/heartbeat.json：手工静态文件，直接落仓，不经本脚本。
 *  - test/fixtures/rollout/*.jsonl：T6 的 model-io 夹具，行结构对照研究笔记 03 §7
 *    （真实文件实测：头部 system 消息与 body.system 逐字重复；尾部可再出现 system 消息；
 *     tool/user 消息 content 为字符串；assistant 为 [{type,text}] 分块数组）。
 *    内容长度刻意选为 4 的倍数（纯 ASCII），使估算值可手算：
 *    估算规则 = ceil(ASCII/4) + ceil(CJK*2/3)，期望值见 test/request-detail.test.mjs。
 *
 * 红线：本脚本只写仓库内夹具路径，绝不触碰 ~/.zcode 真实库。
 * 幂等：每次删除重建。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(repoRoot, "test", "fixtures");
const dbPath = join(fixtureDir, "db.sqlite");

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
const S_MAIN = "session_00000000000000000000000000000001"; // interactive，time_updated 最新 → 兜底应选中
const S_OLD = "session_00000000000000000000000000000002"; // interactive，较旧
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003"; // subagent_child，time_updated 比 S_OLD 新 → 验证兜底必须过滤 task_type

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
db.exec("COMMIT");
db.close();

console.log(`夹具已生成: ${dbPath}`);

// =====================================================================
// rollout model-io 夹具（T6：请求明细 / Context Browser）
// =====================================================================

const rolloutDir = join(fixtureDir, "rollout");

/** 夹具请求 usage（rollout response.usage 为 camelCase，对照 03 笔记 §7） */
const usage = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

/** 夹具工具定义：JSON 序列化长度 Read=76 → 估算 19；Bash=78 → 估算 20 */
const TOOLS = [
  { name: "Read", description: "Read a file", input_schema: { type: "object" } },
  { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
];

/** 重复字符助手（长度刻意为 4 的倍数 → ASCII 估算 = len/4） */
const rep = (ch, n) => ch.repeat(n);

/**
 * 写 rollout 夹具：
 *  - S_MAIN：4 行（full / delta / full / tail），第一行 full 携带精心设计的块结构；
 *  - S_OLD：2 行纯 delta（纯 delta 会话 → 明细一律"无快照"）；
 *  - S_SUB：不生成文件（rollout 被清理的旧会话 → 明细不可用）。
 */
async function writeRolloutFixtures() {
  await rm(rolloutDir, { recursive: true, force: true });
  await mkdir(rolloutDir, { recursive: true });

  // --- S_MAIN 第 1 行：req-full-1，四分组块级结构的手算真值来源 ---
  // 块与估算（ASCII ceil(len/4)；CJK "当前轮请求正文"=7 字 → ceil(7*2/3)=5）：
  //   system 提示：A*40=10、B*80=20、尾部 S*20=5            → 小计 35，3 块
  //   工具定义：Read=19、Bash=20                             → 小计 39，2 块
  //   历史消息：user U*60=15、assistant(44+24)=11+6=17、tool D*100=25 → 小计 57，3 块
  //   当前轮：最后一条 user（CJK 7 字）=5                    → 小计 5，1 块
  //   估算合计 136；精确 usage.inputTokens=1200 → 校准系数 1200/136
  const full1 = {
    type: "model_io",
    sessionId: S_MAIN,
    requestId: "req-full-1",
    attempt: 1,
    startedAt: "2026-10-22T00:00:10.000Z",
    completedAt: "2026-10-22T00:00:16.000Z",
    durationMs: 6000,
    querySource: "main_turn",
    model: { modelId: "GLM-5.3", providerId: "account:fixture" },
    request: {
      body: {
        model: "GLM-5.3",
        system: [{ type: "text", text: rep("A", 40) }, { type: "text", text: rep("B", 80) }],
        tools: TOOLS,
      },
      messages: [
        { role: "system", content: rep("A", 40) }, // 与 body.system[0] 逐字重复（真实形态）
        { role: "system", content: rep("B", 80) },
        { role: "user", content: rep("U", 60) },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: rep("R", 44) },
            { type: "text", text: rep("T", 24) },
          ],
        },
        { role: "tool", toolCallId: "call_1", toolName: "Read", content: rep("D", 100) },
        { role: "system", content: rep("S", 20) }, // 尾部 system 提醒（真实形态：末尾可再出现 system）
        { role: "user", content: "当前轮请求正文" }, // 最后一条 user → 当前轮
      ],
      toolNames: ["Read", "Bash"],
      messageCount: 7,
      messagesKind: "full",
      messageOffset: 0,
    },
    response: {
      finishReason: "end_turn",
      usage: usage(1200, 80, 1000, 0),
    },
  };

  // --- S_MAIN 第 2 行：req-delta-1（delta：只带尾部增量，无快照） ---
  const delta1 = {
    type: "model_io",
    sessionId: S_MAIN,
    requestId: "req-delta-1",
    attempt: 1,
    startedAt: "2026-10-22T00:01:10.000Z",
    completedAt: "2026-10-22T00:01:13.000Z",
    durationMs: 3000,
    querySource: "main_turn",
    model: { modelId: "GLM-5.3", providerId: "account:fixture" },
    request: {
      body: { model: "GLM-5.3", system: [{ type: "text", text: rep("A", 40) }], tools: TOOLS },
      messages: [
        { role: "user", content: rep("X", 40) },
        { role: "assistant", content: [{ type: "text", text: rep("Y", 80) }] },
      ],
      toolNames: ["Read", "Bash"],
      messageCount: 8,
      messagesKind: "delta",
      messageOffset: 6,
    },
    response: { finishReason: "end_turn", usage: usage(800, 60, 600, 0) },
  };

  // --- S_MAIN 第 3 行：req-full-2（验证"当前轮=最后一条 user"，即使其后还有 system 提醒） ---
  const full2 = {
    type: "model_io",
    sessionId: S_MAIN,
    requestId: "req-full-2",
    attempt: 1,
    startedAt: "2026-10-22T00:02:10.000Z",
    completedAt: "2026-10-22T00:02:14.000Z",
    durationMs: 4000,
    querySource: "main_turn",
    model: { modelId: "GLM-5.3", providerId: "account:fixture" },
    request: {
      body: { model: "GLM-5.3", system: [{ type: "text", text: rep("C", 40) }], tools: [] },
      messages: [
        { role: "system", content: rep("C", 40) }, // 估算 10
        { role: "user", content: "Second turn question!" }, // 21 ASCII → 估算 6（当前轮）
        { role: "system", content: rep("M", 20) }, // 尾部提醒 → system 组（估算 5）
      ],
      toolNames: [],
      messageCount: 3,
      messagesKind: "full",
      messageOffset: 0,
    },
    response: { finishReason: "end_turn", usage: usage(400, 40, 0, 0) },
  };

  // --- S_MAIN 第 4 行：req-tail-1（tail 形态：同样不作组成基准） ---
  const tail1 = {
    type: "model_io",
    sessionId: S_MAIN,
    requestId: "req-tail-1",
    attempt: 1,
    startedAt: "2026-10-22T00:03:10.000Z",
    completedAt: "2026-10-22T00:03:15.000Z",
    durationMs: 5000,
    querySource: "main_turn",
    model: { modelId: "GLM-5.3", providerId: "account:fixture" },
    request: {
      body: { model: "GLM-5.3", system: [{ type: "text", text: rep("A", 40) }], tools: TOOLS },
      messages: [{ role: "user", content: rep("Z", 40) }],
      toolNames: ["Read", "Bash"],
      messageCount: 94,
      messagesKind: "tail",
      messageOffset: 30,
    },
    response: { finishReason: "end_turn", usage: usage(900, 70, 500, 0) },
  };

  // --- S_OLD：纯 delta 会话（两行均 delta） ---
  const oldDelta = (requestId, offset, count, startedAt) => ({
    type: "model_io",
    sessionId: S_OLD,
    requestId,
    attempt: 1,
    startedAt,
    completedAt: startedAt,
    durationMs: 1000,
    querySource: "main_turn",
    model: { modelId: "GLM-5.3", providerId: "account:fixture" },
    request: {
      body: { model: "GLM-5.3", system: [], tools: [] },
      messages: [{ role: "user", content: rep("O", 40) }],
      toolNames: [],
      messageCount: count,
      messagesKind: "delta",
      messageOffset: offset,
    },
    response: { finishReason: "end_turn", usage: usage(300, 30, 200, 0) },
  });

  const writeRolloutFile = async (sessionId, lines) => {
    const p = join(rolloutDir, `model-io-${sessionId}.jsonl`);
    await fsWriteFile(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    console.log(`夹具已生成: ${p}`);
  };

  await writeRolloutFile(S_MAIN, [full1, delta1, full2, tail1]);
  await writeRolloutFile(S_OLD, [
    oldDelta("req-old-1", 4, 6, "2026-10-21T00:00:10.000Z"),
    oldDelta("req-old-2", 6, 9, "2026-10-21T00:01:10.000Z"),
  ]);
}

await writeRolloutFixtures();
