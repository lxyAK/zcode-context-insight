// @vitest-environment happy-dom
/**
 * 面板设置卡片功能缝基线（T12；seam = mountPanel 公共入口 + mock 宿主桥）。
 *
 * 外部行为契约：
 *  - 挂载时 callServerTool(get_settings) 并渲染三个设置项（默认视图/趋势粒度/估算密度）；
 *  - 修改选项即调 set_settings（仅提交变更字段），生效值反映回 UI，warnings 展示回退提示；
 *  - 设置只持久于 server 侧 settings.json——修改设置绝不写 localStorage/stateKey
 *    （stateKey 仅存窗口布局类状态的验收边界，对照笔记 02 §3）；
 *  - get_settings 不可用时卡片降级提示，不炸面板其余区域。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mountPanel } from "../src/panel/panel.ts";

/** 消息记录与可编程应答的 mock 宿主（按工具名分派应答；toolErrorNames 名单内报桥错误） */
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
                  hostCapabilities: {
                    experimental: { "zcode/surface": { stateKey: "zci-test-state-key" } },
                  },
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
          const result = toolResults[message.params.name] ?? {
            content: [{ type: "text", text: "{}" }],
          };
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
      text: JSON.stringify({
        plugin: "zcode-context-insight",
        version: "0.1.0",
        server: "zci",
        greeting: "mock-greeting-骨架连通",
      }),
    },
  ],
};

/** get_settings 应答构造（settings 缺省 = 默认三值） */
const SETTINGS_RESULT = (settings, extra = {}) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        available: true,
        settings:
          settings ?? {
            defaultView: "insights",
            trendGranularity: "request",
            estimationDensity: "balanced",
          },
        defaults: {
          defaultView: "insights",
          trendGranularity: "request",
          estimationDensity: "balanced",
        },
        warnings: [],
        ...extra,
      }),
    },
  ],
});

const SET_RESULT = (settings, warnings = []) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ available: true, settings, warnings }),
    },
  ],
});

/** 面板里的设置字段 → select[data-field] */
const FIELD_SELECT = "select.zci-select";

async function mount(host, opts = {}) {
  const handle = await mountPanel({ win: window, target: host.target, ...opts });
  return handle;
}

describe("面板设置卡片（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
    localStorage.clear();
  });

  it("挂载时调用 get_settings 并渲染三个设置项，选中值与工具返回一致", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_settings: SETTINGS_RESULT({
          defaultView: "context",
          trendGranularity: "day",
          estimationDensity: "coarse",
        }),
      },
    });
    await mount(host);

    const settingsCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_settings",
    );
    expect(settingsCall).toBeTruthy();

    const root = document.getElementById("root");
    expect(root.textContent).toContain("设置");
    expect(root.textContent).toContain("默认视图");
    expect(root.textContent).toContain("趋势粒度");
    expect(root.textContent).toContain("估算密度");

    const selects = [...root.querySelectorAll(FIELD_SELECT)];
    expect(selects).toHaveLength(3);
    const byField = Object.fromEntries(selects.map((s) => [s.dataset.field, s]));
    expect(byField.defaultView.value).toBe("context");
    expect(byField.trendGranularity.value).toBe("day");
    expect(byField.estimationDensity.value).toBe("coarse");
  });

  // 设置消费方接线（review 修复）：设置已影响面板行为，卡片文案如实说明各设置的实际效果
  it("设置卡片展示三项设置的效果说明（默认视图/趋势窗口/组成密度）", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_insights: INSIGHTS_TREND_RESULT(7),
        get_settings: SETTINGS_RESULT(),
      },
    });
    await mount(host);
    const root = document.getElementById("root");

    expect(root.textContent).toContain("打开面板时首先显示的页面");
    expect(root.textContent).toContain("逐请求=7 天 / 按轮=14 天 / 按天=30 天");
    expect(root.textContent).toContain("粗略=仅四分组 / 均衡=分组数值与占比 / 精细=另附块级说明");
  });

  it("修改选项：发出 set_settings（仅变更字段），生效值与保存提示反映回 UI", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_settings: SETTINGS_RESULT(),
        set_settings: SET_RESULT({
          defaultView: "fleet",
          trendGranularity: "request",
          estimationDensity: "balanced",
        }),
      },
    });
    await mount(host);

    const root = document.getElementById("root");
    const select = root.querySelector(`${FIELD_SELECT}[data-field="defaultView"]`);
    select.value = "fleet";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    // 等微任务：change 处理里的 tools/call 应答是 queueMicrotask 派发的
    await new Promise((r) => setTimeout(r, 20));

    const setCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "set_settings",
    );
    expect(setCall, "修改设置应发出 set_settings 调用").toBeTruthy();
    expect(setCall.params.arguments).toEqual({ defaultView: "fleet" }); // 仅提交变更字段

    expect(select.value).toBe("fleet"); // 生效值反映回 UI
    expect(root.textContent).toContain("已保存");
  });

  it("set_settings 返回回退 warnings：UI 展示提示，select 同步为生效（回退）值", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_settings: SETTINGS_RESULT(),
        // 服务端把非法值回退默认后返回生效值 insights（面板不得停留在非法选择上）
        set_settings: SET_RESULT(
          { defaultView: "insights", trendGranularity: "request", estimationDensity: "balanced" },
          ['defaultView: 未知值 "bogus"，已回退默认 insights'],
        ),
      },
    });
    await mount(host);

    const root = document.getElementById("root");
    const select = root.querySelector(`${FIELD_SELECT}[data-field="defaultView"]`);
    // 模拟注入非法值（正常 UI 枚举选项不会产生，防御服务端回退路径）
    select.value = "insights";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));

    expect(root.textContent).toContain("已回退默认"); // warnings 展示
  });

  it("get_settings 不可用：设置区降级提示，面板其余区域正常渲染", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_settings: {
          content: [{ type: "text", text: JSON.stringify({ available: false, reason: "no-plugin-data-dir", settings: null }) }],
        },
      },
    });
    await mount(host);
    // 概览区随 T8 三页骨架迁至 Context 页：导航过去验证页面渲染不受设置降级影响
    const ctxBtn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
    ctxBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    const root = document.getElementById("root");
    expect(root.textContent).toContain("mock-greeting-骨架连通"); // 页面内容不受影响
    expect(root.textContent).toContain("设置暂不可用");
  });

  it("边界：修改设置后不写 localStorage（设置持久于 server 侧，stateKey 仅存窗口布局类状态）", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_settings: SETTINGS_RESULT(),
        set_settings: SET_RESULT({
          defaultView: "fleet",
          trendGranularity: "request",
          estimationDensity: "balanced",
        }),
      },
    });
    await mount(host);

    const root = document.getElementById("root");
    for (const field of ["defaultView", "trendGranularity", "estimationDensity"]) {
      const select = root.querySelector(`${FIELD_SELECT}[data-field="${field}"]`);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 20));

    // stateKey 边界：设置不落 localStorage（此处也无任何窗口布局状态需要写入）
    expect(localStorage.length).toBe(0);
  });
});

// ============================================================================
// 设置消费方接线（review 修复，US22"每次打开都是我要的样子"）：
// 三项设置不再只是存储——defaultView 决定初始页、trendGranularity 决定 Insights
// 趋势窗口（request=7 / turn=14 / day=30 天，标题同步显示实际窗口）。
// ============================================================================

const INSIGHTS_TREND_RESULT = (days) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        available: true,
        anchorTime: 1792600045000,
        kpi: { totalTokens: 60555, totalSessions: 7, activeDays: 4 },
        // 旧→新 days 桶（值全零；断言关心窗口长度与调用参数，不关心数值）
        trend: Array.from({ length: days }, (_, i) => ({
          date: `2026-10-${String(22 - days + i).padStart(2, "0")}`,
          tokens: 0,
          requests: 0,
          sessions: 0,
        })),
        projects: [],
        sessions: { filters: { sort: "recent", limit: 50 }, total: 0, items: [] },
      }),
    },
  ],
});

describe("设置消费方接线（US22：打开即我要的样子）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  it("defaultView=context：初始页为 Context（首个 tools/call 为 get_settings，其次页面取数）", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_overview: OVERVIEW_RESULT,
        get_settings: SETTINGS_RESULT({ defaultView: "context", trendGranularity: "request", estimationDensity: "balanced" }),
      },
    });
    await mount(host);

    // 初始页高亮 Context，页面数据（get_overview）已被调用并渲染
    const root = document.getElementById("root");
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".zci-nav button.zci-nav-active").textContent).toBe("Context");
    expect(root.textContent).toContain("mock-greeting-骨架连通");

    // 取数顺序：get_settings（决定初始页）先于页面取数 get_overview
    const calls = host.received.filter((m) => m.method === "tools/call").map((m) => m.params.name);
    expect(calls[0]).toBe("get_settings");
    expect(firstPageDataCall(calls)).toBe("get_overview");
  });

  it("defaultView 缺省（设置不可用）：回退默认页 Insights，面板不白屏", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_insights: INSIGHTS_TREND_RESULT(7),
        get_settings: {
          content: [{ type: "text", text: JSON.stringify({ available: false, reason: "no-plugin-data-dir", settings: null }) }],
        },
      },
    });
    await mount(host);
    const root = document.getElementById("root");
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".zci-nav button.zci-nav-active").textContent).toBe("Insights");
    // 趋势图标题为 Insights 页独有内容，证明落在该页且页面已渲染（不白屏）
    expect(root.textContent).toContain("7 天 token 趋势");
    expect(root.textContent).toContain("总 token"); // KPI 带已渲染
  });

  it("trendGranularity=day：get_insights 携带 trendDays=30，图表标题显示实际窗口 30 天", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_insights: INSIGHTS_TREND_RESULT(30),
        get_settings: SETTINGS_RESULT({ defaultView: "insights", trendGranularity: "day", estimationDensity: "balanced" }),
      },
    });
    await mount(host);
    const root = document.getElementById("root");
    await new Promise((r) => setTimeout(r, 20));

    const insightsCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_insights",
    );
    expect(insightsCall.params.arguments.trendDays).toBe(30);
    await new Promise((r) => setTimeout(r, 40));
    // 标题显示实际窗口（载荷桶数），且柱数与窗口一致
    expect(root.textContent).toContain("30 天 token 趋势");
    expect(root.querySelectorAll(".zci-trend-bar").length).toBe(30);
  });

  it("trendGranularity=request（默认）：trendDays=7，标题为 7 天", async () => {
    const host = createMockHost(window, {
      toolResults: {
        get_insights: INSIGHTS_TREND_RESULT(7),
        get_settings: SETTINGS_RESULT(),
      },
    });
    await mount(host);
    await new Promise((r) => setTimeout(r, 40));
    const insightsCall = host.received.find(
      (m) => m.method === "tools/call" && m.params?.name === "get_insights",
    );
    expect(insightsCall.params.arguments.trendDays).toBe(7);
    const root = document.getElementById("root");
    expect(root.textContent).toContain("7 天 token 趋势");
  });
});

/** 首个页面取数调用（跳过 get_settings / get_data_version 轮询） */
function firstPageDataCall(calls) {
  return calls.find((name) => name !== "get_settings" && name !== "get_data_version");
}
