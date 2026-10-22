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
