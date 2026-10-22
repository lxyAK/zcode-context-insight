/**
 * Context 仪表盘页（T2 概览与当前会话用量的既有内容迁入；T3-T7 区块在本页追加）。
 *
 * 路由缝：ctx.params.sessionId 存在时（来自 Insights 会话卡片跳转），
 * 顶部渲染"已选会话"横幅（卡片携带的概要数据）；后续工单的会话级区块
 * （组成条/逐请求趋势/统计卡等）直接读 ctx.params.sessionId 取数。
 */
import type { PageContext, PageDefinition } from "../registry.ts";
import { el, fmtInt, fmtDateTime } from "../dom.ts";

/** get_current_session_usage 载荷（structuredContent 形状的子集） */
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

interface OverviewPayload {
  plugin?: string;
  version?: string;
  server?: string;
  greeting?: string;
}

export const contextPage: PageDefinition = {
  id: "context",
  title: "Context",
  mount: async (ctx: PageContext) => {
    const { container, doc } = ctx;

    // 已选会话横幅（Insights 卡片跳转；无参数时不渲染）
    if (typeof ctx.params.sessionId === "string") {
      container.append(renderSelectedSessionBanner(doc, ctx.params));
    }

    // 概览区（get_overview）
    const overview = await ctx.callTool("get_overview");
    if (!overview.ok) {
      container.append(renderToolError(doc, "get_overview", overview.error));
    } else {
      container.append(renderOverviewSection(doc, overview.payload as unknown as OverviewPayload, ctx.hostName));
    }

    // 当前会话精确用量区（get_current_session_usage）：独立降级，不影响概览
    const usageResult = await ctx.callTool("get_current_session_usage");
    const usage = usageResult.ok ? (usageResult.payload as unknown as UsagePayload) : null;
    container.append(renderUsageSection(doc, usage, usageResult.ok ? null : usageResult.error));
  },
};

/** 已选会话横幅：卡片跳转携带的概要（后续工单以 ctx.params.sessionId 深入取数） */
function renderSelectedSessionBanner(doc: Document, params: Record<string, unknown>): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", "已选会话");
  title.append(el(doc, "span", "zci-badge zci-badge-route", "来自 Insights"));
  const kv = (label: string, value: string) => {
    const row = el(doc, "div", "zci-kv");
    row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value));
    return row;
  };
  section.append(title);
  section.append(
    kv("标题", typeof params.sessionTitle === "string" ? params.sessionTitle : "-"),
    kv("会话 ID", String(params.sessionId)),
  );
  if (typeof params.sessionTokens === "number") {
    section.append(kv("合计 token", fmtInt(params.sessionTokens)));
  }
  if (typeof params.sessionRequests === "number") {
    section.append(kv("请求数", fmtInt(params.sessionRequests)));
  }
  if (typeof params.sessionTimeUpdated === "number") {
    section.append(kv("最近更新", fmtDateTime(params.sessionTimeUpdated)));
  }
  section.append(
    el(doc, "p", "zci-status", "会话级明细区块（组成/趋势/事件流）由后续工单在此装载。"),
  );
  return section;
}

function renderOverviewSection(
  doc: Document,
  payload: OverviewPayload,
  hostName: string | undefined,
): HTMLElement {
  void hostName; // 页头已标注"已连接 host"；概览区不再重复
  const section = el(doc, "section", "zci-section");
  const kv = (label: string, value: string | undefined) => {
    const row = el(doc, "div", "zci-kv");
    row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value ?? "-"));
    return row;
  };
  section.append(
    kv("插件", payload.plugin),
    kv("MCP server", payload.server),
    kv("版本", payload.version),
    el(doc, "p", "zci-greeting", payload.greeting ?? ""),
  );
  return section;
}

/** 当前会话精确用量区：数字 + 识别来源标注（心跳精确 / 推断）；不可用时降级提示 */
function renderUsageSection(
  doc: Document,
  usage: UsagePayload | null,
  bridgeError: string | null,
): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", "当前会话精确用量");

  if (bridgeError !== null || !usage?.available || !usage.usage || !usage.session) {
    title.append(el(doc, "span", "zci-badge zci-badge-inferred", "不可用"));
    section.append(title);
    const reason = bridgeError ?? usage?.reason ?? "未检测到宿主数据库或心跳";
    section.append(el(doc, "p", "zci-status", `用量暂不可用（${reason}）`));
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
  section.append(title);

  const kv = (label: string, value: string) => {
    const row = el(doc, "div", "zci-kv");
    row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value));
    return row;
  };
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

function renderToolError(doc: Document, toolName: string, message: string): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "p", "zci-error", `工具调用失败（${toolName}）: ${message}`));
  return section;
}
