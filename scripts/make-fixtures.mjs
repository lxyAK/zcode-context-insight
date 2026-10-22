/**
 * 合成夹具生成脚本（T2 基线，后续工单在此追加行集）：
 *  - test/fixtures/db.sqlite：结构与真实宿主库 schema 一致（DDL 对照研究笔记 03 §2-§5），
 *    行集为手工设计的最小集，期望值见 test/session-usage.test.mjs 的手算常量。
 *  - test/fixtures/heartbeat.json：手工静态文件，直接落仓，不经本脚本。
 *
 * 红线：本脚本只写仓库内夹具路径，绝不触碰 ~/.zcode 真实库。
 * 幂等：每次删除重建。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
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
