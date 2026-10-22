// @vitest-environment happy-dom
/**
 * 面板挂载冒烟（mock 桥）：
 * 测试 seam 是面板的公共入口 mountPanel——经 postMessage JSON-RPC 桥完成
 * ui/initialize 握手并 callServerTool(get_overview)，把结果渲染进容器。
 * "不白屏" = 渲染后容器内出现工具返回的内容。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";

/** 消息记录与可编程应答的 mock 宿主 */
function createMockHost(win, { toolResult, toolError } = {}) {
  const received = [];
  let nextId = 1;
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
                  hostCapabilities: {
                    experimental: { "zcode/surface": { stateKey: "zci-test-state-key" } },
                  },
                  hostContext: { theme: "dark", locale: "zh-CN" },
                },
              },
            }),
          );
        } else if (message.method === "tools/call" && message.id !== undefined) {
          const data = toolError
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "mock 工具失败" } }
            : { jsonrpc: "2.0", id: message.id, result: toolResult };
          win.dispatchEvent(new MessageEvent("message", { data }));
        }
        // 通知（initialized 等）无需应答
      });
    },
  };
  return { target, received, nextIdRef: () => nextId++ };
}

const OVERVIEW_RESULT = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        plugin: "zcode-context-insight",
        version: "0.1.0",
        server: "zci",
        greeting: "mock-greeting-骨架连通",
      }),
    },
  ],
};

describe("面板挂载（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("握手 → callServerTool(get_overview) → 渲染工具返回内容（不白屏）", async () => {
    const host = createMockHost(window, { toolResult: OVERVIEW_RESULT });
    await mountPanel({ win: window, target: host.target });

    const root = document.getElementById("root");
    expect(root.textContent).not.toContain("Loading…");
    expect(root.textContent).toContain("zcode-context-insight");
    expect(root.textContent).toContain("0.1.0");
    expect(root.textContent).toContain("mock-greeting-骨架连通");

    // 协议顺序：initialize（protocolVersion 2026-01-26）→ initialized 通知 → tools/call
    const init = host.received.find((m) => m.method === "ui/initialize");
    expect(init.params.protocolVersion).toBe("2026-01-26");
    expect(init.params.appInfo.name).toBe("zcode-context-insight");
    const idxInit = host.received.indexOf(init);
    const idxReady = host.received.findIndex(
      (m) => m.method === "ui/notifications/initialized" && m.jsonrpc === "2.0",
    );
    const idxCall = host.received.findIndex((m) => m.method === "tools/call");
    expect(idxReady).toBeGreaterThan(idxInit);
    expect(idxCall).toBeGreaterThan(idxReady);
    expect(host.received[idxCall].params).toEqual({ name: "get_overview", arguments: {} });
  });

  it("工具调用失败时渲染错误信息而非白屏", async () => {
    const host = createMockHost(window, { toolError: true });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent.trim().length).toBeGreaterThan(0);
    expect(root.textContent).toContain("mock 工具失败");
  });
});
