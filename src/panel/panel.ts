/**
 * 面板装配层：ui/initialize 握手 → callServerTool(get_overview / get_current_session_usage) → 渲染。
 * 页面骨架（页头 + 概览区 + 当前会话用量区）在此；后续工单的页面（Insights / Context 仪表盘 / Fleet）
 * 以新文件加入并在 renderOverview 处替换/扩展，不动桥协议层。
 */

/** 当前会话用量载荷（get_current_session_usage 的 structuredContent 形状） */
interface UsagePayload {
  available: boolean;
  reason?: string;
  session?: {
    id: string;
    source: "heartbeat" | "inferred";
    title: string | null;
  } | null;
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    computedTotalTokens: number;
  } | null;
}
import pkg from "../../package.json";
import { BridgeClient, PostMessageTransport } from "./bridge.ts";
import type { PostTarget } from "./bridge.ts";

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
  if (!container) throw new Error("面板缺少 #root 容器");

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

  let result: { content?: Array<{ type: string; text?: string }> };
  try {
    result = (await bridge.request("tools/call", {
      name: "get_overview",
      arguments: {},
    })) as { content?: Array<{ type: string; text?: string }> };
  } catch (err) {
    renderError(container, err instanceof Error ? err.message : String(err));
    return;
  }

  const textBlock = result.content?.find((c) => c.type === "text");
  if (!textBlock?.text) {
    renderError(container, "get_overview 未返回文本内容");
    return;
  }

  // 当前会话用量（T2）：独立 try/catch，失败不炸概览区
  let usage: UsagePayload | null = null;
  try {
    const usageResult = (await bridge.request("tools/call", {
      name: "get_current_session_usage",
      arguments: {},
    })) as { content?: Array<{ type: string; text?: string }> };
    const usageText = usageResult.content?.find((c) => c.type === "text")?.text;
    usage = usageText ? (JSON.parse(usageText) as UsagePayload) : null;
  } catch {
    usage = null; // 桥错误 → 降级提示
  }

  renderOverview(container, init, JSON.parse(textBlock.text), usage);
}

function el(
  doc: Document,
  tag: string,
  className: string,
  text?: string,
): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderOverview(
  container: HTMLElement,
  init: { hostInfo?: { name?: string; version?: string } },
  payload: { plugin?: string; version?: string; server?: string; greeting?: string },
  usage: UsagePayload | null,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();

  const header = el(doc, "header", "zci-header");
  header.append(
    el(doc, "h1", "zci-title", "Context Insight"),
    el(doc, "span", "zci-version", payload.version ? `v${payload.version}` : ""),
  );

  const section = el(doc, "section", "zci-section");
  const kv = (label: string, value: string | undefined) => {
    const row = el(doc, "div", "zci-kv");
    row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value ?? "-"));
    return row;
  };
  section.append(
    el(doc, "p", "zci-status", `已连接 ${init.hostInfo?.name ?? "host"}`),
    kv("插件", payload.plugin),
    kv("MCP server", payload.server),
    el(doc, "p", "zci-greeting", payload.greeting ?? ""),
  );

  const footer = el(doc, "footer", "zci-footer", "骨架就绪：后续工单将在此装载 Insights / Context 仪表盘 / Fleet 页面。");

  container.append(header, section, renderUsageSection(doc, usage, kv), footer);
}

/** 当前会话精确用量区（T2）：数字 + 识别来源标注（心跳精确 / 推断）；不可用时降级提示 */
function renderUsageSection(
  doc: Document,
  usage: UsagePayload | null,
  kv: (label: string, value: string | undefined) => HTMLElement,
): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", "当前会话精确用量");
  section.append(title);

  if (!usage?.available || !usage.usage || !usage.session) {
    section.append(el(doc, "p", "zci-status", "用量暂不可用（未检测到宿主数据库或心跳）"));
    return section;
  }

  // 识别来源标注（ADR-0003：heartbeat=心跳精确；inferred=最近活跃推断）
  const badge = el(
    doc,
    "span",
    usage.session.source === "heartbeat" ? "zci-badge zci-badge-exact" : "zci-badge zci-badge-inferred",
    usage.session.source === "heartbeat" ? "心跳精确" : "推断（最近活跃会话）",
  );
  title.append(badge);

  section.append(
    kv("会话", usage.session.id),
    kv("请求数", String(usage.usage.requests)),
    kv("输入 token", String(usage.usage.inputTokens)),
    kv("输出 token", String(usage.usage.outputTokens)),
    kv("缓存读 token", String(usage.usage.cacheReadTokens)),
    kv("缓存写 token", String(usage.usage.cacheWriteTokens)),
    kv("总量 token", String(usage.usage.computedTotalTokens)),
  );
  return section;
}

function renderError(container: HTMLElement, message: string): void {
  const doc = container.ownerDocument;
  container.replaceChildren(
    el(doc, "header", "zci-header", ""),
    el(doc, "p", "zci-error", `工具调用失败: ${message}`),
  );
  const header = container.querySelector(".zci-header");
  if (header) header.append(el(doc, "h1", "zci-title", "Context Insight"));
}
