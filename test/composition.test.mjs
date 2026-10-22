/**
 * T3 组成估算功能缝基线（工单预先约定的缝：in-process 直调工具 execute + 解析底座公共函数）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 生成的 rollout 夹具行集与
 * 夹具内注释的字符构造），不经被测代码路径反推——夹具即真值来源。
 *
 * 红线对照：所有测试读写 test/fixtures 合成夹具与临时目录，绝不触碰 ~/.zcode 真实数据。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");
const fixtureHeartbeat = join(repoRoot, "test", "fixtures", "heartbeat.json");
const fixtureRolloutDir = join(repoRoot, "test", "fixtures", "rollout");

// 夹具会话 ID（与 scripts/make-fixtures.mjs 保持同源常量）
const S_MAIN = "session_00000000000000000000000000000001";
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003";

/** 最小合法行（字段缺省走容错默认值） */
function line(overrides = {}) {
  return JSON.stringify({
    type: "model_io",
    sessionId: S_MAIN,
    requestId: "req-fixture",
    startedAt: "2026-10-22T08:00:00.000Z",
    querySource: "main_turn",
    request: {
      body: { system: [], tools: [] },
      messages: [],
      messageCount: 0,
      messagesKind: "full",
      messageOffset: 0,
    },
    response: { usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ...overrides,
  });
}

/** 写临时 rollout 文件，返回路径（调用方负责清理目录） */
function writeRollout(dir, sessionId, lines) {
  mkdirSync(join(dir, "rollout"), { recursive: true });
  const p = join(dir, "rollout", `model-io-${sessionId}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

describe("rollout 解析底座（readRolloutFile / 分类与容错）", () => {
  it("识别 messagesKind 三态与 messageOffset 语义，坏行跳过不致命", async () => {
    const { readRolloutFile } = await import("../src/server/rollout.ts");
    const dir = mkdtempSync(join(tmpdir(), "zci-rollout-"));
    try {
      const p = writeRollout(dir, S_MAIN, [
        line({ requestId: "r1", request: { body: {}, messages: [], messageCount: 2, messagesKind: "full", messageOffset: 0 } }),
        "{ 这不是 JSON（模拟宿主写一半崩溃的行）",
        line({ requestId: "r2", request: { body: {}, messages: [{ role: "assistant", content: "x" }], messageCount: 3, messagesKind: "delta", messageOffset: 2 } }),
        line({ requestId: "r3", request: { body: {}, messages: [], messageCount: 9, messagesKind: "tail", messageOffset: 4 } }),
        line({ requestId: "r4", request: { body: {}, messages: [], messageCount: 1, messagesKind: "weird-future-kind", messageOffset: 0 } }), // 未知 kind 容错归 other
      ]);
      const res = readRolloutFile(p);
      expect(res.ok).toBe(true);
      // 坏行不计入记录
      expect(res.records).toHaveLength(4);
      expect(res.records.map((r) => r.messagesKind)).toEqual(["full", "delta", "tail", "weird-future-kind"]);
      // messageOffset 语义：携带消息 = 会话流的 [offset, messageCount) 区间
      expect(res.records[1].messageOffset).toBe(2);
      expect(res.records[1].messages).toHaveLength(1);
      expect(res.records[1].messageCount).toBe(3);
      expect(res.records.map((r) => r.requestId)).toEqual(["r1", "r2", "r3", "r4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺文件与空文件：机器可读原因，不抛错", async () => {
    const { readRolloutFile } = await import("../src/server/rollout.ts");
    const missing = readRolloutFile(join(tmpdir(), "zci-absent", "model-io-x.jsonl"));
    expect(missing).toEqual({ ok: false, reason: "rollout-not-found" });

    const dir = mkdtempSync(join(tmpdir(), "zci-rollout-"));
    try {
      const p = writeRollout(dir, S_MAIN, ["", "   ", "{ broken"]);
      expect(readRolloutFile(p)).toEqual({ ok: false, reason: "rollout-empty" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("路径 env 缝：ZCI_ROLLOUT_DIR 覆盖 → ZCI_HOME 兜底 → 宿主默认", async () => {
    const { resolveRolloutDir, resolveRolloutPath } = await import("../src/server/paths.ts");
    expect(resolveRolloutDir({ ZCI_ROLLOUT_DIR: "D:/custom/rollout" })).toBe("D:/custom/rollout");
    expect(resolveRolloutDir({ ZCI_HOME: "C:/Users/fake" })).toBe(join("C:/Users/fake", ".zcode", "cli", "rollout"));
    // 文件名直拼契约：model-io-<sessionId>.jsonl（研究笔记 03 §7）
    expect(resolveRolloutPath(S_SUB, { ZCI_ROLLOUT_DIR: "D:/r" })).toBe(join("D:/r", `model-io-${S_SUB}.jsonl`));
  });
});

// ============================================================================
// 组成估算（工具功能缝：直调 execute；期望值为夹具字符构造的手算常量）
//
// 启发式口径（被测规格，夹具即真值来源）：estimateTextTokens(text) =
//   ceil(ASCII 字符数 / 4) + CJK 字符数 × 1
// 锚点校准：scale = anchor.usage.inputTokens / rawTotal；各组 calibrated =
//   floor(raw × scale) 后按"最大余数法"补齐差值（余数并列按 system→tools→
//   history→currentTurn 组序稳定分配），保证 Σcalibrated === anchor.inputTokens。
//
// 声明阈值（工单验收"夹具断言阈值"）：
//  - CALIBRATED_DEVIATION_TOLERANCE = 0：比例归一化构造保证校准后加总与精确锚点零偏差；
//  - RAW_HEURISTIC_BAND = 0.5：原始启发式（未校准）加总与锚点的相对偏差容带——
//    字符/token 比随内容语言与 JSON 结构浮动（ASCII≈4 字符/token、CJK≈1 字符/token
//    只是量级折算），50% 容带足以暴露"分组漏计/重复计"类结构性错误而不误伤正常折算误差。
const CALIBRATED_DEVIATION_TOLERANCE = 0;
const RAW_HEURISTIC_BAND = 0.5;

// S_MAIN 锚点（第 3 行 full）四分组原始折算，逐项推导见 make-fixtures.mjs 注释。
// 统一估算口径（review 修复 P0-4）：估算函数 = ceil(ASCII/4) + CJK×1（composition.ts
// 单一底座）；system 双计去重（T6 实测结论：body.system 与头部 role=system 消息
// 逐字重复，分组只按 messages 计一次，body.system 仅在无 system 消息时兜底）：
//   system = role=system 消息：m×40→10 + 摘要×31（62 CJK）→62             = 72
//     （body.system 的 S×100→25 与 系统提示×24→24 不再重复计入）
//   tools  = 工具定义 JSON 序列化折算（245 字符→62）+（145 字符→37）      = 99
//   history = 最后一条 user 之前的 user/assistant/tool 消息（20+50+100）  = 170
//   currentTurn = 最后一条 user 起的当轮消息（20+30+60）                   = 110
//   rawTotal = 451；锚点精确 inputTokens = 625 → scale = 625/451
//   floor 值：system 45000/451→99(.778)、tools 61875/451→137(.195)、
//   history 106250/451→235(.588)、currentTurn 68750/451→152(.439)（和 623）
//   余 2 按最大余数补：system(.778)→100、history(.588)→236
const MAIN_RAW = { system: 72, tools: 99, history: 170, currentTurn: 110 };
const MAIN_RAW_TOTAL = 451;
const MAIN_ANCHOR_INPUT = 625;
const MAIN_SCALE = 625 / 451;
const MAIN_CALIBRATED = { system: 100, tools: 137, history: 236, currentTurn: 152 };

async function callCompositionTool(deps, args = {}) {
  const { createCurrentSessionCompositionTool } = await import(
    "../src/server/tools/get_current_session_composition.ts"
  );
  const tool = createCurrentSessionCompositionTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

/** 写临时心跳并返回路径（调用方清理目录） */
function tmpHeartbeat(dir, sessionId, time) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify({ sessionId, time }) + "\n", "utf8");
  return p;
}

describe("get_current_session_composition（功能缝：直调 execute）", () => {
  it("主会话夹具：识别 full/delta/tail 三态，锚定最近 full，估算加总与精确锚点偏差在声明阈值内", async () => {
    const payload = await callCompositionTool({
      dbPath: fixtureDb,
      heartbeatPath: fixtureHeartbeat,
      rolloutDir: fixtureRolloutDir,
    });

    // 会话识别（心跳精确）
    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("heartbeat");

    // 三态分类计数（夹具 5 行：full/delta/full/delta/tail）
    expect(payload.rollout.requests).toEqual({ total: 5, full: 2, delta: 2, tail: 1, other: 0 });

    // 锚点 = 最近的 full（第 3 行，压缩后快照），而非最后一行 tail
    expect(payload.anchor).toEqual({
      requestId: "req-main-3",
      index: 2,
      kind: "full",
      inputTokens: MAIN_ANCHOR_INPUT,
      messageCount: 8,
      messageOffset: 0,
    });

    // 顶部总量 = API 精确值（锚点 inputTokens，非原始启发式加总）
    expect(payload.exactTotalTokens).toBe(MAIN_ANCHOR_INPUT);

    // 原始启发式折算（手算常量）与偏差容带
    expect(payload.composition.raw).toEqual(MAIN_RAW);
    const rawTotal = Object.values(payload.composition.raw).reduce((a, b) => a + b, 0);
    expect(rawTotal).toBe(MAIN_RAW_TOTAL);
    expect(Math.abs(rawTotal - MAIN_ANCHOR_INPUT) / MAIN_ANCHOR_INPUT).toBeLessThanOrEqual(RAW_HEURISTIC_BAND);

    // 锚点校准：比例因子 + 最大余数法分配（手算常量）
    expect(payload.composition.estimated).toBe(true);
    expect(payload.composition.scaleFactor).toBe(MAIN_SCALE);
    expect(payload.composition.calibrated).toEqual(MAIN_CALIBRATED);

    // 声明阈值：校准后加总与精确锚点偏差 ≤ 0（构造保证恰好为 0）
    const calibratedSum = Object.values(payload.composition.calibrated).reduce((a, b) => a + b, 0);
    expect(Math.abs(calibratedSum - payload.anchor.inputTokens)).toBeLessThanOrEqual(
      CALIBRATED_DEVIATION_TOLERANCE,
    );
  });

  it("纯 delta 会话（子代理夹具，无 full 快照）：只返回精确总量，组成空态原因 no-full-snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-comp-"));
    try {
      const payload = await callCompositionTool({
        dbPath: fixtureDb,
        heartbeatPath: tmpHeartbeat(dir, S_SUB, 1792600050000),
        rolloutDir: fixtureRolloutDir,
      });

      expect(payload.available).toBe(true);
      expect(payload.session.id).toBe(S_SUB);
      // 夹具子代理文件：2 行可解析（delta/tail 各一）+ 1 行损坏 JSON（跳过不计）
      expect(payload.rollout.requests).toEqual({ total: 2, full: 0, delta: 1, tail: 1, other: 0 });
      expect(payload.anchor).toBeNull();
      expect(payload.composition).toBeNull();
      expect(payload.compositionReason).toBe("no-full-snapshot");
      // 精确总量 = 最后一条带用量记录的 inputTokens（手算常量：末行 tail input=520）
      expect(payload.exactTotalTokens).toBe(520);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // review 修复（P0-3 Context 页 sessionId 接线）：显式 sessionId 优先于心跳识别，
  // 组成按指定会话的 rollout 计算（source=explicit）；无心跳路径下同样可用
  it("显式 sessionId：source=explicit，组成按指定会话的 rollout（S_MAIN 锚点）", async () => {
    const payload = await callCompositionTool(
      {
        dbPath: fixtureDb,
        heartbeatPath: join(tmpdir(), "absent-heartbeat.json"), // 无心跳：不依赖识别兜底
        rolloutDir: fixtureRolloutDir,
      },
      { sessionId: S_MAIN },
    );

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("explicit");
    expect(payload.anchor.requestId).toBe("req-main-3");
    expect(payload.exactTotalTokens).toBe(MAIN_ANCHOR_INPUT);
    expect(payload.composition.calibrated).toEqual(MAIN_CALIBRATED);
  });

  it("rollout 文件缺失（宿主清理，ADR-0001 预期）：available=false 降级不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-comp-"));
    try {
      const payload = await callCompositionTool({
        dbPath: fixtureDb,
        // S_MULTI 会话在夹具 rollout 目录中无文件
        //（S_OLD 自 T6 合并起挂纯 delta 行集，缺文件路径改用 T9 的 S_MULTI）
        heartbeatPath: tmpHeartbeat(dir, "session_00000000000000000000000000000004", 1792600030000),
        rolloutDir: fixtureRolloutDir,
      });
      expect(payload.available).toBe(false);
      expect(payload.reason).toBe("rollout-not-found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无会话识别来源（无心跳且 db 缺失）：available=false，reason=no-session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-comp-"));
    try {
      const payload = await callCompositionTool({
        dbPath: join(dir, "absent.sqlite"),
        heartbeatPath: join(dir, "absent.json"),
        rolloutDir: fixtureRolloutDir,
      });
      expect(payload.available).toBe(false);
      expect(payload.reason).toBe("no-session");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
