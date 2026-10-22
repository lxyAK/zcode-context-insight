/**
 * 面板装配层（T8 起为路由壳）：ui/initialize 握手 → 壳（页头 + 三页导航 + 内容区 +
 * 设置固定区）→ navigate 装载页面。页面内容在 views/pages/ 各视图模块实现，经
 * views/registry.ts 的 PAGES 注册表挂载（后续工单的扩展缝）；本层只管桥协议、壳与路由。
 * 各区块取数经 PageContext.callTool（callServerTool 封装）；T6 的 Context Browser
 * 挂载在 Context 页（views/pages/context.ts），不经本层。
 *
 * T12 刷新机制并入路由壳：页头手动刷新按钮兜底；get_data_version 轮询（server 侧
 * fs.watch 感知 db.sqlite/rollout 变更）版本变化时重挂载当前页（保留路由参数），
 * mountPanel 返回 MountHandle 供卸载清理（轮询定时器等）。
 * 设置卡片（views/settings.ts）挂在三页之外的固定页尾区，跨页常驻、不随路由重挂载。
 */
import pkg from "../../package.json";
import { t } from "./i18n.ts";
import { BridgeClient, PostMessageTransport } from "./bridge.ts";
import type { PostTarget } from "./bridge.ts";
import { el } from "./views/dom.ts";
import {
  PAGES,
  DEFAULT_PAGE_ID,
  type PageContext,
  type RouteParams,
  type ToolCallResult,
} from "./views/registry.ts";
import { renderSettingsSection, type SettingsPayload } from "./views/settings.ts";

/** MCP Apps 协议版本（研究笔记 02 §2，与官方面板一致） */
export const PROTOCOL_VERSION = "2026-01-26";

/** dataVersion 轮询间隔默认值（server 侧防抖 200ms，面板 3s 轮询 → 数据变更秒级感知） */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/** 挂载结果句柄：手动刷新入口与卸载清理（轮询定时器等） */
export interface MountHandle {
  /** 立即重挂载当前页（手动刷新按钮同款路径；保留路由参数） */
  refresh(): Promise<void>;
  /** 停止轮询并标记废弃（面板卸载时调用；渲染容器由宿主销毁） */
  dispose(): void;
}

export interface MountOptions {
  win: Window & typeof globalThis;
  /** postMessage 目标，默认 window.parent（测试注入 mock） */
  target?: PostTarget;
  /** 渲染容器，默认 #root */
  container?: HTMLElement;
  /** dataVersion 轮询间隔毫秒（默认 3000；<=0 禁用自动刷新，仅手动） */
  pollIntervalMs?: number;
}

export async function mountPanel(opts: MountOptions): Promise<MountHandle> {
  const container = opts.container ?? opts.win.document.getElementById("root");
  if (!container) throw new Error(t("noRootContainer"));

  const transport = new PostMessageTransport(opts.win, opts.target ?? opts.win.parent);
  const bridge = new BridgeClient(transport);
  bridge.start();

  const init = (await bridge.request("ui/initialize", {
    appInfo: { name: pkg.name, version: pkg.version },
    appCapabilities: {
      tools: { listChanged: false },
      availableDisplayModes: ["inline", "fullscreen"],
    },
    protocolVersion: PROTOCOL_VERSION,
  })) as { hostInfo?: { name?: string; version?: string } };

  bridge.notify("ui/notifications/initialized", {});

  /** callServerTool 封装：解析 text 块 JSON；桥错误转 { ok:false, error }（页面渲染，不吞错） */
  const callTool = async (
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult> => {
    try {
      const result = (await bridge.request("tools/call", {
        name,
        arguments: args ?? {},
      })) as { content?: Array<{ type: string; text?: string }> };
      const text = result.content?.find((c) => c.type === "text")?.text;
      if (!text) return { ok: false, error: t("overviewNoText") };
      return { ok: true, payload: JSON.parse(text) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // ---- 壳：页头（标题 + 已连接 + 刷新按钮）+ 页导航 + 内容区 + 设置固定区 ----
  const doc = container.ownerDocument;
  container.replaceChildren();
  let disposed = false;

  // 手动刷新按钮（T12 兜底；自动刷新失效或等待轮询窗口时可立即拉新）
  const refreshButton = doc.createElement("button");
  refreshButton.className = "zci-refresh";
  refreshButton.type = "button";
  refreshButton.textContent = t("refreshButton");

  const header = el(doc, "header", "zci-header");
  header.append(
    el(doc, "h1", "zci-title", t("brandName")),
    el(doc, "span", "zci-version", t("headerConnected", { host: init.hostInfo?.name ?? "host" })),
    refreshButton,
  );

  const nav = el(doc, "nav", "zci-nav");
  const content = el(doc, "main", "zci-content");
  const navButtons = new Map<string, HTMLButtonElement>();
  for (const page of PAGES) {
    const btn = el(doc, "button", "zci-nav-btn", page.title) as HTMLButtonElement;
    btn.type = "button";
    btn.addEventListener("click", () => navigate(page.id, {}));
    nav.append(btn);
    navButtons.set(page.id, btn);
  }

  // 设置卡片（T12）：三页之外的固定页尾区（设置持久于 server 侧 settings.json，
  // 经 get/set_settings 工具读写）；取数在默认页装载发起之后进行（见 mountPanel 尾部），
  // 保证首个 tools/call 是默认页取数（get_insights）
  const settingsArea = el(doc, "aside", "zci-settings-area");

  container.append(header, nav, content, settingsArea);

  /** 当前页路由状态（refresh 重挂载时保留参数，如 Insights 卡片跳转的 sessionId） */
  let currentPage = { id: DEFAULT_PAGE_ID, params: {} as RouteParams };

  /** 路由：高亮导航 + 清空内容区 + 装载目标页（挂载错误渲染进内容区而非白屏） */
  const navigate = (pageId: string, params: RouteParams = {}): Promise<void> => {
    const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
    currentPage = { id: page.id, params };
    for (const [id, btn] of navButtons) btn.classList.toggle("zci-nav-active", id === page.id);
    content.replaceChildren();
    const ctx: PageContext = {
      doc,
      container: content,
      params,
      navigate,
      callTool,
      hostName: init.hostInfo?.name,
    };
    return Promise.resolve(page.mount(ctx)).then(undefined, (err: unknown) => {
      content.replaceChildren(
        el(
          doc,
          "p",
          "zci-error",
          t("pageLoadFailed", {
            page: page.title,
            message: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    });
  };

  /** 手动/自动刷新共用路径（T12 语义并入路由壳）：重挂载当前页，整页重取数 */
  const refresh = async (): Promise<void> => {
    if (disposed) return; // 已卸载：不再触碰 DOM
    await navigate(currentPage.id, currentPage.params);
  };

  refreshButton.addEventListener("click", () => void refresh());

  // 默认页装载（navigate 同步发出首个页面取数 get_insights），设置取数随后并行进行，
  // 两者都完成后返回句柄（挂载完成即首屏可见，无两页并挂竞态）
  const initialMount = navigate(DEFAULT_PAGE_ID, {});
  const settings = await bridge.callToolJson<SettingsPayload>("get_settings", {});
  settingsArea.append(renderSettingsSection(doc, bridge, settings));
  await initialMount;

  // 自动刷新：轻量轮询 get_data_version，版本变化才重挂载当前页
  // （server 侧 fs.watch 感知 db.sqlite/rollout 变更 → dataVersion 单调递增）
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    let lastDataVersion: number | null = null;
    timer = setInterval(() => {
      void (async () => {
        const version = await bridge.callToolJson<{ dataVersion: number }>("get_data_version", {});
        if (!version || disposed) return;
        if (lastDataVersion !== null && version.dataVersion !== lastDataVersion) {
          await refresh();
        }
        lastDataVersion = version.dataVersion; // 首轮只记录基线，不触发刷新
      })();
    }, pollMs);
  }

  return {
    refresh,
    dispose(): void {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
