// @vitest-environment happy-dom
/**
 * 面板挂载冒烟（mock 桥）：三页切换骨架 + Insights 页外部行为。
 * 缝 = mountPanel 公共入口：经 postMessage JSON-RPC 桥握手后按页调用 callServerTool 渲染。
 * mock 数据取自 test/insights.test.mjs 的手算夹具常量（工具返回形状与真实 get_insights 一致）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";

/** 轮询等待异步渲染完成（页面挂载经微任务/宏任务链，不暴露内部 Promise） */
async function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * mock 宿主：按工具名分派应答。
 * toolResults[name] 可为固定结果对象，或 (args, 该名第几次调用) => 结果对象（筛选交互需要按参数变答）。
 */
function createMockHost(win, { toolResults = {}, toolError, toolErrorNames = [] } = {}) {
  const received = [];
  const callCount = new Map();
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
          const spec = toolResults[message.params.name] ?? { content: [{ type: "text", text: "{}" }] };
          const result = typeof spec === "function"
            ? spec(message.params.arguments, (callCount.get(message.params.name) ?? 0) + 1)
            : spec;
          callCount.set(message.params.name, (callCount.get(message.params.name) ?? 0) + 1);
          win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, result } }));
        }
        // 通知（initialized 等）无需应答
      });
    },
  };
  return { target, received, callCount };
}

const text = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

// ---- 夹具常量（与 test/insights.test.mjs 手算值同源）----
const T0 = 1792600000000;
const DAY = 86400000;
const PROJ_A = "proj_d-.opensource-zcode-context-insight";
const PROJ_B = "proj_d-.opensource-other-project";
const S_MAIN = "session_00000000000000000000000000000001";
const S_SUB = "sess_subagent_agent_00000000-0000-4000-8000-000000000003";
const S_DAY1 = "session_00000000000000000000000000000011";
const S_DAY3 = "session_00000000000000000000000000000012";

const zero = { tokens: 0, requests: 0, sessions: 0 };
const TREND = [
  { date: "2026-10-15", ...zero },
  { date: "2026-10-16", ...zero },
  { date: "2026-10-17", ...zero },
  { date: "2026-10-18", tokens: 3000, requests: 2, sessions: 1 },
  { date: "2026-10-19", ...zero },
  { date: "2026-10-20", tokens: 50000, requests: 1, sessions: 1 },
  { date: "2026-10-21", tokens: 7055, requests: 8, sessions: 3 },
];

const items = (list) => list.map(([id, title, proj, dir, taskType, parentId, updated, req, tokens]) => ({
  id, title, projectId: proj, directory: dir, taskType, parentId,
  timeCreated: updated - 60000, timeUpdated: updated, requests: req, totalTokens: tokens,
}));

const ALL_ITEMS = items([
  [S_MAIN, "夹具主会话（当前）", PROJ_A, "D:\\.opensource\\zcode-context-insight", "interactive", null, T0 + 60000, 6, 4405],
  [S_SUB, "夹具子代理会话", PROJ_A, "D:\\.opensource\\zcode-context-insight", "subagent_child", S_MAIN, T0 + 50000, 1, 2300],
  ["session_00000000000000000000000000000002", "夹具旧会话", PROJ_A, "D:\\.opensource\\zcode-context-insight", "interactive", null, T0 + 30000, 1, 350],
  ["session_00000000000000000000000000000014", "夹具零用量会话", PROJ_A, "D:\\.opensource\\zcode-context-insight", "interactive", null, T0 - DAY + 8000000, 0, 0],
  [S_DAY1, "夹具项目A大会话", PROJ_A, "D:\\.opensource\\zcode-context-insight", "interactive", null, T0 - DAY + 7200000, 1, 50000],
  [S_DAY3, "夹具项目B会话", PROJ_B, "D:\\.opensource\\other-project", "interactive", null, T0 - 3 * DAY + 7200000, 2, 3000],
  ["session_00000000000000000000000000000013", "夹具项目B旧会话", PROJ_B, "D:\\.opensource\\other-project", "interactive", null, T0 - 8 * DAY + 7200000, 1, 500],
]);

/** 全量 Insights 载荷（默认无筛选） */
const insightsPayload = () => ({
  available: true,
  anchorTime: T0 + 45000,
  kpi: { totalTokens: 60555, totalSessions: 7, activeDays: 4 },
  trend: TREND,
  projects: [
    { id: PROJ_A, directory: "D:\\.opensource\\zcode-context-insight", sessions: 5 },
    { id: PROJ_B, directory: "D:\\.opensource\\other-project", sessions: 2 },
  ],
  sessions: {
    filters: { project: null, since: null, until: null, minTokens: null, sort: "recent", limit: 50 },
    total: 7,
    items: ALL_ITEMS,
  },
});

const OVERVIEW_RESULT = text({
  plugin: "zcode-context-insight",
  version: "0.1.0",
  server: "zci",
  greeting: "mock-greeting-骨架连通",
});

const USAGE_RESULT = text({
  available: true,
  session: {
    id: S_MAIN,
    source: "heartbeat",
    heartbeatAt: 1792600060000,
    title: "mock 会话",
    taskType: "interactive",
  },
  usage: {
    // 与 T5 夹具手算一致（S_MAIN 6 行；真值来源 test/session-stats.test.mjs 注释）
    requests: 6, inputTokens: 4000, outputTokens: 405, reasoningTokens: 50,
    cacheReadTokens: 3400, cacheWriteTokens: 100, computedTotalTokens: 4405, ttftMsTotal: 4200,
    byQuerySource: {},
  },
});

/** 面板默认装载所需的最小工具集（Insights 默认页 + Context 页数据） */
function defaultTools(extra = {}) {
  return {
    get_insights: () => text(insightsPayload()),
    get_overview: OVERVIEW_RESULT,
    get_current_session_usage: USAGE_RESULT,
    ...extra,
  };
}

const norm = (s) => s.replace(/,/g, "");

/**
 * 挂载（默认落 Insights 页）后切到 Context 页，等待指定标记渲染完成。
 * T3 组成条 / T5 统计卡 / T7 事件流区块都在 Context 页（T8 三页骨架）。
 */
async function mountContext(target, marker) {
  await mountPanel({ win: window, target });
  const btn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
  btn.click();
  const root = document.getElementById("root");
  await waitFor(() => (typeof marker === "function" ? marker() : root.textContent.includes(marker)));
  return root;
}

describe("面板三页骨架与路由（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("默认页为 Insights：首个 tools/call 是 get_insights，三页导航存在", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });

    const firstCall = host.received.find((m) => m.method === "tools/call");
    expect(firstCall.params.name).toBe("get_insights");

    // 协议顺序：initialize（2026-01-26）→ initialized 通知 → tools/call
    const init = host.received.find((m) => m.method === "ui/initialize");
    expect(init.params.protocolVersion).toBe("2026-01-26");
    expect(host.received.findIndex((m) => m.method === "ui/notifications/initialized")).toBeGreaterThan(
      host.received.indexOf(init),
    );

    const root = document.getElementById("root");
    const navBtns = [...root.querySelectorAll(".zci-nav button")].map((b) => b.textContent);
    expect(navBtns).toEqual(["Insights", "Context", "Fleet"]);
    // 默认页高亮 Insights
    expect(root.querySelector(".zci-nav button.zci-nav-active").textContent).toBe("Insights");
  });

  it("导航切到 Context：调用 get_overview + get_current_session_usage 并渲染概览与精确用量", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });

    const ctxBtn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
    ctxBtn.click();
    await waitFor(() => host.received.some((m) => m.method === "tools/call" && m.params?.name === "get_current_session_usage"));

    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通");
    expect(root.textContent).toContain("1510"); // 精确用量数字
    expect(root.textContent).toContain("心跳精确"); // 识别来源标注
  });

  it("导航切到 Fleet：渲染占位说明（T10 装载）", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });

    const fleetBtn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Fleet");
    fleetBtn.click();
    await waitFor(() => document.getElementById("root").textContent.includes("Fleet"));
    const root = document.getElementById("root");
    expect(root.textContent).toContain("待装载");
  });

  it("Insights 数据不可用（available=false）时降级提示，导航仍可用", async () => {
    const host = createMockHost(window, {
      toolResults: defaultTools({
        get_insights: text({ available: false, reason: "db-not-found", kpi: null, trend: null, sessions: null }),
      }),
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    // 页面渲染是路由的异步链，等待降级文案出现
    await waitFor(() => root.textContent.includes("暂不可用"));
    expect(root.textContent).toContain("db-not-found");

    // 导航未被降级态卡死
    const ctxBtn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
    ctxBtn.click();
    await waitFor(() => document.getElementById("root").textContent.includes("mock-greeting"));
  });

  it("get_insights 桥错误时渲染错误提示而非白屏", async () => {
    const host = createMockHost(window, {
      toolResults: { get_overview: OVERVIEW_RESULT },
      toolErrorNames: ["get_insights"],
    });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    await waitFor(() => root.textContent.includes("mock 工具失败"));
    expect(root.textContent.trim().length).toBeGreaterThan(0);
  });

  // ---- Context 页回归（原 T2 概览/用量行为迁入 Context 页后保持）----
  async function gotoContext() {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });
    const ctxBtn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
    ctxBtn.click();
    return host;
  }

  it("Context 页：识别来源为心跳时标注'心跳精确'", async () => {
    await gotoContext();
    const root = document.getElementById("root");
    await waitFor(() => root.textContent.includes("心跳精确"));
  });

  it("Context 页：识别来源为推断时标注'推断'而非'心跳精确'", async () => {
    const host = createMockHost(window, {
      toolResults: defaultTools({
        get_current_session_usage: text({
          available: true,
          session: { id: S_MAIN, source: "inferred", heartbeatAt: null, title: "mock 会话", taskType: "interactive" },
          usage: JSON.parse(USAGE_RESULT.content[0].text).usage,
        }),
      }),
    });
    await mountPanel({ win: window, target: host.target });
    [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context").click();
    await waitFor(() => document.getElementById("root").textContent.includes("推断"));
    expect(document.getElementById("root").textContent).not.toContain("心跳精确");
  });

  it("Context 页：用量不可用（available=false）时降级提示，概览仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: defaultTools({
        get_current_session_usage: text({ available: false, reason: "db-not-found", session: null, usage: null }),
      }),
    });
    await mountPanel({ win: window, target: host.target });
    [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context").click();
    await waitFor(() => document.getElementById("root").textContent.includes("mock-greeting"));
    const root = document.getElementById("root");
    expect(root.textContent).toContain("用量暂不可用");
    expect(root.textContent).toContain("db-not-found");
  });

  it("Context 页：get_overview 桥错误时渲染错误信息而非白屏", async () => {
    const host = createMockHost(window, {
      toolResults: { get_current_session_usage: USAGE_RESULT },
      toolErrorNames: ["get_overview"],
    });
    await mountPanel({ win: window, target: host.target });
    [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context").click();
    await waitFor(() => document.getElementById("root").textContent.includes("mock 工具失败"));
    expect(document.getElementById("root").textContent.trim().length).toBeGreaterThan(0);
  });
});

describe("Insights 页（KPI 带 / 7 天趋势 / 会话卡片）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("KPI 带渲染三项手算值（总 token / 会话数 / 活跃天数）", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    await waitFor(() => root.querySelectorAll(".zci-kpi-card").length === 3);

    const t = norm(root.textContent);
    expect(t).toContain("60555"); // T5 追加行后的全会话合计（见 test/insights.test.mjs 手算）
    expect(t).toContain("7");
    expect(t).toContain("4");
  });

  it("7 天趋势：7 根柱与日期标签（含窗口内非零日与零日首桶），峰值柱提示含 token 值", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    await waitFor(() => root.querySelectorAll(".zci-trend-bar").length === 7);

    const t = root.textContent;
    expect(t).toContain("10-15"); // 窗口首桶（零日也画）
    expect(t).toContain("10-18"); // 3000
    expect(t).toContain("10-20"); // 50000
    expect(t).toContain("10-21"); // 4465（锚点日）
    const chart = root.querySelector(".zci-trend");
    expect(chart.textContent).not.toContain("10-13"); // 窗口外不入趋势（会话卡片的时间不受此限制）
    const peak = [...root.querySelectorAll(".zci-trend-bar")].find((b) => b.getAttribute("data-date") === "2026-10-20");
    expect(peak).toBeTruthy();
    expect(norm(peak.textContent)).toContain("50000");
  });

  it("会话卡片：标题/项目/时间/token 渲染，子代理卡有标注，零用量卡在列", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    await waitFor(() => root.querySelectorAll(".zci-session-card").length === 7);

    const cards = root.querySelectorAll(".zci-session-card");
    const t = norm(root.textContent);
    expect(t).toContain("夹具主会话（当前）");
    expect(t).toContain("夹具项目A大会话");
    expect(t).toContain("50000");
    expect(t).toContain("夹具零用量会话");
    expect(t).toContain("other-project"); // 项目目录（卡片项目字段）
    // 子代理标注
    const subCard = [...cards].find((c) => c.textContent.includes("夹具子代理会话"));
    expect(subCard.textContent).toContain("子代理");
  });

  it("筛选交互：项目下拉变更 → get_insights 携带 project 参数并重渲染列表", async () => {
    const host = createMockHost(window, {
      toolResults: defaultTools({
        // 按入参返回对应项目的列表（模拟服务端筛选）
        get_insights: (args) => {
          const payload = insightsPayload();
          if (args?.project === PROJ_B) {
            payload.sessions = {
              filters: { project: PROJ_B, since: null, until: null, minTokens: null, sort: "recent", limit: 50 },
              total: 2,
              items: ALL_ITEMS.filter((s) => s.projectId === PROJ_B),
            };
          }
          return text(payload);
        },
      }),
    });
    await mountPanel({ win: window, target: host.target });
    await waitFor(() => document.querySelectorAll(".zci-session-card").length === 7);

    const select = document.querySelector(".zci-filter-project");
    expect(select).toBeTruthy();
    // 下拉选项：全部 + 两个项目
    expect([...select.options].map((o) => o.value)).toEqual(["", PROJ_A, PROJ_B]);

    select.value = PROJ_B;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      const calls = host.received.filter((m) => m.method === "tools/call" && m.params?.name === "get_insights");
      return calls.length >= 2 && calls[1].params.arguments.project === PROJ_B;
    });
    await waitFor(() => document.querySelectorAll(".zci-session-card").length === 2);
    const root = document.getElementById("root");
    expect(root.textContent).toContain("夹具项目B会话");
    expect(root.textContent).not.toContain("夹具主会话");
  });

  it("筛选交互：规模（≥1k）、时间（最近 7 天）与排序（tokens）参数传递", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });

    // 每次筛选变更会整页重取数重渲染：先等控件就绪再操作
    const filterReady = () => document.querySelector(".zci-filter-size") !== null;
    await waitFor(filterReady);
    const size = document.querySelector(".zci-filter-size");
    size.value = "1000";
    size.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() =>
      host.received.some((m) => m.method === "tools/call" && m.params?.name === "get_insights" && m.params.arguments.minTokens === 1000),
    );

    // 时间筛选：锚点（T0+45000）所在 UTC 日起往前第 7 天的日首（2026-10-15 00:00Z）
    await waitFor(filterReady); // 等重渲染完成（新控件树）
    const time = document.querySelector(".zci-filter-time");
    time.value = "7";
    time.dispatchEvent(new Event("change", { bubbles: true }));
    const expectedSince = Math.floor((T0 + 45000) / DAY) * DAY - 6 * DAY;
    await waitFor(() =>
      host.received.some((m) => m.method === "tools/call" && m.params?.name === "get_insights" && m.params.arguments.since === expectedSince),
    );

    await waitFor(filterReady);
    const sort = document.querySelector(".zci-filter-sort");
    sort.value = "tokens";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() =>
      host.received.some((m) => m.method === "tools/call" && m.params?.name === "get_insights"
        && m.params.arguments.sort === "tokens"
        && m.params.arguments.minTokens === 1000
        && m.params.arguments.since === expectedSince),
    );
  });

  it("点会话卡片 → 切换到该会话的 Context 仪表盘（sessionId 路由缝）", async () => {
    const host = createMockHost(window, { toolResults: defaultTools() });
    await mountPanel({ win: window, target: host.target });
    await waitFor(() => document.querySelectorAll(".zci-session-card").length === 7);

    const card = [...document.querySelectorAll(".zci-session-card")].find((c) =>
      c.textContent.includes("夹具项目A大会话"),
    );
    expect(card).toBeTruthy();
    card.click();

    // Context 页数据工具被调用
    await waitFor(() => host.received.some((m) => m.method === "tools/call" && m.params?.name === "get_overview"));
    const root = document.getElementById("root");
    await waitFor(() => root.textContent.includes("mock-greeting-骨架连通"));

    // 已选会话信息（路由参数带入：标题 + token 概要）
    expect(root.textContent).toContain("夹具项目A大会话");
    expect(norm(root.textContent)).toContain("50000");
    expect(root.textContent).toContain(S_DAY1);
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
    const root = await mountContext(host.target, () => document.querySelector("svg.zci-comp-bar") !== null);

    // 发出了组成工具调用
    const call = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_current_session_composition",
    );
    expect(call).toBeTruthy();

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
    const root = await mountContext(host.target, () => document.querySelector(".zci-comp-empty") !== null);
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
    const root = await mountContext(host.target, "组成不可用");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
    expect(root.textContent).toContain("宿主清理"); // 预期行为明示而非报错
  });

  it("组成工具调用失败（桥错误）：降级提示，概览与用量区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT,
      },
      toolErrorNames: ["get_current_session_composition"],
    });
    const root = await mountContext(host.target, "组成暂不可用");
    expect(root.textContent).toContain("mock-greeting-骨架连通");
    expect(root.textContent).toContain("4405"); // 用量区不受影响（T5 夹具口径）
  });
});

/** 统计卡 mock 的会话标注（源对象与 get_current_session_usage mock 同形） */
const STATS_SESSION = { id: S_MAIN, source: "heartbeat" };

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
        get_session_stats: STATS_RESULT(STATS_SESSION, MOCK_STATS),
      },
    });
    const root = await mountContext(host.target, "Context Stats");

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
        get_session_stats: STATS_RESULT(STATS_SESSION, {
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
    const root = await mountContext(host.target, "Timing Stats");

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
    const root = await mountContext(host.target, "统计暂不可用");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 概览不受影响
  });

  it("统计工具调用失败（桥错误）时显示降级提示，用量区仍渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_current_session_usage: USAGE_RESULT,
      },
      toolErrorNames: ["get_session_stats"],
    });
    const root = await mountContext(host.target, "统计暂不可用");
    expect(root.textContent).toContain("心跳精确"); // 用量区不受影响
  });
});
