// @vitest-environment happy-dom
/**
 * T7 面板视图缝（mock 桥）：mountPanel 挂载后应调用 get_session_events /
 * get_session_file_activity 并渲染两个列表视图（可滚动 .zci-list）；
 * 空数组显示空态、工具失败降级不炸概览。mock 载荷形状镜像工具 structuredContent。
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
          const result = toolResults[message.params.name] ?? { content: [{ type: "text", text: "{}" }] };
          win.dispatchEvent(new MessageEvent("message", { data: { jsonrpc: "2.0", id: message.id, result } }));
        }
      });
    },
  };
  return { target, received };
}

const text = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

const OVERVIEW_RESULT = text({
  plugin: "zcode-context-insight",
  version: "0.1.0",
  server: "zci",
  greeting: "mock-greeting",
});

const SESSION = { id: "session_00000000000000000000000000000001", source: "heartbeat", heartbeatAt: 1792600060000 };

// 载荷镜像 get_session_events 的 structuredContent（夹具 S_MAIN 手算值的子集）
const EVENTS_RESULT = text({
  available: true,
  session: SESSION,
  events: [
    { type: "model_change", time: 1792600015000, modelId: "GLM-5.3", providerId: "account:fixture" },
    { type: "model_change", time: 1792600035000, modelId: "GLM-5.4", providerId: "account:fixture" },
    { type: "compaction", time: 1792600055000, trigger: "auto", preCompactTokens: 1800, postCompactTokens: 300, truePostCompactTokens: 300, summarizedMessages: 2, keptMessages: 1 },
    { type: "compaction", time: 1792600058000, trigger: "manual", preCompactTokens: 4000, postCompactTokens: 900, truePostCompactTokens: 500, summarizedMessages: 5, keptMessages: 2 },
  ],
});

// 载荷镜像 get_session_file_activity 的 structuredContent（夹具 S_MAIN 手算值的子集）
const FILES_RESULT = text({
  available: true,
  session: SESSION,
  activities: [
    { time: 1792600016000, operation: "read", path: "D:\\repo\\src\\a.ts", detail: null, additions: null, deletions: null, status: "completed" },
    { time: 1792600017000, operation: "search", path: "D:\\repo\\src", detail: "handleRequest", additions: null, deletions: null, status: "completed" },
    { time: 1792600018000, operation: "edit", path: "D:\\repo\\src\\a.ts", detail: null, additions: 4, deletions: 3, status: "completed" },
    { time: 1792600019000, operation: "write", path: "D:\\repo\\out\\new.ts", detail: null, additions: 5, deletions: null, status: "completed" },
    { time: 1792600021000, operation: "edit", path: "D:\\repo\\src\\missing.ts", detail: null, additions: 1, deletions: 0, status: "error" },
  ],
});

const BASE_TOOLS = {
  get_overview: OVERVIEW_RESULT,
  get_current_session_usage: text({ available: false, reason: "db-not-found", session: null, usage: null }),
};

describe("面板事件流与文件活动视图（mock 桥）", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root">Loading…</div>';
  });

  /** 轮询等待异步渲染完成（T8 路由后页面挂载是异步链） */
  async function waitFor(cond, timeoutMs = 2000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 挂载（默认落 Insights 页）后切到 Context 页——T7 区块所在页，等最后一个区块渲染完 */
  async function mountContext(target) {
    await mountPanel({ win: window, target });
    const btn = [...document.querySelectorAll(".zci-nav button")].find((b) => b.textContent === "Context");
    btn.click();
    const root = document.getElementById("root");
    await waitFor(() => root.textContent.includes("文件活动"));
    return root;
  }

  it("挂载时调用两个 T7 工具，事件列表含压缩（触发方式+token 数）与模型切换（目标模型）", async () => {
    const host = createMockHost(window, {
      toolResults: { ...BASE_TOOLS, get_session_events: EVENTS_RESULT, get_session_file_activity: FILES_RESULT },
    });
    const root = await mountContext(host.target);

    // 发出了两个工具调用
    for (const name of ["get_session_events", "get_session_file_activity"]) {
      const call = host.received.find((m) => m.method === "tools/call" && m.params?.name === name);
      expect(call, `应调用 ${name}`).toBeTruthy();
    }

    // 压缩事件：触发方式与前后 token 数
    expect(root.textContent).toContain("压缩（自动）");
    expect(root.textContent).toContain("压缩（手动）");
    expect(root.textContent).toContain("1800 → 300");
    expect(root.textContent).toContain("4000 → 900");
    // 模型切换：目标模型
    expect(root.textContent).toContain("模型切换");
    expect(root.textContent).toContain("GLM-5.3");
    expect(root.textContent).toContain("GLM-5.4");
  });

  it("文件活动列表含路径、操作类型与行数变化；失败操作可识别", async () => {
    const host = createMockHost(window, {
      toolResults: { ...BASE_TOOLS, get_session_events: EVENTS_RESULT, get_session_file_activity: FILES_RESULT },
    });
    const root = await mountContext(host.target);
    // 操作类型
    expect(root.textContent).toContain("读取");
    expect(root.textContent).toContain("写入");
    expect(root.textContent).toContain("编辑");
    expect(root.textContent).toContain("搜索");
    // 路径与搜索 pattern
    expect(root.textContent).toContain("D:\\repo\\src\\a.ts");
    expect(root.textContent).toContain("D:\\repo\\out\\new.ts");
    expect(root.textContent).toContain("handleRequest");
    // 行数变化
    expect(root.textContent).toContain("+4");
    expect(root.textContent).toContain("-3");
    expect(root.textContent).toContain("+5");
    // 失败操作标注
    expect(root.textContent).toContain("失败");
  });

  it("两个列表为可滚动容器（.zci-list，样式契约由 panel.css 的 overflow 提供）", async () => {
    const host = createMockHost(window, {
      toolResults: { ...BASE_TOOLS, get_session_events: EVENTS_RESULT, get_session_file_activity: FILES_RESULT },
    });
    const root = await mountContext(host.target);
    const lists = root.querySelectorAll(".zci-list");
    expect(lists.length).toBe(2);
    // 事件列表 4 条、文件列表 5 条
    expect(lists[0].querySelectorAll(".zci-list-item").length).toBe(4);
    expect(lists[1].querySelectorAll(".zci-list-item").length).toBe(5);
  });

  it("无记录时两个视图均显示空态（.zci-empty），不是白屏也不是报错", async () => {
    const host = createMockHost(window, {
      toolResults: {
        ...BASE_TOOLS,
        get_session_events: text({ available: true, session: SESSION, events: [] }),
        get_session_file_activity: text({ available: true, session: SESSION, activities: [] }),
      },
    });
    const root = await mountContext(host.target);
    expect(root.textContent).toContain("暂无事件记录");
    expect(root.textContent).toContain("暂无文件活动记录");
    expect(root.querySelectorAll(".zci-empty").length).toBe(2);
  });

  it("T7 工具调用失败（桥错误）：概览与其他视图仍渲染，显示降级提示", async () => {
    const host = createMockHost(window, {
      toolResults: BASE_TOOLS,
      toolErrorNames: ["get_session_events", "get_session_file_activity"],
    });
    const root = await mountContext(host.target);
    expect(root.textContent).toContain("mock-greeting"); // 概览不受影响
    expect(root.textContent).toContain("事件暂不可用");
    expect(root.textContent).toContain("文件活动暂不可用");
  });

  it("available=false（db 缺失）：显示降级提示而非空列表", async () => {
    const host = createMockHost(window, {
      toolResults: {
        ...BASE_TOOLS,
        get_session_events: text({ available: false, reason: "db-not-found", session: null, events: null }),
        get_session_file_activity: text({ available: false, reason: "db-not-found", session: null, activities: null }),
      },
    });
    const root = await mountContext(host.target);
    expect(root.textContent).toContain("事件暂不可用");
    expect(root.textContent).toContain("文件活动暂不可用");
  });
});
