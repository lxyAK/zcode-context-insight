// @vitest-environment happy-dom
/**
 * 面板刷新功能缝基线（T12；seam = mountPanel 公共入口 + fake timers 驱动轮询）。
 *
 * 外部行为契约：
 *  - 页头常驻"刷新"按钮（手动兜底）：点击即重拉 get_current_session_usage 并更新 UI；
 *  - 自动刷新：面板按 pollIntervalMs 轮询 get_data_version（轻量），版本变化才重拉
 *    用量数据（server 侧 fs.watch 感知 db/rollout 变更 → dataVersion 递增）；
 *  - 版本未变不重拉数据视图；dispose() 停止轮询（面板卸载清理）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";

/** mock 宿主：toolResults 值可为静态应答或 (args) => 动态应答函数 */
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
                result: { hostInfo: { name: "zcode-host", version: "3.16.2" } },
              },
            }),
          );
        } else if (message.method === "tools/call" && message.id !== undefined) {
          if (toolErrorNames.includes(message.params.name)) {
            win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "mock 工具失败" } } }));
            return;
          }
          const entry = toolResults[message.params.name];
          const result =
            typeof entry === "function"
              ? entry(message.params.arguments)
              : (entry ?? { content: [{ type: "text", text: "{}" }] });
          win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, result } }));
        }
      });
    },
  };
  return { target, received };
}

const OVERVIEW_RESULT = {
  content: [
    {
      type: "text",
      text: JSON.stringify({ plugin: "zcode-context-insight", version: "0.1.0", server: "zci", greeting: "mock-greeting" }),
    },
  ],
};

const USAGE_RESULT = (totalTokens) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        available: true,
        session: {
          id: "session_00000000000000000000000000000001",
          source: "heartbeat",
          heartbeatAt: 1792600060000,
          title: "mock 会话",
          taskType: "interactive",
          timeCreated: 1792600000000,
          timeUpdated: 1792600060000,
        },
        usage: {
          requests: 1,
          inputTokens: totalTokens,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          computedTotalTokens: totalTokens + 10,
          ttftMsTotal: 0,
          byQuerySource: {},
        },
      }),
    },
  ],
});

/** 工具调用计数（按名统计发出的 tools/call） */
function countCalls(host, name) {
  return host.received.filter((m) => m.method === "tools/call" && m.params?.name === name).length;
}

describe("面板刷新（手动按钮 + dataVersion 轮询）", () => {
  let usagePayload;
  let dataVersion;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
    localStorage.clear();
    vi.useFakeTimers();
    usagePayload = 1000; // 首次用量夹具（独立真值：inputTokens=1000）
    dataVersion = 1;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeHost() {
    return createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: () => USAGE_RESULT(usagePayload),
        get_data_version: () => ({
          content: [{ type: "text", text: JSON.stringify({ dataVersion, watching: { db: true, rollout: true } }) }],
        }),
      },
    });
  }

  it("页头渲染刷新按钮；点击即重拉用量数据并更新 UI（手动兜底）", async () => {
    const host = makeHost();
    const handle = await mountPanel({ win: window, target: host.target, pollIntervalMs: 0 }); // 0 = 禁用轮询，只测手动
    try {
      const root = document.getElementById("root");
      const button = root.querySelector("button.zci-refresh");
      expect(button, "应渲染手动刷新按钮").toBeTruthy();

      const before = countCalls(host, "get_current_session_usage");
      usagePayload = 2000; // 模拟宿主数据已变（第二次拉取返回新值）
      button.click();
      await vi.advanceTimersByTimeAsync(50); // flush 微任务应答

      expect(countCalls(host, "get_current_session_usage")).toBe(before + 1);
      expect(root.textContent).toContain("2000"); // UI 更新为新值
      expect(root.textContent).not.toContain("1000");
    } finally {
      handle.dispose();
    }
  });

  it("轮询 get_data_version：版本变化后自动重拉用量（自动刷新）", async () => {
    const host = makeHost();
    const handle = await mountPanel({ win: window, target: host.target, pollIntervalMs: 100 });
    try {
      const root = document.getElementById("root");

      // 第一 tick：记录初始版本，不刷新数据视图
      await vi.advanceTimersByTimeAsync(100);
      expect(countCalls(host, "get_data_version")).toBe(1);
      expect(countCalls(host, "get_current_session_usage")).toBe(1); // 仅首渲染一次

      // 第二 tick：版本未变 → 不重拉数据
      await vi.advanceTimersByTimeAsync(100);
      expect(countCalls(host, "get_current_session_usage")).toBe(1);

      // 模拟宿主写 db → server watcher bump 版本 → 第三 tick：自动重拉
      dataVersion = 2;
      usagePayload = 3000;
      await vi.advanceTimersByTimeAsync(100);
      expect(countCalls(host, "get_current_session_usage")).toBe(2);
      expect(root.textContent).toContain("3000");
    } finally {
      handle.dispose();
    }
  });

  it("dispose() 停止轮询（面板卸载清理）", async () => {
    const host = makeHost();
    const handle = await mountPanel({ win: window, target: host.target, pollIntervalMs: 100 });
    handle.dispose();

    await vi.advanceTimersByTimeAsync(500);
    expect(countCalls(host, "get_data_version")).toBe(0); // dispose 后不再轮询
  });
});
