/**
 * 合成夹具生成脚本（T2 db 基线 + rollout JSONL，后续工单在此追加行集）：
 *  - test/fixtures/db.sqlite：结构与真实宿主库 schema 一致（DDL 对照研究笔记 03 §2-§5），
 *    行集为手工设计的最小集，期望值见 test/session-usage.test.mjs 的手算常量。
 *  - test/fixtures/heartbeat.json：手工静态文件，直接落仓，不经本脚本。
 *  - test/fixtures/rollout/model-io-<sessionId>.jsonl：rollout JSONL 夹具，行结构对照研究
 *    笔记 03 §7（真实文件实测：头部 system 消息与 body.system 逐字重复；尾部可再出现
 *    system 消息；tool/user 消息 content 为字符串；assistant 为 [{type,text}] 分块数组）。
 *    两套行集并存（merge 约定：功能并集保留双方，code-review 阶段评估整合）：
 *    - S_MAIN（心跳当前会话，5 行）+ S_SUB（纯 delta + 坏行）：T3 组成估算行集，
 *      期望值见 test/composition.test.mjs 与 test/server.e2e.test.mjs 手算常量；
 *    - S_BROWSER（4 行 full/delta/full/tail）+ S_OLD（2 行纯 delta）：T6 请求序列/明细行集，
 *      内容长度刻意选为 4 的倍数（纯 ASCII）使估算可手算：
 *      T6 估算规则 = ceil(ASCII/4) + ceil(CJK*2/3)，期望值见 test/request-detail.test.mjs。
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
// ---- T8 追加（跨会话 KPI / 7 天趋势 / 篮选所需的多日期、多项目、多规模行集）----
// T0 = 2026-10-21T16:26:40Z（UTC 日 D0）；DAY = 86400000
const DAY = 86400000;
const S_DAY1 = "session_00000000000000000000000000000011"; // D-1（窗口内），项目 A，大规模 50000 token
const S_DAY3 = "session_00000000000000000000000000000012"; // D-3（窗口内），项目 B，两行共 3000
const S_DAY8 = "session_00000000000000000000000000000013"; // D-8（7 天窗口外），项目 B，500 token
const S_EMPTY = "session_00000000000000000000000000000014"; // D-1，项目 A，无任何 model_usage 行

/** 项目 B：与项目 A 不同的 project_id / directory（筛选下拉数据源） */
const PROJ_B = "proj_d-.opensource-other-project";
const DIR_B = "D:\\.opensource\\other-project";
// T11 合并调整：S_NEAR 原 ID 与 T6 的 S_BROWSER（…0005）撞号（S_BROWSER 不入 db、仅 rollout
// 与测试心跳注入，T6 语义前提是 …0005 不在 db 中），合并时按 T11 自己的"与既有会话错开"惯例改用 …0006
const S_NEAR = "session_00000000000000000000000000000006"; // interactive，time_updated 全场最新（T11）→ 无心跳兜底应选中；与心跳指向的 S_MAIN 错开，使"心跳会话 vs 推断会话"在夹具中可区分；带压缩历史且最近占用达阈值 90%（T11 接近压缩提醒场景；ID 与 T9 的 S_MULTI 及 T6 的 S_BROWSER 错开）
const S_MULTI = "session_00000000000000000000000000000004"; // interactive，T9 活跃数据行集：跨三个日历日、两个模型/供应商
const S_SUBSUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000004"; // subagent_child，parent=S_SUB → Fleet 树的孙代理层（T10）
// T6 请求明细专用会话（不在 db 中：测试经心跳注入，request-detail 默认会话解析只认心跳；
// 与 T3 的 S_MAIN 组成行集分文件并存，见文件头注释）
const S_BROWSER = "session_00000000000000000000000000000005";

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
  // S_NEAR（T11）：time_updated 全场最新 → 无心跳兜底选中它而非 S_MAIN
  stmt.run(S_NEAR, proj, null, S_NEAR, dir, "夹具接近压缩会话", "3.16.2", T0 + 80000, T0 + 90000, "interactive");
  // T9 跨日会话：time_updated（T0+30000）早于 S_MAIN（T0+60000），不破坏 T2 兜底选中 S_MAIN 的断言
  stmt.run(S_MULTI, proj, null, S_MULTI, dir, "夹具跨日会话（T9）", "3.16.2", T0 - 2 * 86400000, T0 + 30000, "interactive");
  // T10：孙代理挂在 S_SUB 之下（parent_id 链 S_MAIN → S_SUB → S_SUBSUB）
  stmt.run(S_SUBSUB, proj, S_SUB, S_SUBSUB, dir, "夹具孙代理会话", "3.16.2", T0 + 45000, T0 + 55000, "subagent_child");
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
  // S_SUBSUB（孙代理，T10）：先成功后失败两行。
  // 期望聚合（手算）：requests=2, input=1100(800+300), output=100(100+0),
  //   computedTotal=1200(900+300), durationMsTotal=1800(1500+300),
  //   errorRequests=1，lastRequestStatus='error'（mu_subsub_2 的 started_at 更晚）
  row("mu_subsub_1", S_SUBSUB, "turn_fixture_subsub", "subagent", "subagent_child",
    T0 + 48000, 1500, 600, 800, 100, 0, 0, 700, 900);
  row("mu_subsub_2", S_SUBSUB, "turn_fixture_subsub", "subagent", "subagent_child",
    T0 + 52000, 300, null, 300, 0, 0, 0, 250, 300,
    { status: "error", errorType: "mock_error" });
  // S_NEAR（T11）：一行 completed main_turn；最近上下文占用近似 = input 900（含缓存读 700），
  // 压缩阈值依据 preCompactTokenCount=1000（下方 part 行）→ 占用率 0.9 ≥ 0.8，触发接近压缩提醒。
  // S_NEAR 期望聚合：requests=1, input=900, output=100, reasoning=0,
  //   cacheRead=700, cacheWrite=0, computedTotal=1000, ttft=700。
  // 行时间置于 T9 的 91 天统计窗口之外（T0-100d）：T11 的压缩提醒与推断兜底均不依赖
  // 行时间在窗口内（ratio 只按会话过滤取最近 completed main_turn；兜底按 session.time_updated），
  // 避免破坏 T9 按日/模型/供应商的全库手算期望（T0-100d 亦在 T8 的 7 天窗口外）。
  const T_NEAR = T0 - 100 * 86400000;
  row("mu_near_1", S_NEAR, "turn_fixture_near", "main_turn", "interactive",
    T_NEAR + 20000, 1500, 700, 900, 100, 0, 0, 700, 1000);
}

/**
 * T9 活跃数据行集（全部挂 S_MULTI，不影响 T2 对 S_MAIN/S_OLD/S_SUB 的聚合断言）：
 *   mu_act_a：D0（T0 当日）  GLM-5.3 / account:fixture     main_turn 700
 *   mu_act_b：D0-1（前一日） GLM-4.7 / account:fixture-alt main_turn 300
 *   mu_act_c：D0-2（前两日） GLM-5.3 / account:fixture     main_turn 500
 *   mu_act_d：D0-2           GLM-4.7 / account:fixture-alt session_title 50（工具应按口径排除）
 * 按 91 天窗口、排除 session_title 后的手算期望见 test/activity-insights.test.mjs 注释。
 */
function insertActivityRows(db) {
  const stmt = db.prepare(
    `INSERT INTO model_usage (id, logical_request_id, session_id, turn_id, query_source,
       provider_id, model_id, task_type, status,
       started_at, completed_at, duration_ms, time_to_first_token_ms,
       input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'interactive', 'completed',
       ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  );
  const row = (id, source, provider, model, startedAt, dur, ttft, inp, out, total) =>
    stmt.run(id, `lrq_${id}`, S_MULTI, "turn_fixture_act", source, provider, model,
      startedAt, startedAt + dur, dur, ttft, inp, out, 0, total);

  row("mu_act_a", "main_turn", "account:fixture", "GLM-5.3", T0 + 30000, 1000, 500, 600, 100, 700);
  row("mu_act_b", "main_turn", "account:fixture-alt", "GLM-4.7", T0 - 86400000 + 3600000, 800, 400, 250, 50, 300);
  row("mu_act_c", "main_turn", "account:fixture", "GLM-5.3", T0 - 2 * 86400000 + 7200000, 1200, 600, 400, 100, 500);
  row("mu_act_d", "session_title", "account:fixture-alt", "GLM-4.7", T0 - 2 * 86400000 + 7800000, 300, 150, 40, 10, 50);
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

/**
 * message + part 行集（T4 压缩标记的权威来源，结构对照研究笔记 03 §5）：
 * S_MAIN 一条自动压缩 part；S_OLD 不放任何 part 行（T7 事件流测试的"空态"依据）。
 *
 * truePostCompactTokenCount 语义夹具（工单 T4 验收项）：
 *  - postCompactTokenCount = 350：含总结消息在内的 post 值（= truePost 300 + 总结消息约 50）；
 *  - truePostCompactTokenCount = 300：真实压缩后上下文 token 数。
 * 两者刻意取不同值，使"真实压缩后"与"含总结消息"两个口径在断言中可区分。
 * 手动压缩场景由 T7 的 part_t7_compact_2（S_MAIN，auto=false）覆盖。
 */
function insertMessageAndPart(db) {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("msg_fixture_1", S_MAIN, T0 + 9000, T0 + 9000,
    JSON.stringify({ role: "user", time: T0 + 9000 }), 1);
  // S_MAIN 的自动压缩（T4 时间线标记的主锚点）。S_OLD 刻意不放任何 part 行
  // （T7 事件流测试的"空态"依据）；手动压缩场景由 T7 的 part_t7_compact_2（S_MAIN）覆盖。
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("part_fixture_compact_1", "msg_fixture_1", S_MAIN, T0 + 55000, T0 + 55000,
    JSON.stringify({
      type: "compaction",
      auto: true, // 触发方式：自动
      trigger: "auto",
      phase: "done",
      compactReason: "approaching-context-limit",
      compactBoundary: {
        boundaryId: "cb_fixture_1",
        preCompactTokenCount: 1800,   // 压缩前 token（对照 mu_main_1/mu_main_2 的总量量级）
        postCompactTokenCount: 350,   // 含总结消息的 post 值
        truePostCompactTokenCount: 300, // 真实压缩后上下文 token
        summarizedMessageCount: 2,
        keptMessageCount: 1,
      },
    }), 2);
  // S_NEAR（T11）的压缩历史：preCompactTokenCount=1000 是该会话的实测压缩阈值代理。
  // 时间与 mu_near_1 同期（T0-100d，见 insertModelUsage 注释），保持"请求→压缩"先后自洽
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("msg_fixture_near", S_NEAR, T0 - 100 * 86400000 + 10000, T0 - 100 * 86400000 + 10000,
    JSON.stringify({ role: "user", time: T0 - 100 * 86400000 + 10000 }), 1);
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("part_fixture_compact_near", "msg_fixture_near", S_NEAR, T0 - 100 * 86400000 + 60000, T0 - 100 * 86400000 + 60000,
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
// rollout JSONL 夹具（T3 组成估算真值来源：S_MAIN + S_SUB）
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

// ============================================================================
// rollout model-io 夹具（T6：请求明细 / Context Browser，S_BROWSER + S_OLD）
// 估算规则与 T3 不同（T6 自带解析）：ceil(ASCII/4) + ceil(CJK×2/3)，
// 内容长度刻意选为 4 的倍数（纯 ASCII）→ 估算可手算，期望值见 test/request-detail.test.mjs。
// ============================================================================

/** T6 夹具请求 usage（rollout response.usage 为 camelCase，对照 03 笔记 §7） */
const t6Usage = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

/** T6 夹具工具定义：JSON 序列化长度 Read=76 → 估算 19；Bash=78 → 估算 20 */
const TOOLS = [
  { name: "Read", description: "Read a file", input_schema: { type: "object" } },
  { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
];

/** 重复字符助手（长度刻意为 4 的倍数 → ASCII 估算 = len/4） */
const rep = (ch, n) => ch.repeat(n);

/**
 * S_BROWSER 会话 rollout（4 行）：
 *  - 第 1 行 full 携带精心设计的四分组块级结构（手算真值来源）；
 *  - 第 2 行 delta（只带尾部增量，无快照）；
 *  - 第 3 行 full（验证"当前轮=最后一条 user"，即使其后还有 system 提醒）；
 *  - 第 4 行 tail（同样不作组成基准）。
 */
function buildBrowserRolloutLines() {
  // --- 第 1 行：req-full-1，四分组块级结构的手算真值来源 ---
  // 块与估算（ASCII ceil(len/4)；CJK "当前轮请求正文"=7 字 → ceil(7*2/3)=5）：
  //   system 提示：A*40=10、B*80=20、尾部 S*20=5            → 小计 35，3 块
  //   工具定义：Read=19、Bash=20                             → 小计 39，2 块
  //   历史消息：user U*60=15、assistant(44+24)=11+6=17、tool D*100=25 → 小计 57，3 块
  //   当前轮：最后一条 user（CJK 7 字）=5                    → 小计 5，1 块
  //   估算合计 136；精确 usage.inputTokens=1200 → 校准系数 1200/136
  const full1 = {
    type: "model_io",
    sessionId: S_BROWSER,
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
      usage: t6Usage(1200, 80, 1000, 0),
    },
  };

  // --- 第 2 行：req-delta-1（delta：只带尾部增量，无快照） ---
  const delta1 = {
    type: "model_io",
    sessionId: S_BROWSER,
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
    response: { finishReason: "end_turn", usage: t6Usage(800, 60, 600, 0) },
  };

  // --- 第 3 行：req-full-2（验证"当前轮=最后一条 user"，即使其后还有 system 提醒） ---
  const full2 = {
    type: "model_io",
    sessionId: S_BROWSER,
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
    response: { finishReason: "end_turn", usage: t6Usage(400, 40, 0, 0) },
  };

  // --- 第 4 行：req-tail-1（tail 形态：同样不作组成基准） ---
  const tail1 = {
    type: "model_io",
    sessionId: S_BROWSER,
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
    response: { finishReason: "end_turn", usage: t6Usage(900, 70, 500, 0) },
  };

  return [full1, delta1, full2, tail1];
}

/**
 * S_OLD：纯 delta 会话（两行均 delta → 明细一律"无快照"）。
 */
function buildOldRolloutLines() {
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
    response: { finishReason: "end_turn", usage: t6Usage(300, 30, 200, 0) },
  });
  return [
    oldDelta("req-old-1", 4, 6, "2026-10-21T00:00:10.000Z"),
    oldDelta("req-old-2", 6, 9, "2026-10-21T00:01:10.000Z"),
  ];
}

/**
 * 写 rollout 夹具（幂等：先清目录）。
 * 四份文件 = T3（S_MAIN/S_SUB）与 T6（S_BROWSER/S_OLD）行集并集：
 * S_SUB 与 S_SUBSUB 不在 T6 行集 / S_BROWSER 不在 T3 行集——缺文件本身也是
 * "rollout 被宿主清理"降级路径的夹具。
 */
async function writeRolloutFixtures() {
  await rm(rolloutDir, { recursive: true, force: true });
  await mkdir(rolloutDir, { recursive: true });

  const files = [
    // T3 组成估算（心跳当前会话 → S_MAIN；期望值见 composition.test.mjs / server.e2e.test.mjs）
    [`model-io-${S_MAIN}.jsonl`, buildMainRolloutLines()],
    [`model-io-${S_SUB}.jsonl`, buildSubRolloutLines()],
    // T6 请求序列 / 明细（S_BROWSER 经测试心跳注入；S_OLD 纯 delta）
    [`model-io-${S_BROWSER}.jsonl`, buildBrowserRolloutLines().map((l) => JSON.stringify(l))],
    [`model-io-${S_OLD}.jsonl`, buildOldRolloutLines().map((l) => JSON.stringify(l))],
  ];
  for (const [name, lines] of files) {
    const p = join(rolloutDir, name);
    await writeFile(p, lines.join("\n") + "\n", "utf8");
    console.log(`夹具已生成: ${p}`);
  }
}

await rm(dbPath, { force: true });
await mkdir(fixtureDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("BEGIN");
for (const ddl of DDL) db.exec(ddl);
insertSessions(db);
insertModelUsage(db);
insertActivityRows(db);
insertTurnUsage(db);
insertMessageAndPart(db);
insertT7Parts(db);
db.exec("COMMIT");
db.close();

await writeRolloutFixtures();

console.log(`夹具已生成: ${dbPath} + ${rolloutDir}{${S_MAIN.slice(0, 18)}…, ${S_OLD.slice(0, 18)}…, ${S_SUB.slice(0, 22)}…, ${S_BROWSER.slice(0, 18)}…}`);
