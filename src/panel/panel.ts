/**
 * 面板装配层：ui/initialize 握手 → callServerTool(get_overview / get_current_session_usage /
 * get_current_session_composition / get_session_stats / get_session_events /
 * get_session_file_activity / get_activity_insights) → 渲染。
 * 页面骨架（页头 + 概览区 + 用量区 + 组成区 + 统计区 + 事件流/文件活动 + Insights 活跃区）
 * 在此；后续工单的页面（Insights 页注册表 / Context 仪表盘 / Fleet）以新文件加入并在
 * renderOverview 处替换/扩展，不动桥协议层。
 */

/** 通用工具文本载荷解析：取首个 text 块 JSON；无文本返回 null */
async function callTextTool(
  bridge: BridgeClient,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = (await bridge.request("tools/call", {
      name,
      arguments: {},
    })) as { content?: Array<{ type: string; text?: string }> };
    const text = result.content?.find((c) => c.type === "text")?.text;
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    return null; // 桥错误 → 降级提示（各视图自行处理 null）
  }
}

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
import { t } from "./i18n.ts";
import { BridgeClient, PostMessageTransport } from "./bridge.ts";
import type { PostTarget } from "./bridge.ts";
import { renderCompositionSection, type CompositionPayload } from "./views/composition.ts";
import { renderActivitySection } from "./views/activity.ts";
import type { ActivityPayload } from "./views/activity.ts";
import { renderStatsSection, type SessionStatsPayload } from "./views/stats.ts";
import { renderEventsSection, renderFileActivitySection } from "./views/events.ts";
import type { EventsPayload, FileActivityPayload } from "./views/events.ts";

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
    renderError(container, t("overviewNoText"));
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

  // 上下文组成（T3）：独立 try/catch，失败不炸其他区块
  let composition: CompositionPayload | null = null;
  try {
    const compResult = (await bridge.request("tools/call", {
      name: "get_current_session_composition",
      arguments: {},
    })) as { content?: Array<{ type: string; text?: string }> };
    const compText = compResult.content?.find((c) => c.type === "text")?.text;
    composition = compText ? (JSON.parse(compText) as CompositionPayload) : null;
  } catch {
    composition = null;
  }

  // 会话统计（T5）：三组统计卡，失败不炸用量区
  let stats: SessionStatsPayload | null = null;
  try {
    const statsResult = (await bridge.request("tools/call", {
      name: "get_session_stats",
      arguments: {},
    })) as { content?: Array<{ type: string; text?: string }> };
    const statsText = statsResult.content?.find((c) => c.type === "text")?.text;
    stats = statsText ? (JSON.parse(statsText) as SessionStatsPayload) : null;
  } catch {
    stats = null; // 桥错误 → 降级提示
  }

  // 事件流与文件活动（T7）：并行取数，失败各自降级为空态/暂不可用
  // Insights 活跃数据（T9）：失败只降级活跃区
  const [eventsPayload, fileActivityPayload, activityPayload] = await Promise.all([
    callTextTool(bridge, "get_session_events"),
    callTextTool(bridge, "get_session_file_activity"),
    callTextTool(bridge, "get_activity_insights"),
  ]);

  renderOverview(
    container,
    init,
    JSON.parse(textBlock.text),
    usage,
    composition,
    stats,
    activityPayload as ActivityPayload | null,
  );
  container.append(
    renderEventsSection(container.ownerDocument, eventsPayload as EventsPayload | null),
    renderFileActivitySection(container.ownerDocument, fileActivityPayload as FileActivityPayload | null),
  );
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
  composition: CompositionPayload | null,
  stats: SessionStatsPayload | null,
  activity: ActivityPayload | null,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();

  const header = el(doc, "header", "zci-header");
  header.append(
    el(doc, "h1", "zci-title", t("brandName")),
    el(doc, "span", "zci-version", payload.version ? `v${payload.version}` : ""),
  );

  const section = el(doc, "section", "zci-section");
  const kv = (label: string, value: string | undefined) => {
    const row = el(doc, "div", "zci-kv");
    row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value ?? "-"));
    return row;
  };
  section.append(
    el(doc, "p", "zci-status", t("connectedHost", { host: init.hostInfo?.name ?? "host" })),
    kv(t("kvPlugin"), payload.plugin),
    kv(t("kvServer"), payload.server),
    el(doc, "p", "zci-greeting", payload.greeting ?? ""),
  );

  const footer = el(doc, "footer", "zci-footer", t("footerSkeleton"));

  container.append(
    header,
    section,
    renderUsageSection(doc, usage, kv),
    renderCompositionSection(doc, composition),
    renderStatsSection(doc, stats),
    renderActivitySection(doc, activity),
    footer,
  );
}

/** 当前会话精确用量区（T2）：数字 + 识别来源标注（心跳精确 / 推断）；不可用时降级提示 */
function renderUsageSection(
  doc: Document,
  usage: UsagePayload | null,
  kv: (label: string, value: string | undefined) => HTMLElement,
): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", t("usageTitle"));
  section.append(title);

  if (!usage?.available || !usage.usage || !usage.session) {
    section.append(el(doc, "p", "zci-status", t("usageUnavailable")));
    return section;
  }

  // 识别来源标注（ADR-0003：heartbeat=心跳精确；inferred=最近活跃推断）
  const badge = el(
    doc,
    "span",
    usage.session.source === "heartbeat" ? "zci-badge zci-badge-exact" : "zci-badge zci-badge-inferred",
    usage.session.source === "heartbeat" ? t("badgeHeartbeat") : t("badgeInferred"),
  );
  title.append(badge);

  section.append(
    kv(t("kvSession"), usage.session.id),
    kv(t("kvRequests"), String(usage.usage.requests)),
    kv(t("kvInputTokens"), String(usage.usage.inputTokens)),
    kv(t("kvOutputTokens"), String(usage.usage.outputTokens)),
    kv(t("kvCacheReadTokens"), String(usage.usage.cacheReadTokens)),
    kv(t("kvCacheWriteTokens"), String(usage.usage.cacheWriteTokens)),
    kv(t("kvTotalTokens"), String(usage.usage.computedTotalTokens)),
  );
  return section;
}

function renderError(container: HTMLElement, message: string): void {
  const doc = container.ownerDocument;
  container.replaceChildren(
    el(doc, "header", "zci-header", ""),
    el(doc, "p", "zci-error", t("toolCallFailed", { message })),
  );
  const header = container.querySelector(".zci-header");
  if (header) header.append(el(doc, "h1", "zci-title", t("brandName")));
}
