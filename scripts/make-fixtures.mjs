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
const S_MAIN = "session_00000000000000000000000000000001"; // interactive，time_updated 最新 → 兜底应选中
const S_OLD = "session_00000000000000000000000000000002"; // interactive，较旧
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003"; // subagent_child，time_updated 比 S_OLD 新 → 验证兜底必须过滤 task_type
// ---- T8 追加（跨会话 KPI / 7 天趋势 / 筛选所需的多日期、多项目、多规模行集）----
// T0 = 2026-10-21T16:26:40Z（UTC 日 D0）；DAY = 86400000
const DAY = 86400000;
const S_DAY1 = "session_00000000000000000000000000000011"; // D-1（窗口内），项目 A，大规模 50000 token
const S_DAY3 = "session_00000000000000000000000000000012"; // D-3（窗口内），项目 B，两行共 3000
const S_DAY8 = "session_00000000000000000000000000000013"; // D-8（7 天窗口外），项目 B，500 token
const S_EMPTY = "session_00000000000000000000000000000014"; // D-1，项目 A，无任何 model_usage 行

/** 项目 B：与项目 A 不同的 project_id / directory（筛选下拉数据源） */
const PROJ_B = "proj_d-.opensource-other-project";
const DIR_B = "D:\\.opensource\\other-project";

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
  // T8 追加会话：跨 4 个活跃日（D0 / D-1 / D-3 / D-8）、两个项目、多种规模
  stmt.run(S_DAY1, proj, null, S_DAY1, dir, "夹具项目A大会话", "3.16.2", T0 - DAY + 3600000, T0 - DAY + 7200000, "interactive");
  stmt.run(S_DAY3, PROJ_B, null, S_DAY3, DIR_B, "夹具项目B会话", "3.16.2", T0 - 3 * DAY + 3600000, T0 - 3 * DAY + 7200000, "interactive");
  stmt.run(S_DAY8, PROJ_B, null, S_DAY8, DIR_B, "夹具项目B旧会话", "3.16.2", T0 - 8 * DAY + 3600000, T0 - 8 * DAY + 7200000, "interactive");
  stmt.run(S_EMPTY, proj, null, S_EMPTY, dir, "夹具零用量会话", "3.16.2", T0 - DAY + 7000000, T0 - DAY + 8000000, "interactive");
}

/**
 * model_usage 行集。S_MAIN 的期望聚合（全请求）：
 *   requests=3, input=1510, output=305, reasoning=50,
 *   cacheRead=1200, cacheWrite=100, computedTotal=1815, ttftMs=2700
 * 其中 main_turn 小计：requests=2, input=1500, output=300, computedTotal=1800；
 * session_title 小计：requests=1, input=10, output=5, computedTotal=15。
 */
function insertModelUsage(db) {
  const stmt = db.prepare(
    `INSERT INTO model_usage (id, logical_request_id, session_id, turn_id, query_source,
       provider_id, model_id, task_type, status,
       started_at, completed_at, duration_ms, time_to_first_token_ms,
       input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, ?, ?, ?, ?, 'account:fixture', 'GLM-5.3', ?, 'completed',
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const row = (id, session, turn, source, taskType, startedAt, dur, ttft, inp, out, reason, cacheW, cacheR, total) =>
    stmt.run(id, `lrq_${id}`, session, turn, source, taskType, startedAt, startedAt + dur, dur, ttft, inp, out, reason, cacheW, cacheR, total);

  // S_MAIN：两次 main_turn + 一次 session_title
  row("mu_main_1", S_MAIN, "turn_fixture_1", "main_turn", "interactive",
    T0 + 10000, 5000, 1500, 1000, 200, 50, 100, 800, 1200);
  row("mu_main_2", S_MAIN, "turn_fixture_1", "main_turn", "interactive",
    T0 + 20000, 3000, 1000, 500, 100, 0, 0, 400, 600);
  row("mu_main_3", S_MAIN, null, "session_title", "interactive",
    T0 + 5000, 200, 200, 10, 5, 0, 0, 0, 15);
  // S_OLD：一行
  row("mu_old_1", S_OLD, "turn_fixture_old", "main_turn", "interactive",
    T0 + 1000, 2000, 800, 300, 50, 0, 0, 250, 350);
  // S_SUB（子代理）：一行，验证聚合按 session_id 隔离
  row("mu_sub_1", S_SUB, "turn_fixture_sub", "subagent", "subagent_child",
    T0 + 40000, 4000, 900, 2000, 300, 0, 0, 1500, 2300);
  // ---- T8 追加行集（手算期望值见 test/insights.test.mjs 顶部注释）----
  // S_DAY1：D-1 单行 50000（大规模，验证 minTokens 筛选与 sort=tokens）
  row("mu_day1_1", S_DAY1, "turn_fixture_day1", "main_turn", "interactive",
    T0 - DAY + 3700000, 3000, 800, 48000, 2000, 0, 0, 0, 50000);
  // S_DAY3：D-3 两行共 3000
  row("mu_day3_1", S_DAY3, "turn_fixture_day3", "main_turn", "interactive",
    T0 - 3 * DAY + 3700000, 2000, 700, 900, 100, 0, 0, 0, 1000);
  row("mu_day3_2", S_DAY3, "turn_fixture_day3", "main_turn", "interactive",
    T0 - 3 * DAY + 6500000, 2000, 600, 1900, 100, 0, 0, 0, 2000);
  // S_DAY8：D-8 单行 500（在 7 天窗口 [D-6, D0] 之外，验证趋势窗口边界）
  row("mu_day8_1", S_DAY8, "turn_fixture_day8", "main_turn", "interactive",
    T0 - 8 * DAY + 3700000, 1000, 500, 480, 20, 0, 0, 0, 500);
  // S_EMPTY：无任何行（验证 LEFT JOIN 语义：requests=0 / totalTokens=0 仍出现在会话列表）
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
