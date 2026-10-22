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
import { t } from "./i18n.ts";
import { BridgeClient, PostMessageTransport } from "./bridge.ts";
import type { PostTarget } from "./bridge.ts";
import { renderSettingsSection, type SettingsPayload } from "./views/settings.ts";

/** MCP Apps 协议版本（研究笔记 02 §2，与官方面板一致） */
export const PROTOCOL_VERSION = "2026-01-26";

/** dataVersion 轮询间隔默认值（server 侧防抖 200ms，面板 3s 轮询 → 数据变更秒级感知） */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/** 挂载结果句柄：手动刷新入口与卸载清理（轮询定时器等） */
export interface MountHandle {
  /** 立即重拉用量数据并更新视图（手动刷新按钮同款路径） */
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

/** 挂载失败（get_overview 路径错误）时返回的空句柄：保持 MountHandle 契约完整 */
function noopHandle(): MountHandle {
  return {
    refresh: async () => {},
    dispose: () => {},
  };
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

  let result: { content?: Array<{ type: string; text?: string }> };
  try {
    result = (await bridge.request("tools/call", {
      name: "get_overview",
      arguments: {},
    })) as { content?: Array<{ type: string; text?: string }> };
  } catch (err) {
    renderError(container, err instanceof Error ? err.message : String(err));
    return noopHandle();
  }

  const textBlock = result.content?.find((c) => c.type === "text");
  if (!textBlock?.text) {
    renderError(container, t("overviewNoText"));
    return noopHandle();
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

  // 设置（T12）：经工具读取（持久层在 server 侧 settings.json），失败降级不炸面板
  const settings = await bridge.callToolJson<SettingsPayload>("get_settings", {});

  // ---- 渲染骨架与刷新机制（T12：手动按钮兜底 + dataVersion 轮询自动刷新） ----
  const doc = container.ownerDocument;
  let disposed = false;
  let lastDataVersion: number | null = null;
  let usageSection = renderUsageSection(doc, usage);

  /** 重拉当前会话用量并替换用量区（手动刷新按钮与轮询共用路径） */
  const refreshUsage = async (): Promise<void> => {
    const fresh = await bridge.callToolJson<UsagePayload>("get_current_session_usage", {});
    if (disposed || !fresh) return; // 拉取失败/已卸载：保持现状（下次轮询再试）
    const next = renderUsageSection(container.ownerDocument, fresh);
    usageSection.replaceWith(next);
    usageSection = next;
  };

  renderOverview(
    container,
    init,
    JSON.parse(textBlock.text),
    usageSection,
    renderSettingsSection(doc, bridge, settings),
    () => void refreshUsage(),
  );

  // 自动刷新：轻量轮询 get_data_version，版本变化才重拉数据视图
  // （server 侧 fs.watch 感知 db.sqlite/rollout 变更 → dataVersion 单调递增）
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (pollMs > 0) {
    timer = setInterval(() => {
      void (async () => {
        const version = await bridge.callToolJson<{ dataVersion: number }>("get_data_version", {});
        if (!version || disposed) return;
        if (lastDataVersion !== null && version.dataVersion !== lastDataVersion) {
          await refreshUsage();
        }
        lastDataVersion = version.dataVersion; // 首轮只记录基线，不触发刷新
      })();
    }, pollMs);
  }

  return {
    refresh: refreshUsage,
    dispose(): void {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
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

/** 键值行（概览区与用量区共用） */
function kvRow(doc: Document, label: string, value: string | undefined): HTMLElement {
  const row = el(doc, "div", "zci-kv");
  row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value ?? "-"));
  return row;
}

function renderOverview(
  container: HTMLElement,
  init: { hostInfo?: { name?: string; version?: string } },
  payload: { plugin?: string; version?: string; server?: string; greeting?: string },
  usageSection: HTMLElement,
  settingsSection: HTMLElement,
  onRefresh: () => void,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();

  // 手动刷新按钮（T12 兜底；自动刷新失效或等待轮询窗口时可立即拉新）
  const refreshButton = doc.createElement("button");
  refreshButton.className = "zci-refresh";
  refreshButton.type = "button";
  refreshButton.textContent = t("refreshButton");
  refreshButton.addEventListener("click", onRefresh);

  const header = el(doc, "header", "zci-header");
  header.append(
    el(doc, "h1", "zci-title", t("brandName")),
    el(doc, "span", "zci-version", payload.version ? `v${payload.version}` : ""),
    refreshButton,
  );

  const section = el(doc, "section", "zci-section");
  section.append(
    el(doc, "p", "zci-status", t("connectedHost", { host: init.hostInfo?.name ?? "host" })),
    kvRow(doc, t("kvPlugin"), payload.plugin),
    kvRow(doc, t("kvServer"), payload.server),
    el(doc, "p", "zci-greeting", payload.greeting ?? ""),
  );

  const footer = el(doc, "footer", "zci-footer", t("footerSkeleton"));

  container.append(header, section, usageSection, settingsSection, footer);
}

/** 当前会话精确用量区（T2）：数字 + 识别来源标注（心跳精确 / 推断）；不可用时降级提示 */
function renderUsageSection(doc: Document, usage: UsagePayload | null): HTMLElement {
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
    kvRow(doc, t("kvSession"), usage.session.id),
    kvRow(doc, t("kvRequests"), String(usage.usage.requests)),
    kvRow(doc, t("kvInputTokens"), String(usage.usage.inputTokens)),
    kvRow(doc, t("kvOutputTokens"), String(usage.usage.outputTokens)),
    kvRow(doc, t("kvCacheReadTokens"), String(usage.usage.cacheReadTokens)),
    kvRow(doc, t("kvCacheWriteTokens"), String(usage.usage.cacheWriteTokens)),
    kvRow(doc, t("kvTotalTokens"), String(usage.usage.computedTotalTokens)),
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
