// @vitest-environment happy-dom
/**
 * 面板活跃区（T9）mock 桥测试：
 * 测试 seam 是 mountPanel —— 经 postMessage JSON-RPC 桥 callServerTool(get_activity_insights)
 * 后，Insights 活跃区（SVG 热力图 + 模型/供应商环形图）渲染进容器。
 *
 * 必覆盖边界（工单验收）：空数据日期与单模型场景渲染不崩。
 *
 * mock 载荷数值为手算常量（与服务端测试同源，见 test/activity-insights.test.mjs 注释）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";

// 夹具同源常量（scripts/make-fixtures.mjs）
const T0 = 1792600000000;

/** 独立实现的本地日历日键（sv-SE locale 输出 YYYY-MM-DD） */
function dayKey(ms) {
  return new Date(ms).toLocaleDateString("sv-SE");
}

/** 精简 mock 宿主：只应答三个数据工具（get_overview / get_current_session_usage / get_activity_insights） */
function createMockHost(win, toolResults = {}) {
  const target = {
    postMessage(message) {
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
          const result = toolResults[message.params.name] ?? { content: [{ type: "text", text: "{}" }] };
          win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, result } }));
        }
      });
    },
  };
  return { target };
}

const OVERVIEW_RESULT = {
  content: [{ type: "text", text: JSON.stringify({ plugin: "zcode-context-insight", version: "0.1.0", server: "zci" }) }],
};

/** 构造 get_activity_insights 应答（daily 手算：D0=8/7740/4，D0-1=1/300/1，D0-2=1/500/1；见服务端测试注释） */
function activityResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const FULL_ACTIVITY = {
  available: true,
  rangeDays: 91,
  nowMs: T0 + 3600000,
  querySourcesExcluded: ["session_title"],
  daily: [
    { date: dayKey(T0 - 2 * 86400000 + 7200000), requests: 1, computedTotalTokens: 500, sessions: 1 },
    { date: dayKey(T0 - 86400000 + 3600000), requests: 1, computedTotalTokens: 300, sessions: 1 },
    { date: dayKey(T0 + 30000), requests: 8, computedTotalTokens: 7740, sessions: 4 },
  ],
  models: [
    { providerId: "account:fixture", modelId: "GLM-5.3", requests: 9, computedTotalTokens: 8240 },
    { providerId: "account:fixture-alt", modelId: "GLM-4.7", requests: 1, computedTotalTokens: 300 },
  ],
  providers: [
    { providerId: "account:fixture", requests: 9, computedTotalTokens: 8240 },
    { providerId: "account:fixture-alt", requests: 1, computedTotalTokens: 300 },
  ],
};

/** 百分比手算（环形图图例）：8240/8540=96.49→96.5%；300/8540=3.51→3.5% */
const MODEL_PCT = ["96.5%", "3.5%"];

function mountWith(activityPayload) {
  const host = createMockHost(window, {
    get_overview: OVERVIEW_RESULT,
    get_activity_insights: activityResult(activityPayload),
  });
  return mountPanel({ win: window, target: host.target });
}

describe("面板活跃区（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("热力图：按日聚合渲染 SVG，每格悬停 title 显示当日数值（工单验收 1）", async () => {
    await mountWith(FULL_ACTIVITY);

    const root = document.getElementById("root");
    const svg = root.querySelector("svg.zci-heatmap");
    expect(svg).toBeTruthy();

    // 窗口内每个日历日一格（91 天窗口 → 91 格；空数据日期渲染 0 级格而非缺失）
    const cells = svg.querySelectorAll("rect.zci-heat-cell");
    expect(cells.length).toBe(91);

    // D0 格子悬停显示当日数值：8 次请求 · 7740 token · 4 会话
    const d0 = svg.querySelector(`rect[data-date="${dayKey(T0 + 30000)}"]`);
    expect(d0).toBeTruthy();
    expect(d0.querySelector("title").textContent).toBe(
      `${dayKey(T0 + 30000)}｜8 次请求 · 7740 token · 4 会话`,
    );

    // 空数据日期：0 级格 + "无活动" 悬停（验收 3 前半）。选窗口内 5 天前（夹具行只覆盖最近 2 天）
    const emptyCell = svg.querySelector(`rect[data-date="${dayKey(T0 - 5 * 86400000)}"]`);
    expect(emptyCell.getAttribute("data-level")).toBe("0");
    expect(emptyCell.querySelector("title").textContent).toContain("无活动");

    // 有活动格子按活跃度分级（D0 是峰值日 → 最高级）
    expect(d0.getAttribute("data-level")).toBe("4");
  });

  it("环形图：按模型/供应商聚合 token 占比，图例含模型名与百分比（工单验收 2）", async () => {
    await mountWith(FULL_ACTIVITY);

    const root = document.getElementById("root");
    // 模型组成与按供应商两张环形图
    const donuts = root.querySelectorAll("svg.zci-donut");
    expect(donuts.length).toBe(2);

    const [modelDonut] = donuts;
    // 两段弧（两个模型）
    expect(modelDonut.querySelectorAll("circle.zci-donut-slice").length).toBe(2);
    // 悬停 title 显示数值与占比
    expect(modelDonut.querySelector("circle.zci-donut-slice > title").textContent).toContain("8240");
    expect(modelDonut.querySelector("circle.zci-donut-slice > title").textContent).toContain("96.5%");

    // 图例：模型名 + token + 百分比（手算：8240/8540 与 300/8540）
    const legend = root.querySelector(".zci-activity-models .zci-legend");
    expect(legend.textContent).toContain("GLM-5.3");
    expect(legend.textContent).toContain("GLM-4.7");
    for (const pct of MODEL_PCT) expect(legend.textContent).toContain(pct);

    // 供应商环形图图例
    const providerLegend = root.querySelector(".zci-activity-providers .zci-legend");
    expect(providerLegend.textContent).toContain("account:fixture");
  });

  it("单模型场景：环形图渲染完整圆环不崩（验收 3 边界）", async () => {
    await mountWith({
      ...FULL_ACTIVITY,
      models: [{ providerId: "account:fixture", modelId: "GLM-5.3", requests: 8, computedTotalTokens: 7740 }],
      providers: [{ providerId: "account:fixture", requests: 8, computedTotalTokens: 7740 }],
    });

    const root = document.getElementById("root");
    const donuts = root.querySelectorAll("svg.zci-donut");
    expect(donuts.length).toBe(2);

    for (const donut of donuts) {
      // 单段 = 100% 弧：一段 circle，dasharray 首值为整周长（2π×32≈201.06）
      const slice = donut.querySelector("circle.zci-donut-slice");
      expect(slice).toBeTruthy();
      const [len] = slice.getAttribute("stroke-dasharray").split(" ").map(Number);
      expect(len).toBeCloseTo(2 * Math.PI * 32, 1);
      expect(slice.querySelector("title").textContent).toContain("100.0%");
    }
    // 图例单项且含 100.0%
    const legend = root.querySelector(".zci-activity-models .zci-legend");
    expect(legend.textContent).toContain("GLM-5.3");
    expect(legend.textContent).toContain("100.0%");
  });

  it("空数据日期（窗口内完全无活动）：显示空态提示而非白屏（验收 3 边界）", async () => {
    await mountWith({
      available: true,
      rangeDays: 91,
      nowMs: T0 + 3600000,
      querySourcesExcluded: ["session_title"],
      daily: [],
      models: [],
      providers: [],
    });

    const root = document.getElementById("root");
    // 概览不受影响
    expect(root.textContent).toContain("zcode-context-insight");
    // 活跃区空态提示（热力图与环形图各自的空态）
    expect(root.textContent).toContain("窗口内无活动");
    // 不出现 NaN / undefined 之类的渲染残渣
    expect(root.textContent).not.toContain("NaN");
    expect(root.textContent).not.toContain("undefined");
  });

  it("available=false：活跃区降级提示，概览与当前会话用量不受影响", async () => {
    const host = createMockHost(window, {
      get_overview: OVERVIEW_RESULT,
      get_activity_insights: activityResult({ available: false, reason: "db-not-found", daily: null, models: null, providers: null }),
    });
    await mountPanel({ win: window, target: host.target });

    const root = document.getElementById("root");
    expect(root.textContent).toContain("zcode-context-insight");
    expect(root.textContent).toContain("活跃数据暂不可用");
  });

  it("工具调用桥错误：活跃区降级提示而非白屏", async () => {
    const host = createMockHost(window, { get_overview: OVERVIEW_RESULT });
    // 未提供 get_activity_insights 应答 → mock 返回 "{}"（available 缺省 falsy）→ 同样降级
    await mountPanel({ win: window, target: host.target });
    const root = document.getElementById("root");
    expect(root.textContent).toContain("活跃数据暂不可用");
  });
});
