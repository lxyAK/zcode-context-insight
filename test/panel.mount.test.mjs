// @vitest-environment happy-dom
/**
 * 面板挂载冒烟（mock 桥）：
 * 测试 seam 是面板的公共入口 mountPanel——经 postMessage JSON-RPC 桥完成
 * ui/initialize 握手并 callServerTool(get_overview)，把结果渲染进容器。
 * "不白屏" = 渲染后容器内出现工具返回的内容。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";

/** 消息记录与可编程应答的 mock 宿主（按工具名分派应答；toolErrorNames 名单内报桥错误） */
function createMockHost(win, { toolResults = {}, toolError, toolErrorNames = [] } = {}) {
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
                  hostCapabilities: {
                    experimental: { "zcode/surface": { stateKey: "zci-test-state-key" } },
                  },
                  hostContext: { theme: "dark", locale: "zh-CN" },
                },
              },
            }),
          );
        } else if (message.method === "tools/call" && message.id !== undefined) {
          if (toolError || toolErrorNames.includes(message.params.name)) {
            win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "mock 工具失败" } } }));
            return;
          }
          const result = toolResults[message.params.name] ?? {
            content: [{ type: "text", text: "{}" }],
          };
          win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, result } }));
        }
        // 通知（initialized 等）无需应答
      });
    },
  };
  return { target, received };
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

const USAGE_RESULT = (session, usage) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        available: true,
        session,
        usage,
      }),
    },
  ],
});

const HEARTBEAT_SESSION = {
  id: "session_00000000000000000000000000000001",
  source: "heartbeat",
  heartbeatAt: 1792600060000,
  title: "mock 会话",
  taskType: "interactive",
  timeCreated: 1792600000000,
  timeUpdated: 1792600060000,
};

const MOCK_USAGE = {
  requests: 3,
  inputTokens: 1510,
  outputTokens: 305,
  reasoningTokens: 50,
  cacheReadTokens: 1200,
  cacheWriteTokens: 100,
  computedTotalTokens: 1815,
  ttftMsTotal: 2700,
  byQuerySource: {},
};

describe("面板挂载（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("握手 → callServerTool(get_overview) → 渲染工具返回内容（不白屏）", async () => {
    const host = createMockHost(window, {
      toolResults: { get_overview: OVERVIEW_RESULT },
    });
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

  it("当前会话用量：调用 get_current_session_usage 并渲染精确数字与'心跳精确'来源标注", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT(HEARTBEAT_SESSION, MOCK_USAGE),
      },
    });
    await mountPanel({ win: window, target: host.target });

    // 发出了用量工具调用
    const usageCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_current_session_usage",
    );
    expect(usageCall).toBeTruthy();

    const root = document.getElementById("root");
    // 精确用量数字（mock 返回原样渲染）
    expect(root.textContent).toContain("1510");
    expect(root.textContent).toContain("305");
    expect(root.textContent).toContain("1815");
    expect(root.textContent).toContain("3");
    // 识别来源标注（ADR-0003：心跳=精确）
    expect(root.textContent).toContain("心跳精确");
    expect(root.textContent).toContain("session_00000000000000000000000000000001");
  });

  it("识别来源为推断时标注'推断'（兜底路径）", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT(
          { ...HEARTBEAT_SESSION, source: "inferred", heartbeatAt: null },
          MOCK_USAGE,
        ),
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("推断");
    expect(root.textContent).not.toContain("心跳精确");
  });

  it("用量不可用（available=false）时显示降级提示而非白屏，概览仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: {
          content: [{ type: "text", text: JSON.stringify({ available: false, reason: "db-not-found", session: null, usage: null }) }],
        },
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
    expect(root.textContent).toContain("用量暂不可用");
  });

  it("用量工具调用失败（桥错误）时概览仍渲染并显示降级提示", async () => {
    const host = createMockHost(window, {
      toolResults: { get_overview: OVERVIEW_RESULT },
      toolErrorNames: ["get_current_session_usage"],
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
    expect(root.textContent).toContain("用量暂不可用");
  });

  it("get_overview 调用失败时渲染错误信息而非白屏", async () => {
    const host = createMockHost(window, { toolError: true });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent.trim().length).toBeGreaterThan(0);
    expect(root.textContent).toContain("mock 工具失败");
  });
});

// ============================================================================
// 上下文组成条（T3）：mock 宿主应答 get_current_session_composition，断言渲染结果
// 数值取自 test/fixtures/rollout 主会话锚点的手算常量（与 composition.test.mjs 同源）。

const COMPOSITION_RESULT = (overrides = {}) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        available: true,
        session: { id: "session_00000000000000000000000000000001", source: "heartbeat" },
        rollout: { found: true, requests: { total: 5, full: 2, delta: 2, tail: 1, other: 0 } },
        exactTotalTokens: 625,
        anchor: { requestId: "req-main-3", index: 2, kind: "full", inputTokens: 625, messageCount: 8, messageOffset: 0 },
        composition: {
          estimated: true,
          raw: { system: 121, tools: 99, history: 170, currentTurn: 110 },
          calibrated: { system: 151, tools: 124, history: 213, currentTurn: 137 },
          scaleFactor: 1.25,
        },
        ...overrides,
      }),
    },
  ],
});

describe("面板组成条（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("四分组 SVG 组成条：段宽按校准值比例、'估算'角标、顶部总量为 API 精确值", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_composition: COMPOSITION_RESULT(),
      },
    });
    await mountPanel({ win: window, target: host.target });

    // 发出了组成工具调用
    const call = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_current_session_composition",
    );
    expect(call).toBeTruthy();

    const root = document.getElementById("root");
    const svg = root.querySelector("svg.zci-comp-bar");
    expect(svg).toBeTruthy();

    // 四分段：data-group 标识 + 段宽按校准值/精确总量比例（手算：151/625=24.16 等）
    const segs = [...svg.querySelectorAll("rect.zci-comp-seg")];
    expect(segs.map((s) => s.getAttribute("data-group"))).toEqual(["system", "tools", "history", "currentTurn"]);
    expect(parseFloat(segs[0].getAttribute("width"))).toBeCloseTo((151 / 625) * 100, 1);
    expect(parseFloat(segs[1].getAttribute("width"))).toBeCloseTo((124 / 625) * 100, 1);
    expect(parseFloat(segs[2].getAttribute("width"))).toBeCloseTo((213 / 625) * 100, 1);
    expect(parseFloat(segs[3].getAttribute("width"))).toBeCloseTo((137 / 625) * 100, 1);
    // 段起点衔接（x 累计）
    expect(parseFloat(segs[1].getAttribute("x"))).toBeCloseTo((151 / 625) * 100, 1);

    // "估算"角标（ADR-0002：估算必须标注，不冒充精确）
    expect(root.querySelector(".zci-badge-estimate")).toBeTruthy();

    // 顶部总量为 API 精确值 625（非原始折算加总 500）
    expect(root.textContent).toContain("625");
    expect(root.textContent).not.toContain("500");

    // 四分组名（GLOSSARY 固定命名）与图例数值
    expect(root.textContent).toContain("system 提示");
    expect(root.textContent).toContain("工具定义");
    expect(root.textContent).toContain("历史消息");
    expect(root.textContent).toContain("当前轮");
    expect(root.textContent).toContain("151");

    // 锚点说明（最近 full 请求）
    expect(root.textContent).toContain("req-main-3");
  });

  it("纯 delta 会话：只显示精确总量，组成条为说明性空态（无估算角标、无分段）", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_composition: COMPOSITION_RESULT({
          anchor: null,
          composition: null,
          compositionReason: "no-full-snapshot",
          exactTotalTokens: 520,
        }),
      },
    });
    await mountPanel({ win: window, target: host.target });

    const root = document.getElementById("root");
    expect(root.querySelector(".zci-comp-empty")).toBeTruthy();
    expect(root.querySelectorAll("rect.zci-comp-seg")).toHaveLength(0);
    expect(root.querySelector(".zci-badge-estimate")).toBeNull();
    // 空态说明 + 精确总量仍然展示
    expect(root.textContent).toContain("无法估算");
    expect(root.textContent).toContain("520");
  });

  it("rollout 文件缺失（宿主清理，ADR-0001 预期）：说明性降级而非白屏", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_composition: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ available: false, reason: "rollout-not-found", session: { id: "session_x", source: "inferred" }, exactTotalTokens: null, anchor: null, composition: null }),
            },
          ],
        },
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
    expect(root.textContent).toContain("组成不可用");
    expect(root.textContent).toContain("宿主清理"); // 预期行为明示而非报错
  });

  it("组成工具调用失败（桥错误）：降级提示，概览与用量区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT(HEARTBEAT_SESSION, MOCK_USAGE),
      },
      toolErrorNames: ["get_current_session_composition"],
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通");
    expect(root.textContent).toContain("1815"); // 用量区不受影响
    expect(root.textContent).toContain("组成暂不可用");
  });
});
