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

const STATS_RESULT = (session, stats) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ available: true, session, stats }),
    },
  ],
});

// 与 get_session_stats 夹具口径一致的 mock 载荷（真值来源：test/session-stats.test.mjs 手算）
const MOCK_STATS = {
  requests: 6,
  cacheHitRate: 0.85,
  contextExceededCount: 1,
  inputTokens: 4000,
  outputTokens: 405,
  reasoningTokens: 50,
  cacheReadTokens: 3400,
  cacheWriteTokens: 100,
  computedTotalTokens: 4405,
  ttftCount: 5,
  ttftP50Ms: 900,
  ttftP95Ms: 1500,
  retryCount: 2,
};

/** 按标签取统计卡的值节点文本（断言卡片的 label→value 邻近关系，而非全文模糊匹配） */
function statValue(root, label) {
  const card = [...root.querySelectorAll(".zci-stat")].find(
    (c) => c.querySelector(".zci-stat-label")?.textContent === label,
  );
  return card?.querySelector(".zci-stat-value")?.textContent;
}

describe("统计卡（get_session_stats → Context/Token/Timing 三组卡）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("三组卡渲染：Context/Token/Timing，命中率/分位数/计数按口径格式化", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_session_stats: STATS_RESULT(HEARTBEAT_SESSION, MOCK_STATS),
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");

    // 发出了统计工具调用
    const statsCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_session_stats",
    );
    expect(statsCall).toBeTruthy();

    // 三组标题（工单命名）
    expect(root.textContent).toContain("Context Stats");
    expect(root.textContent).toContain("Token Stats");
    expect(root.textContent).toContain("Timing Stats");

    // Context Stats：命中率 0.85 → 85.0%；超限计数原样
    expect(statValue(root, "缓存命中率")).toBe("85.0%");
    expect(statValue(root, "上下文超限")).toBe("1");

    // Token Stats：token 数值原样（服务端口径 4000/405/3400/100/4405）
    expect(statValue(root, "输入 token")).toBe("4000");
    expect(statValue(root, "输出 token")).toBe("405");
    expect(statValue(root, "缓存读 token")).toBe("3400");
    expect(statValue(root, "缓存写 token")).toBe("100");
    expect(statValue(root, "总量 token")).toBe("4405");

    // Timing Stats：毫秒带单位，计数原样
    expect(statValue(root, "TTFT p50")).toBe("900 ms");
    expect(statValue(root, "TTFT p95")).toBe("1500 ms");
    expect(statValue(root, "重试")).toBe("2");
    expect(statValue(root, "请求数")).toBe("6");
  });

  it("无数据（requests=0）：量值与比率/分位数显示占位 '—' 而非 0，计数显示真 0", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_session_stats: STATS_RESULT(HEARTBEAT_SESSION, {
          requests: 0,
          cacheHitRate: null,
          contextExceededCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          computedTotalTokens: 0,
          ttftCount: 0,
          ttftP50Ms: null,
          ttftP95Ms: null,
          retryCount: 0,
        }),
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");

    // 工单口径：无数据项显示占位而非 0
    expect(statValue(root, "缓存命中率")).toBe("—");
    expect(statValue(root, "TTFT p50")).toBe("—");
    expect(statValue(root, "TTFT p95")).toBe("—");
    expect(statValue(root, "输入 token")).toBe("—");
    expect(statValue(root, "总量 token")).toBe("—");
    // 计数类：没有发生就是真 0
    expect(statValue(root, "上下文超限")).toBe("0");
    expect(statValue(root, "重试")).toBe("0");
    expect(statValue(root, "请求数")).toBe("0");
  });

  it("统计不可用（available=false）时显示降级提示而非白屏，其他区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_session_stats: {
          content: [
            { type: "text", text: JSON.stringify({ available: false, reason: "db-not-found", session: null, stats: null }) },
          ],
        },
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
    expect(root.textContent).toContain("统计暂不可用");
  });

  it("统计工具调用失败（桥错误）时显示降级提示，用量区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT(HEARTBEAT_SESSION, MOCK_USAGE),
      },
      toolErrorNames: ["get_session_stats"],
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("心跳精确"); // 用量区不受影响
    expect(root.textContent).toContain("统计暂不可用");
  });
});

const FLEET_RESULT = (root, rootSessionSource = "heartbeat") => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ available: true, rootSessionSource, root }),
    },
  ],
});

/** Fleet 树节点 mock 构造（形状对照 src/server/fleet.ts 的 FleetNode） */
function fleetNode(id, title, taskType, usage, children = []) {
  return { id, title, taskType, parentId: null, timeCreated: 0, timeUpdated: 0, usage, children };
}

// 与 get_fleet_tree 夹具口径一致的三层树 mock（真值来源：test/fleet-tree.test.mjs 手算）
const FLEET_TREE = fleetNode(
  "session_00000000000000000000000000000001",
  "mock 主会话",
  "interactive",
  {
    requests: 6,
    inputTokens: 4000,
    outputTokens: 405,
    computedTotalTokens: 4405,
    durationMsTotal: 12700,
    errorRequests: 1,
    lastRequestStatus: "completed",
  },
  [
    fleetNode(
      "sess_subagent_agent_00000000-0000-4000-8000-000000000003",
      "mock 子代理",
      "subagent_child",
      {
        requests: 1,
        inputTokens: 2000,
        outputTokens: 300,
        computedTotalTokens: 2300,
        durationMsTotal: 4000,
        errorRequests: 0,
        lastRequestStatus: "completed",
      },
      [
        fleetNode(
          "sess_subagent_agent_00000000-0000-4000-8000-000000000004",
          "mock 孙代理",
          "subagent_child",
          {
            requests: 2,
            inputTokens: 1100,
            outputTokens: 100,
            computedTotalTokens: 1200,
            durationMsTotal: 1800,
            errorRequests: 1,
            lastRequestStatus: "error",
          },
        ),
      ],
    ),
  ],
);

/** 按节点标题找 Fleet 节点卡片元素 */
function fleetCardByTitle(root, title) {
  return [...root.querySelectorAll(".zci-fleet-node")].find((c) =>
    c.querySelector(".zci-fleet-node-title")?.textContent.includes(title),
  );
}

describe("Fleet 代理网络树（get_fleet_tree → 树形渲染 + 节点卡片）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("三层树渲染：节点卡片含 token/请求耗时/状态，DOM 嵌套反映父子关系", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_fleet_tree: FLEET_RESULT(FLEET_TREE),
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");

    // 发出了 Fleet 工具调用
    const fleetCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_fleet_tree",
    );
    expect(fleetCall).toBeTruthy();

    // 三个节点全部渲染（含孙代理）
    expect(fleetCardByTitle(root, "mock 主会话")).toBeTruthy();
    expect(fleetCardByTitle(root, "mock 子代理")).toBeTruthy();
    expect(fleetCardByTitle(root, "mock 孙代理")).toBeTruthy();

    // 节点卡片：token / 请求耗时 / 状态（mock 返回原样呈现）
    const mainCard = fleetCardByTitle(root, "mock 主会话");
    expect(mainCard.textContent).toContain("4405"); // 总量 token
    expect(mainCard.textContent).toContain("12700"); // 请求耗时合计
    expect(mainCard.textContent).toContain("已完成"); // lastRequestStatus=completed
    const subsubCard = fleetCardByTitle(root, "mock 孙代理");
    expect(subsubCard.textContent).toContain("错误"); // lastRequestStatus=error

    // 树形嵌套：孙代理卡片是子代理卡片的后代，子代理是主会话的后代
    const subCard = fleetCardByTitle(root, "mock 子代理");
    expect(subCard.contains(subsubCard)).toBe(true);
    expect(mainCard.contains(subCard)).toBe(true);
  });

  it("单节点树（无子代理会话）：只渲染根节点，无子层容器", async () => {
    const single = fleetNode("session_00000000000000000000000000000002", "mock 无子会话", "interactive", {
      requests: 1,
      inputTokens: 300,
      outputTokens: 50,
      computedTotalTokens: 350,
      durationMsTotal: 2000,
      errorRequests: 0,
      lastRequestStatus: "completed",
    });
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_fleet_tree: FLEET_RESULT(single, "explicit"),
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");

    const nodes = root.querySelectorAll(".zci-fleet-node");
    expect(nodes).toHaveLength(1); // 单节点树
    expect(nodes[0].textContent).toContain("mock 无子会话");
    expect(nodes[0].textContent).toContain("350"); // 用量数字仍在卡片上
  });

  it("Fleet 不可用（available=false）：降级提示而非白屏，其余区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_fleet_tree: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ available: false, reason: "db-not-found", rootSessionSource: null, root: null }),
            },
          ],
        },
      },
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
    expect(root.textContent).toContain("代理网络暂不可用");
  });

  it("Fleet 工具调用失败（桥错误）：降级提示，用量区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT(HEARTBEAT_SESSION, MOCK_USAGE),
      },
      toolErrorNames: ["get_fleet_tree"],
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("心跳精确"); // 用量区不受影响
    expect(root.textContent).toContain("代理网络暂不可用");
  });
});
