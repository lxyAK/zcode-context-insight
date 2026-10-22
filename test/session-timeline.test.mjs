/**
 * 逐请求时间线功能缝（T4，工单预先约定的缝：in-process 直调工具 execute）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 注入的行集），
 * 不经被测代码路径反推——夹具即真值来源。
 *
 * 红线对照：所有测试读写 test/fixtures 合成夹具，绝不触碰 ~/.zcode 真实库。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");
const fixtureHeartbeat = join(repoRoot, "test", "fixtures", "heartbeat.json");

// 夹具会话 ID（与 scripts/make-fixtures.mjs 保持同源常量）
const S_MAIN = "session_00000000000000000000000000000001";
const S_OLD = "session_00000000000000000000000000000002";

/** 夹具时间基准（make-fixtures.mjs 的 T0） */
const T0 = 1792600000000;

/**
 * S_MAIN 的逐请求时间线手算期望（model_usage 按 started_at 升序，T5 并行工单加入
 * mu_main_4 重试 / mu_main_5 超限失败 / mu_main_6 三行后共 6 行）：
 * 行集见 make-fixtures.mjs insertModelUsage —— mu_main_3(T0+5000) 先于 mu_main_1(T0+10000)。
 */
const MAIN_REQUESTS = [
  {
    index: 0,
    startedAt: T0 + 5000,
    querySource: "session_title",
    modelId: "GLM-5.3",
    status: "completed",
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computedTotalTokens: 15,
    contextExceeded: false,
  },
  {
    index: 1,
    startedAt: T0 + 10000,
    querySource: "main_turn",
    modelId: "GLM-5.3",
    status: "completed",
    inputTokens: 1000,
    outputTokens: 200,
    reasoningTokens: 50,
    cacheReadTokens: 800,
    cacheWriteTokens: 100,
    computedTotalTokens: 1200,
    contextExceeded: false,
  },
  {
    index: 2,
    startedAt: T0 + 20000,
    querySource: "main_turn",
    modelId: "GLM-5.3",
    status: "completed",
    inputTokens: 500,
    outputTokens: 100,
    reasoningTokens: 0,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    computedTotalTokens: 600,
    contextExceeded: false,
  },
  {
    index: 3,
    startedAt: T0 + 30000, // mu_main_4（T5 重试场景行）
    querySource: "main_turn",
    modelId: "GLM-5.3",
    status: "completed",
    inputTokens: 400,
    outputTokens: 80,
    reasoningTokens: 0,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    computedTotalTokens: 480,
    contextExceeded: false,
  },
  {
    index: 4,
    startedAt: T0 + 40000, // mu_main_5（T5 上下文超限失败行）
    querySource: "main_turn",
    modelId: "GLM-5.3",
    status: "error",
    inputTokens: 2000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 1900,
    cacheWriteTokens: 0,
    computedTotalTokens: 2000,
    contextExceeded: true,
  },
  {
    index: 5,
    startedAt: T0 + 45000, // mu_main_6
    querySource: "main_turn",
    modelId: "GLM-5.3",
    status: "completed",
    inputTokens: 90,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computedTotalTokens: 110,
    contextExceeded: false,
  },
];

/** 写一个临时心跳文件，返回路径（测试后由调用方清理目录） */
function writeHeartbeat(dir, obj) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  return p;
}

async function callTool(args = {}, deps = {}) {
  const { createSessionTimelineTool } = await import("../src/server/tools/get_session_timeline.ts");
  const tool = createSessionTimelineTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

describe("get_session_timeline（功能缝：直调 execute）", () => {
  it("心跳可用：返回当前会话逐请求序列，按 started_at 升序（用量 + 时间戳 + 模型）", async () => {
    const payload = await callTool({}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("heartbeat");
    expect(payload.requests).toEqual(MAIN_REQUESTS);
  });

  it("压缩事件标记：含 preCompact/truePostCompact 与触发方式，并关联时间线序号", async () => {
    const payload = await callTool({}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    // S_MAIN 共两条压缩事件：T4 的自动压缩 + T7 并行工单加入的手动压缩（part_t7_compact_2）
    expect(payload.compactions).toEqual([
      {
        time: T0 + 55000, // part_fixture_compact_1 的 time_created
        auto: true, // 触发方式：自动
        trigger: "auto",
        triggerKind: "auto", // 归一触发方式（P0-5 唯一解析点 fetchCompactionEvents 新增）,
        phase: "done",
        compactReason: "approaching-context-limit",
        preCompactTokenCount: 1800,
        postCompactTokenCount: 350,
        truePostCompactTokenCount: 300,
        summarizedMessageCount: 2,
        keptMessageCount: 1,
        requestIndex: 5, // T0+55000 晚于全部 6 个请求（含 T5 追加行）→ 关联到末尾请求（index 5）
      },
      {
        time: T0 + 58000, // part_t7_compact_2（T7 行集）
        auto: false, // 触发方式：手动
        trigger: "manual",
        triggerKind: "manual",
        phase: null, // 该行未写 phase/compactReason
        compactReason: null,
        preCompactTokenCount: 4000,
        postCompactTokenCount: 900,
        truePostCompactTokenCount: 500,
        summarizedMessageCount: 5,
        keptMessageCount: 2,
        requestIndex: 5,
      },
    ]);
  });

  it("truePostCompactTokenCount 语义：真实压缩后上下文数，区别于含总结消息的 post 值（两者在夹具中刻意不同）", async () => {
    const payload = await callTool({}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });
    const c = payload.compactions[0];

    // 夹具设计（make-fixtures.mjs 注释）：真实压缩后 300 token，总结消息本身约 50 token，
    // 因此含总结消息的 postCompactTokenCount=350 > truePostCompactTokenCount=300。
    // 若实现把两个字段混用（取错键或互相赋值），下面的不等断言即失败。
    expect(c.truePostCompactTokenCount).toBe(300);
    expect(c.postCompactTokenCount).toBe(350);
    expect(c.truePostCompactTokenCount).not.toBe(c.postCompactTokenCount);
    // 压缩前 token 独立可读（趋势图上"压缩前"锚点）
    expect(c.preCompactTokenCount).toBe(1800);
  });

  it("显式 sessionId：返回指定会话（S_OLD）的时间线，无压缩事件（空态）", async () => {
    const payload = await callTool(
      { sessionId: S_OLD },
      { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat },
    );

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_OLD);
    expect(payload.session.source).toBe("explicit"); // 显式指定，不经心跳/兜底
    expect(payload.session.title).toBe("夹具旧会话");
    // mu_old_1 单行（make-fixtures.mjs）：T0+1000，main_turn，input 300 / output 50 / 缓存读 250 / 总量 350
    expect(payload.requests).toEqual([
      {
        index: 0,
        startedAt: T0 + 1000,
        querySource: "main_turn",
        modelId: "GLM-5.3",
        status: "completed",
        inputTokens: 300,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 250,
        cacheWriteTokens: 0,
        computedTotalTokens: 350,
        contextExceeded: false,
      },
    ]);
    // S_OLD 刻意无 part 行（T7 空态依据）；手动压缩场景由 S_MAIN 的 part_t7_compact_2 覆盖
    expect(payload.compactions).toEqual([]);
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-tl-"));
    try {
      const payload = await callTool(
        {},
        { dbPath: join(dir, "no-such.sqlite"), heartbeatPath: join(dir, "absent.json") },
      );

      expect(payload.available).toBe(false);
      expect(payload.reason).toBe("db-not-found");
      expect(payload.requests).toBeNull();
      expect(payload.compactions).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
