/**
 * 面板装配层（T8 起为路由壳）：ui/initialize 握手 → 壳（页头 + 三页导航 + 内容区）
 * → navigate 装载页面。页面内容在 views/pages/ 各视图模块实现，经 views/registry.ts
 * 的 PAGES 注册表挂载（后续工单的扩展缝）；本层只管桥协议、壳与路由。
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

/** MCP Apps 协议版本（研究笔记 02 §2，与官方面板一致） */
export const PROTOCOL_VERSION = "2026-01-26";

export interface MountOptions {
  win: Window & typeof globalThis;
  /** postMessage 目标，默认 window.parent（测试注入 mock） */
  target?: PostTarget;
  /** 渲染容器，默认 #root */
  container?: HTMLElement;
}

export async function mountPanel(opts: MountOptions): Promise<void> {
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

  // ---- 壳：页头 + 页导航 + 内容区 ----
  const doc = container.ownerDocument;
  container.replaceChildren();

  const header = el(doc, "header", "zci-header");
  header.append(
    el(doc, "h1", "zci-title", t("brandName")),
    el(doc, "span", "zci-version", t("headerConnected", { host: init.hostInfo?.name ?? "host" })),
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

  container.append(header, nav, content);

  /** 路由：高亮导航 + 清空内容区 + 装载目标页（挂载错误渲染进内容区而非白屏） */
  const navigate = (pageId: string, params: RouteParams = {}): void => {
    const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
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
    Promise.resolve(page.mount(ctx)).catch((err: unknown) => {
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

  navigate(DEFAULT_PAGE_ID, {});
}
