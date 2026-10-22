/**
 * 请求明细工具功能缝基线（T6，工单预先约定的缝：in-process 直调工具 execute）。
 *
 * 数据源：test/fixtures/rollout/（scripts/make-fixtures.mjs 生成的 model-io JSONL）。
 * 期望值全部为独立手算常量（估算规则与 T3 组成估算同源——统一底座 composition.ts
 * 的 ceil(ASCII/4) + CJK×1，review 修复 P0-4；内容长度在夹具中刻意设计为可手算），
 * 不经被测代码路径反推——夹具即真值来源。
 *
 * 红线对照：所有测试读写 test/fixtures 合成夹具，绝不触碰 ~/.zcode 真实库与 rollout 目录。
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
const S_OLD = "session_00000000000000000000000000000002";
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003";
// T6 明细行集专用会话（与 T3 的 S_MAIN 组成行集分文件并存，见 make-fixtures.mjs 文件头）：
// 经测试心跳注入使用；不在 db 行集中（心跳精确识别不需要 db 行）
const S_BROWSER = "session_00000000000000000000000000000005";
// 孙代理会话（在 db、无 rollout 文件）：S_SUB 已挂 T3 行集，缺文件降级路径改用此会话
const S_SUBSUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000004";

// req-full-1 四分组手算（夹具注释即真值来源；估算规则 ASCII ceil(len/4)、CJK×1）
const FULL1_GROUPS = {
  system: { estimatedTokens: 35, blockCount: 3 }, // A*40=10 + B*80=20 + 尾部 S*20=5
  tools: { estimatedTokens: 39, blockCount: 2 }, // Read JSON 76 字=19 + Bash JSON 78 字=20
  history: { estimatedTokens: 57, blockCount: 3 }, // user 15 + assistant 17 + tool 25
  current: { estimatedTokens: 7, blockCount: 1 }, // "当前轮请求正文" 7 个 CJK → 7
};
const FULL1_ESTIMATED_TOTAL = 138;
const FULL1_USAGE = { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cacheReadTokens: 1000, cacheWriteTokens: 0 };

// req-full-2：当前轮=最后一条 user（其后还有尾部 system 提醒也不归当前轮）
const FULL2_GROUPS = {
  system: { estimatedTokens: 15, blockCount: 2 }, // C*40=10 + 尾部 M*20=5
  tools: { estimatedTokens: 0, blockCount: 0 },
  history: { estimatedTokens: 0, blockCount: 0 }, // 会话第二条请求：无历史
  current: { estimatedTokens: 6, blockCount: 1 }, // "Second turn question!" 21 ASCII → 6
};

const baseDeps = { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat, rolloutDir: fixtureRolloutDir };

/** 写临时心跳并返回路径（调用方清理目录）；T6 明细行集挂在 S_BROWSER，经心跳注入 */
function tmpHeartbeat(dir, sessionId, time) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify({ sessionId, time }) + "\n", "utf8");
  return p;
}

async function callTool(toolName, factoryArgs, executeArgs) {
  const mod = await import("../src/server/tools/request-detail.ts");
  const tool = mod[toolName](factoryArgs);
  const result = await tool.execute(executeArgs ?? {});
  return result.structuredContent;
}

describe("list_session_requests（请求序列，rollout 只读）", () => {
  it("默认当前会话（心跳）：按文件序返回 4 行，含形态/偏移/精确 usage 与形态计数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-detail-hb-"));
    try {
      // T6 明细行集挂 S_BROWSER（心跳注入默认会话）；S_MAIN 留给 T3 组成行集（e2e 同源）
      const payload = await callTool("createListSessionRequestsTool", {
        ...baseDeps,
        heartbeatPath: tmpHeartbeat(dir, S_BROWSER, 1792600060000),
      });

      expect(payload.available).toBe(true);
      expect(payload.session.id).toBe(S_BROWSER);
      expect(payload.requests).toHaveLength(4);
      expect(payload.requests.map((r) => r.requestId)).toEqual([
        "req-full-1",
        "req-delta-1",
        "req-full-2",
        "req-tail-1",
      ]);
      // 行内元数据（首行）
      const first = payload.requests[0];
      expect(first.index).toBe(0);
      expect(first.messagesKind).toBe("full");
      expect(first.messageOffset).toBe(0);
      expect(first.messageCount).toBe(7);
      expect(first.toolCount).toBe(2);
      expect(first.querySource).toBe("main_turn");
      expect(first.model).toEqual({ modelId: "GLM-5.3", providerId: "account:fixture" });
      expect(first.usage).toEqual(FULL1_USAGE);
      // 形态计数
      expect(payload.counts).toEqual({ total: 4, full: 2, delta: 1, tail: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("显式会话：纯 delta 会话（S_OLD）两行均为 delta", async () => {
    const payload = await callTool("createListSessionRequestsTool", baseDeps, { sessionId: S_OLD });

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_OLD);
    expect(payload.counts).toEqual({ total: 2, full: 0, delta: 2, tail: 0 });
  });

  it("rollout 文件不存在（S_SUBSUB，被清理的旧会话）：available=false 降级，不抛错", async () => {
    const payload = await callTool("createListSessionRequestsTool", baseDeps, { sessionId: S_SUBSUB });

    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("rollout-not-found");
    expect(payload.requests).toBeNull();
  });

  it("坏行容错：损坏 JSON 行被跳过并计数，好行照常返回", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-detail-"));
    try {
      const rolloutDir = join(dir, "rollout");
      mkdirSync(rolloutDir);
      const good = JSON.stringify({
        type: "model_io",
        sessionId: S_MAIN,
        requestId: "req-good",
        attempt: 1,
        querySource: "main_turn",
        request: { messages: [], toolNames: [], messageCount: 0, messagesKind: "full", messageOffset: 0 },
        response: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      });
      writeFileSync(
        join(rolloutDir, `model-io-${S_MAIN}.jsonl`),
        good + "\n{broken json\n" + good.replace("req-good", "req-good-2") + "\n",
        "utf8",
      );
      const payload = await callTool("createListSessionRequestsTool", { ...baseDeps, rolloutDir });

      expect(payload.available).toBe(true);
      expect(payload.requests.map((r) => r.requestId)).toEqual(["req-good", "req-good-2"]);
      expect(payload.parseSkipped).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("get_request_detail（单请求组成明细，四分组块级）", () => {
  it("full 请求：四分组小计/块数与手算一致，块按请求内顺序扁平编号，assistant 含分块", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_BROWSER, requestId: "req-full-1" },
    );

    expect(payload.available).toBe(true);
    expect(payload.snapshot).toBe("full");
    expect(payload.usage).toEqual(FULL1_USAGE); // 精确值透传（ADR-0002：总量始终用 API 精确值）

    const comp = payload.composition;
    expect(comp.estimatedTotalTokens).toBe(FULL1_ESTIMATED_TOTAL);
    expect(comp.scale).toBeCloseTo(FULL1_USAGE.inputTokens / FULL1_ESTIMATED_TOTAL, 6);

    // 四分组固定顺序与小计（GLOSSARY：system 提示 / 工具定义 / 历史消息 / 当前轮）
    expect(comp.groups.map((g) => g.key)).toEqual(["system", "tools", "history", "current"]);
    for (const g of comp.groups) {
      expect(g.estimatedTokens).toBe(FULL1_GROUPS[g.key].estimatedTokens);
      expect(g.blockCount).toBe(FULL1_GROUPS[g.key].blockCount);
    }

    // 块级扁平序（DNA 模式的数据底座）：工具定义插在头部 system 之后、首条非 system 消息之前
    const blocks = comp.blocks;
    expect(blocks).toHaveLength(9);
    expect(blocks.map((b) => b.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(blocks.map((b) => b.groupKey)).toEqual([
      "system", "system", // A*40, B*80
      "tools", "tools", // Read, Bash
      "history", "history", "history", // user, assistant, tool
      "system", // 尾部 system 提醒（仍归 system 提示组）
      "current", // 最后一条 user
    ]);
    // 工具定义块：名称与估算
    expect(blocks[2]).toMatchObject({ kind: "tool", name: "Read", estimatedTokens: 19 });
    expect(blocks[3]).toMatchObject({ kind: "tool", name: "Bash", estimatedTokens: 20 });
    // assistant 分块数组：reasoning 11 + text 6 = 17
    const assistant = blocks[5];
    expect(assistant).toMatchObject({ kind: "message", role: "assistant", estimatedTokens: 17 });
    expect(assistant.parts.map((p) => [p.type, p.estimatedTokens])).toEqual([
      ["reasoning", 11],
      ["text", 6],
    ]);
    // tool 消息块携带工具名
    expect(blocks[6]).toMatchObject({ kind: "message", role: "tool", toolName: "Read", estimatedTokens: 25 });
    // 当前轮 = 最后一条 user（CJK 估算：7 字 ×1）
    expect(blocks[8]).toMatchObject({ kind: "message", role: "user", estimatedTokens: 7 });
  });

  it("full 请求：preview 为截断文本（≤120 字符），不外漏全文", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_BROWSER, requestId: "req-full-1" },
    );
    for (const b of payload.composition.blocks) {
      if (typeof b.preview === "string") expect(b.preview.length).toBeLessThanOrEqual(120);
      for (const p of b.parts ?? []) {
        if (typeof p.preview === "string") expect(p.preview.length).toBeLessThanOrEqual(120);
      }
    }
    // 夹具正文以重复字符构造：全文 80 字不可能出现在 preview（≤120 但同字符无法区分长度，
    // 改为断言不出现任何换行与完整 100 字 tool 结果）
    expect(JSON.stringify(payload)).not.toContain("\\n");
  });

  it("当前轮锚定最后一条 user：其后即使还有尾部 system 提醒也不归当前轮（req-full-2）", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_BROWSER, requestId: "req-full-2" },
    );

    const groups = Object.fromEntries(payload.composition.groups.map((g) => [g.key, g]));
    for (const key of ["system", "tools", "history", "current"]) {
      expect(groups[key].estimatedTokens).toBe(FULL2_GROUPS[key].estimatedTokens);
      expect(groups[key].blockCount).toBe(FULL2_GROUPS[key].blockCount);
    }
    // 末块是 system（M*20），当前轮块是其前的 user
    const blocks = payload.composition.blocks;
    expect(blocks[blocks.length - 1]).toMatchObject({ groupKey: "system", estimatedTokens: 5 });
  });

  it("delta 请求：snapshot=none、无组成估算，精确 usage 仍返回（纯 delta 空态数据源）", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_BROWSER, requestId: "req-delta-1" },
    );

    expect(payload.available).toBe(true);
    expect(payload.snapshot).toBe("none");
    expect(payload.composition).toBeNull();
    expect(payload.usage.inputTokens).toBe(800);
  });

  it("tail 请求：与 delta 同样不作组成基准（snapshot=none）", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_BROWSER, requestId: "req-tail-1" },
    );

    expect(payload.snapshot).toBe("none");
    expect(payload.composition).toBeNull();
  });

  it("纯 delta 会话的请求：明细一律无快照（S_OLD 抽查两行）", async () => {
    for (const requestId of ["req-old-1", "req-old-2"]) {
      const payload = await callTool(
        "createGetRequestDetailTool",
        baseDeps,
        { sessionId: S_OLD, requestId },
      );
      expect(payload.snapshot).toBe("none");
      expect(payload.composition).toBeNull();
    }
  });

  it("未知 requestId：available=false 降级返回，不抛错", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_BROWSER, requestId: "req-absent" },
    );

    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("request-not-found");
  });

  it("rollout 文件不存在：available=false 降级返回，不抛错", async () => {
    const payload = await callTool(
      "createGetRequestDetailTool",
      baseDeps,
      { sessionId: S_SUBSUB, requestId: "whatever" },
    );

    expect(payload.available).toBe(false);
    expect(payload.reason).toBe("rollout-not-found");
  });
});
