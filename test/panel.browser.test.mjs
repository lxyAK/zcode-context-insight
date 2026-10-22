// @vitest-environment happy-dom
/**
 * Context Browser 面板视图测试（T6；T8 三页路由后 Browser 区块在 Context 页挂载）：
 * 测试 seam 是面板公共入口——mountPanel（经 mock 桥渲染请求序列列表；先导航到
 * Context 页再断言，参考 panel.mount.test.mjs 的路由适配方式）与 createBrowserView
 * 的公开方法（render / open，open 为 T3/T4 下钻联动缝）。
 * 断言只看渲染后的 DOM 文本与交互（点击行/切换 DNA/返回），不触及内部状态。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";
import { createBrowserView } from "../src/panel/views/browser.ts";

/** 与 panel.mount.test.mjs 同构的 mock 宿主（按工具名分派可编程应答） */
function createMockHost(win, { toolResults = {}, toolErrorNames = [] } = {}) {
  const received = [];
  const target = {
    postMessage(message) {
      received.push(message);
      queueMicrotask(() => {
        if (message.method === "ui/initialize") {
          win.dispatchEvent(
            new MessageEvent("message", {
              data: {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  hostInfo: { name: "zcode-host", version: "3.16.2" },
                  hostCapabilities: { experimental: { "zcode/surface": { stateKey: "zci-test" } } },
                  hostContext: { theme: "dark", locale: "zh-CN" },
                },
              },
            }),
          );
        } else if (message.method === "tools/call" && message.id !== undefined) {
          if (toolErrorNames.includes(message.params.name)) {
            win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "mock 工具失败" } } }));
            return;
          }
          const result = toolResults[message.params.name] ?? { content: [{ type: "text", text: "{}" }] };
          win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, result } }));
        }
      });
    },
  };
  return { target, received };
}

const textResult = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

const OVERVIEW_RESULT = textResult({ plugin: "zcode-context-insight", version: "0.1.2", server: "zci", greeting: "ok" });
const USAGE_RESULT = textResult({
  available: true,
  session: { id: "session_panel_test", source: "heartbeat", heartbeatAt: 1, title: "t", taskType: "interactive", timeCreated: 1, timeUpdated: 2 },
  usage: { requests: 2, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, computedTotalTokens: 15, ttftMsTotal: 0, byQuerySource: {} },
});

// —— mock 数据（形状对齐 get_request_detail / list_session_requests 载荷；数值为测试自设常量） ——
const S_TEST = "session_panel_test";

const LIST_RESULT = textResult({
  available: true,
  session: { id: S_TEST },
  requests: [
    { index: 0, requestId: "r1", attempt: 1, querySource: "main_turn", model: { modelId: "GLM-5.3", providerId: "p" }, startedAt: "2026-10-22T00:00:10.000Z", completedAt: "2026-10-22T00:00:16.000Z", durationMs: 6000, messagesKind: "full", messageOffset: 0, messageCount: 9, toolCount: 2, usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cacheReadTokens: 1000, cacheWriteTokens: 0 } },
    { index: 1, requestId: "r2", attempt: 1, querySource: "main_turn", model: { modelId: "GLM-5.3", providerId: "p" }, startedAt: "2026-10-22T00:01:10.000Z", completedAt: "2026-10-22T00:01:13.000Z", durationMs: 3000, messagesKind: "delta", messageOffset: 6, messageCount: 8, toolCount: 2, usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860, cacheReadTokens: 600, cacheWriteTokens: 0 } },
  ],
  counts: { total: 2, full: 1, delta: 1, tail: 0 },
  parseSkipped: 0,
});

const DETAIL_USAGE = { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cacheReadTokens: 1000, cacheWriteTokens: 0 };

const DETAIL_FULL = textResult({
  available: true,
  session: { id: S_TEST },
  request: { index: 0, requestId: "r1", messagesKind: "full", messageOffset: 0, messageCount: 9, toolCount: 2, querySource: "main_turn", model: { modelId: "GLM-5.3", providerId: "p" }, startedAt: "2026-10-22T00:00:10.000Z", durationMs: 6000 },
  usage: DETAIL_USAGE,
  snapshot: "full",
  composition: {
    estimatedTotalTokens: 138,
    scale: 1200 / 138,
    groups: [
      { key: "system", label: "system 提示", estimatedTokens: 35, blockCount: 3 },
      { key: "tools", label: "工具定义", estimatedTokens: 39, blockCount: 2 },
      { key: "history", label: "历史消息", estimatedTokens: 57, blockCount: 3 },
      { key: "current", label: "当前轮", estimatedTokens: 7, blockCount: 1 },
    ],
    blocks: [
      { seq: 0, groupKey: "system", kind: "message", role: "system", estimatedTokens: 10, preview: "sys prompt a" },
      { seq: 1, groupKey: "system", kind: "message", role: "system", estimatedTokens: 20, preview: "sys prompt b" },
      { seq: 2, groupKey: "tools", kind: "tool", name: "Read", estimatedTokens: 19, preview: "Read a file" },
      { seq: 3, groupKey: "tools", kind: "tool", name: "Bash", estimatedTokens: 20, preview: "Run a command" },
      { seq: 4, groupKey: "history", kind: "message", role: "user", estimatedTokens: 15, preview: "please help" },
      { seq: 5, groupKey: "history", kind: "message", role: "assistant", estimatedTokens: 17, preview: "ok", parts: [{ type: "reasoning", estimatedTokens: 11, preview: "thinking" }, { type: "text", estimatedTokens: 6, preview: "answer" }] },
      { seq: 6, groupKey: "history", kind: "message", role: "tool", toolName: "Read", estimatedTokens: 25, preview: "file content" },
      { seq: 7, groupKey: "system", kind: "message", role: "system", estimatedTokens: 5, preview: "reminder" },
      { seq: 8, groupKey: "current", kind: "message", role: "user", estimatedTokens: 7, preview: "当前轮请求正文" },
    ],
  },
});

const DETAIL_DELTA = textResult({
  available: true,
  session: { id: S_TEST },
  request: { index: 1, requestId: "r2", messagesKind: "delta", messageOffset: 6, messageCount: 8, querySource: "main_turn", model: { modelId: "GLM-5.3", providerId: "p" }, startedAt: "2026-10-22T00:01:10.000Z", durationMs: 3000 },
  usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860, cacheReadTokens: 600, cacheWriteTokens: 0 },
  snapshot: "none",
  composition: null,
});

/** 轮询等待异步渲染完成（页面挂载经微任务/宏任务链，不暴露内部 Promise） */
async function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * 挂载（默认落 Insights 页）后切到 Context 页，等待 Context Browser 完成首次渲染
 * （列表头或降级空态，二择一出现即视为就绪；与 panel.mount.test.mjs 的
 * mountContext 适配同构——T8 三页路由后 Browser 区块随 Context 页装载）。
 */
async function mountWith(toolResults) {
  const host = createMockHost(window, { toolResults });
  await mountPanel({ win: window, target: host.target });
  const ctxBtn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
  ctxBtn.click();
  const root = document.getElementById("root");
  await waitFor(() => {
    const browser = root.querySelector(".zci-browser");
    return browser !== null && browser.textContent.trim().length > 0;
  });
  return { host, root };
}

/** 点击后的异步渲染需要多轮 microtask（mock 桥 postMessage → resolve → 视图续体） */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("面板 Context Browser（挂载缝：mountPanel）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("挂载后渲染请求序列列表：形态徽标、精确输入、形态计数", async () => {
    const { root } = await mountWith({
      get_overview: OVERVIEW_RESULT,
      get_current_session_usage: USAGE_RESULT,
      list_session_requests: LIST_RESULT,
    });
    expect(root.textContent).toContain("Context Browser");
    expect(root.textContent).toContain("请求序列");
    expect(root.textContent).toContain("full");
    expect(root.textContent).toContain("delta");
    expect(root.textContent).toContain("1200"); // full 行精确输入
    // 形态计数摘要
    expect(root.textContent).toContain("full 1");
    expect(root.textContent).toContain("delta 1");
    // 可点击行携带请求标识
    const row = root.querySelector('[data-request-id="r1"]');
    expect(row).toBeTruthy();
  });

  it("点击 full 请求行进入明细：四分组、估算角标、精确总量、DNA 切换入口", async () => {
    const { root } = await mountWith({
      get_overview: OVERVIEW_RESULT,
      get_current_session_usage: USAGE_RESULT,
      list_session_requests: LIST_RESULT,
      get_request_detail: DETAIL_FULL,
    });
    root.querySelector('[data-request-id="r1"]').click();
    await flush();

    // 四分组固定命名（GLOSSARY）
    for (const label of ["system 提示", "工具定义", "历史消息", "当前轮"]) {
      expect(root.textContent).toContain(label);
    }
    // 估算与精确并存（ADR-0002：估算标注 + 精确总量）
    expect(root.textContent).toContain("估算");
    expect(root.textContent).toContain("1280");
    // 块行与 assistant 分块
    expect(root.textContent).toContain("Read");
    expect(root.textContent).toContain("reasoning");
    expect(root.textContent).toContain("当前轮请求正文");
    // DNA 切换入口
    const toggle = root.querySelector('[data-action="toggle-dna"]');
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain("DNA 扁平模式");
  });

  it("DNA 扁平模式：按请求内顺序展示组成块（带序号与分组标签），可切回分组", async () => {
    const { root } = await mountWith({
      get_overview: OVERVIEW_RESULT,
      get_current_session_usage: USAGE_RESULT,
      list_session_requests: LIST_RESULT,
      get_request_detail: DETAIL_FULL,
    });
    root.querySelector('[data-request-id="r1"]').click();
    await flush();

    root.querySelector('[data-action="toggle-dna"]').click();
    await flush();

    const dnaRows = Array.from(root.querySelectorAll(".zci-dna-row"));
    expect(dnaRows.length).toBe(9);
    // 扁平序按 seq：首块 #0（system 提示）、末块 #8（当前轮）
    expect(dnaRows[0].textContent).toContain("#0");
    expect(dnaRows[0].textContent).toContain("system 提示");
    expect(dnaRows[8].textContent).toContain("#8");
    expect(dnaRows[8].textContent).toContain("当前轮");
    // 工具定义块在头部 system 之后（#2/#3）
    expect(dnaRows[2].textContent).toContain("Read");
    expect(dnaRows[3].textContent).toContain("Bash");

    // 切回分组
    const back = root.querySelector('[data-action="toggle-dna"]');
    expect(back.textContent).toContain("分组模式");
    back.click();
    await flush();
    expect(root.querySelectorAll(".zci-dna-row").length).toBe(0);
    expect(root.querySelectorAll(".zci-group").length).toBe(4);
  });

  it("点击 delta 请求行：显示'无快照'空态而非报错", async () => {
    const { root } = await mountWith({
      get_overview: OVERVIEW_RESULT,
      get_current_session_usage: USAGE_RESULT,
      list_session_requests: LIST_RESULT,
      get_request_detail: DETAIL_DELTA,
    });
    root.querySelector('[data-request-id="r2"]').click();
    await flush();

    expect(root.textContent).toContain("无快照");
    expect(root.textContent).toContain("delta");
  });

  it("rollout 不可用（available=false）：显示明细不可用空态，其余区域不受影响", async () => {
    const { root } = await mountWith({
      get_overview: OVERVIEW_RESULT,
      get_current_session_usage: USAGE_RESULT,
      list_session_requests: textResult({ available: false, reason: "rollout-not-found", session: null, requests: null }),
    });
    expect(root.textContent).toContain("明细不可用");
    expect(root.textContent).toContain("ok"); // 概览不受影响
  });

  it("明细视图可返回请求列表", async () => {
    const { root } = await mountWith({
      get_overview: OVERVIEW_RESULT,
      get_current_session_usage: USAGE_RESULT,
      list_session_requests: LIST_RESULT,
      get_request_detail: DETAIL_FULL,
    });
    root.querySelector('[data-request-id="r1"]').click();
    await flush();
    expect(root.querySelector('[data-request-id="r1"]')).toBeNull(); // 已进入明细

    root.querySelector('[data-action="back"]').click();
    await flush();
    expect(root.querySelector('[data-request-id="r1"]')).toBeTruthy(); // 回到列表
  });
});

describe("BrowserView 联动缝（T3 组成条 / T4 趋势图下钻用）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="host"></div>';
  });

  it("open(sessionId, requestId) 不经列表直接渲染明细", async () => {
    const calls = [];
    const view = createBrowserView({
      doc: document,
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "get_request_detail") return JSON.parse(DETAIL_FULL.content[0].text);
        throw new Error("不应调用其他工具");
      },
    });
    document.getElementById("host").append(view.element);
    await view.open(S_TEST, "r1");

    expect(calls).toEqual([{ name: "get_request_detail", args: { sessionId: S_TEST, requestId: "r1" } }]);
    expect(view.element.textContent).toContain("当前轮");
    expect(view.element.textContent).toContain("估算");
  });

  it("open() 对无快照请求渲染空态；工具失败降级不抛错", async () => {
    const view = createBrowserView({
      doc: document,
      callTool: async (name) => {
        if (name === "get_request_detail") return JSON.parse(DETAIL_DELTA.content[0].text);
        throw new Error("unexpected");
      },
    });
    await view.open(S_TEST, "r2");
    expect(view.element.textContent).toContain("无快照");

    const failing = createBrowserView({
      doc: document,
      callTool: async () => {
        throw new Error("bridge down");
      },
    });
    await expect(failing.open(S_TEST, "r1")).resolves.toBeUndefined();
    expect(failing.element.textContent).toContain("明细不可用");
  });
});
