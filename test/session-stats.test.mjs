/**
 * 会话统计工具功能缝基线（T5，工单预先约定的缝：in-process 直调工具 execute）。
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 注入的 S_MAIN 6 行行集），
 * 不经被测代码路径反推——夹具即真值来源。手算过程见各断言处注释。
 *
 * 红线对照：所有测试读 test/fixtures 合成夹具，绝不触碰 ~/.zcode 真实库。
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

async function callTool(deps) {
  const { createSessionStatsTool } = await import("../src/server/tools/get_session_stats.ts");
  const tool = createSessionStatsTool(deps);
  const result = await tool.execute({});
  return result.structuredContent;
}

describe("get_session_stats（功能缝：直调 execute）", () => {
  it("心跳会话：缓存命中率、TTFT p50/p95、重试、超限计数与夹具手算一致", async () => {
    const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("heartbeat");

    expect(payload.stats).toEqual({
      requests: 6, // S_MAIN 全部 6 行（含失败行）

      // 缓存命中率口径（工单约定）：cacheRead / input 合计。
      // input_tokens 已含 cache_read 部分（研究笔记 03 §3），故分母不另加 cacheRead：
      //   SUM(cache_read)=3400（800+400+0+300+1900+0）÷ SUM(input)=4000（1000+500+10+400+2000+90）= 0.85
      cacheHitRate: 0.85,

      // 上下文超限计数：SUM(context_exceeded)，仅 mu_main_5 标记 1 → 1
      contextExceededCount: 1,

      // token 合计（与 get_current_session_usage 同源口径，computed_total 为准）
      inputTokens: 4000,
      outputTokens: 405,
      reasoningTokens: 50,
      cacheReadTokens: 3400,
      cacheWriteTokens: 100,
      computedTotalTokens: 4405,

      // TTFT 样本为 time_to_first_token_ms 非空的行（mu_main_5 失败无首 token，排除）：
      //   排序后 [200, 600, 900, 1000, 1500]，n=5
      //   p50 = 第 ceil(0.50×5)=3 个 → 900；p95 = 第 ceil(0.95×5)=5 个 → 1500（nearest-rank 口径）
      ttftCount: 5,
      ttftP50Ms: 900,
      ttftP95Ms: 1500,

      // 重试计数：SUM(retry_count)，仅 mu_main_4 带 2（NULL 行计 0）→ 2
      retryCount: 2,
    });
  });

  it("心跳指向未落库的新会话：无请求时命中率与分位数为 null 而非 0/NaN，计数为真 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-stats-"));
    try {
      const hb = join(dir, "heartbeat.json");
      writeFileSync(hb, JSON.stringify({ sessionId: "session_ffffffffffffffffffffffffffffffff", time: 1792600090000 }) + "\n", "utf8");
      const payload = await callTool({ dbPath: fixtureDb, heartbeatPath: hb });

      expect(payload.available).toBe(true);
      expect(payload.stats.requests).toBe(0);
      // 无样本语义：比率/分位数是"未知"而非 0 —— 工单口径"无数据项显示占位而非 0"的服务端来源
      expect(payload.stats.cacheHitRate).toBeNull();
      expect(payload.stats.ttftCount).toBe(0);
      expect(payload.stats.ttftP50Ms).toBeNull();
      expect(payload.stats.ttftP95Ms).toBeNull();
      // 计数类：没有发生就是真 0
      expect(payload.stats.retryCount).toBe(0);
      expect(payload.stats.contextExceededCount).toBe(0);
      expect(payload.stats.computedTotalTokens).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-stats-"));
    try {
      const payload = await callTool({
        dbPath: join(dir, "no-such.sqlite"),
        heartbeatPath: join(dir, "absent.json"),
      });

      expect(payload.available).toBe(false);
      expect(typeof payload.reason).toBe("string");
      expect(payload.reason.length).toBeGreaterThan(0);
      expect(payload.stats).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
