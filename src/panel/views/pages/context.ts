/**
 * Context 仪表盘页（T8 页面骨架；T2 概览/用量迁入，T3 组成条、T5 统计卡、
 * T7 事件流/文件活动区块在本页挂载）。各区块视图模块只做渲染，取数经 ctx.callTool。
 *
 * 路由缝：ctx.params.sessionId 存在时（来自 Insights 会话卡片跳转），
 * 顶部渲染"已选会话"横幅（卡片携带的概要数据）；后续工单的会话级区块
 * 直接读 ctx.params.sessionId 深入取数。
 */
import type { PageContext, PageDefinition } from "../registry.ts";
import { el, fmtInt, fmtDateTime } from "../dom.ts";
import { t } from "../../i18n.ts";
import { renderCompositionSection, type CompositionPayload } from "../composition.ts";
import { renderStatsSection, type SessionStatsPayload } from "../stats.ts";
import {
  renderEventsSection,
  renderFileActivitySection,
  type EventsPayload,
  type FileActivityPayload,
} from "../events.ts";

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
  title: t("navContext"),
  mount: async (ctx: PageContext) => {
    const { container, doc } = ctx;

    // 已选会话横幅（Insights 卡片跳转；无参数时不渲染）
    if (typeof ctx.params.sessionId === "string") {
      container.append(renderSelectedSessionBanner(doc, ctx.params));
    }

    // 概览区（get_overview）：失败渲染错误，不阻断后续区块
    const overview = await ctx.callTool("get_overview");
    container.append(
      overview.ok
        ? renderOverviewSection(doc, overview.payload as unknown as OverviewPayload)
        : renderToolError(doc, "get_overview", overview.error),
    );

    // 当前会话精确用量区（get_current_session_usage）：独立降级
    const usageResult = await ctx.callTool("get_current_session_usage");
    container.append(
      renderUsageSection(
        doc,
        usageResult.ok ? (usageResult.payload as unknown as UsagePayload) : null,
        usageResult.ok ? null : usageResult.error,
      ),
    );

    // 上下文组成条（T3）：独立降级（渲染函数接受 null）
    const compositionResult = await ctx.callTool("get_current_session_composition");
    container.append(
      renderCompositionSection(
        doc,
        compositionResult.ok ? (compositionResult.payload as unknown as CompositionPayload) : null,
      ),
    );

    // 统计卡（T5）：独立降级
    const statsResult = await ctx.callTool("get_session_stats");
    container.append(
      renderStatsSection(
        doc,
        statsResult.ok ? (statsResult.payload as unknown as SessionStatsPayload) : null,
      ),
    );

    // 事件流与文件活动（T7）：并行取数，各自降级为空态/暂不可用
    const [eventsResult, fileActivityResult] = await Promise.all([
      ctx.callTool("get_session_events"),
      ctx.callTool("get_session_file_activity"),
    ]);
    container.append(
      renderEventsSection(doc, eventsResult.ok ? (eventsResult.payload as unknown as EventsPayload) : null),
      renderFileActivitySection(
        doc,
        fileActivityResult.ok ? (fileActivityResult.payload as unknown as FileActivityPayload) : null,
      ),
    );
  },
};

/** 已选会话横幅：卡片跳转携带的概要（后续工单以 ctx.params.sessionId 深入取数） */
function renderSelectedSessionBanner(doc: Document, params: Record<string, unknown>): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", t("contextSelectedTitle"));
  title.append(el(doc, "span", "zci-badge zci-badge-route", t("insightsRouteFrom")));
  section.append(title);
  section.append(
    kvRow(doc, t("contextKvTitle"), typeof params.sessionTitle === "string" ? params.sessionTitle : "-"),
    kvRow(doc, t("contextKvSessionId"), String(params.sessionId)),
  );
  if (typeof params.sessionTokens === "number") {
    section.append(kvRow(doc, t("contextKvTokens"), fmtInt(params.sessionTokens)));
  }
  if (typeof params.sessionRequests === "number") {
    section.append(kvRow(doc, t("contextKvRequests"), fmtInt(params.sessionRequests)));
  }
  if (typeof params.sessionTimeUpdated === "number") {
    section.append(kvRow(doc, t("contextKvRecent"), fmtDateTime(params.sessionTimeUpdated)));
  }
  section.append(el(doc, "p", "zci-status", t("contextSelectedNote")));
  return section;
}

function kvRow(doc: Document, label: string, value: string): HTMLElement {
  const row = el(doc, "div", "zci-kv");
  row.append(el(doc, "span", "zci-kv-label", label), el(doc, "span", "zci-kv-value", value));
  return row;
}

function renderOverviewSection(doc: Document, payload: OverviewPayload): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(
    kvRow(doc, t("kvPlugin"), payload.plugin ?? "-"),
    kvRow(doc, t("kvServer"), payload.server ?? "-"),
    kvRow(doc, t("kvVersion"), payload.version ?? "-"),
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
  const title = el(doc, "h2", "zci-subtitle", t("usageTitle"));

  if (bridgeError !== null || !usage?.available || !usage.usage || !usage.session) {
    section.append(title);
    const reason = bridgeError ?? usage?.reason;
    section.append(
      el(doc, "p", "zci-status", reason ? t("usageUnavailableReason", { reason }) : t("usageUnavailable")),
    );
    return section;
  }

  // 识别来源标注（ADR-0003：heartbeat=心跳精确；inferred=最近活跃推断）
  const isHeartbeat = usage.session.source === "heartbeat";
  title.append(
    el(
      doc,
      "span",
      isHeartbeat ? "zci-badge zci-badge-exact" : "zci-badge zci-badge-inferred",
      isHeartbeat ? t("badgeHeartbeat") : t("badgeInferred"),
    ),
  );
  section.append(title);

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

function renderToolError(doc: Document, toolName: string, message: string): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(
    el(doc, "p", "zci-error", t("toolCallFailedTool", { tool: toolName, message })),
  );
  return section;
}
