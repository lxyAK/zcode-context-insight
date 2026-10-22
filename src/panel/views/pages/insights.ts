/**
 * Insights 页（T8）：KPI 带 + 日 token 趋势（窗口按趋势粒度设置取 7/14/30 天）+ 可筛选会话卡片。
 * 数据源 get_insights（全局 KPI/趋势 + 按参数筛选的会话列表）。
 *
 * 趋势为手写柱状图（spec 面板决策：vanilla TS + 手写 SVG/DOM 图表；
 * T4 的 uPlot 底座（逐请求趋势）合入后如需统一再整合）。
 */
import type { PageContext, PageDefinition, ToolCallResult } from "../registry.ts";
import { el, fmtInt, fmtDateTime, shortDir } from "../dom.ts";
import { t } from "../../i18n.ts";
import { renderActivitySection, type ActivityPayload } from "../activity.ts";

/** get_insights 载荷（工具 structuredContent 形状的类型化子集） */
interface InsightsPayload {
  available: boolean;
  reason?: string;
  anchorTime: number;
  kpi: { totalTokens: number; totalSessions: number; activeDays: number };
  trend: Array<{ date: string; tokens: number; requests: number; sessions: number }>;
  projects: Array<{ id: string; directory: string; sessions: number }>;
  sessions: {
    filters: { sort: string; limit: number };
    total: number;
    items: SessionCardItem[];
  };
}

interface SessionCardItem {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  taskType: string;
  timeUpdated: number;
  requests: number;
  totalTokens: number;
}

const DAY_MS = 86400000;

/**
 * 趋势粒度设置 → 趋势窗口天数（US22 消费方接线）：
 * 逐请求=7 天（默认）/ 按轮=14 天 / 按天=30 天；未知值回退 7（server 设置层已挡非法枚举，
 * 此处兜底防止载荷漂移）。
 */
const TREND_DAYS_BY_GRANULARITY: Record<string, number> = {
  request: 7,
  turn: 14,
  day: 30,
};

/** 筛选 UI 状态（页面实例内闭包保存，跨重取数保留） */
interface FilterState {
  project: string; // "" = 全部
  time: string; // "" 全部 | "7" | "30"（锚点起最近 N 天）
  size: string; // "" 全部 | "1000" | "10000" | "100000"
  sort: string; // "recent" | "tokens"
}

export const insightsPage: PageDefinition = {
  id: "insights",
  title: t("navInsights"),
  mount: async (ctx: PageContext) => {
    const filter: FilterState = { project: "", time: "", size: "", sort: "recent" };
    let anchorTime = 0; // 最近一次载荷的锚点（时间筛选以此为基准，确定性）
    // 趋势窗口按设置取（US22）：trendGranularity → 7/14/30 天，随每次取数传给工具
    const trendDays = TREND_DAYS_BY_GRANULARITY[ctx.settings?.trendGranularity ?? "request"] ?? 7;

    /** 由筛选状态生成工具入参 */
    const args = (): Record<string, unknown> => {
      const out: Record<string, unknown> = { trendDays };
      if (filter.project) out.project = filter.project;
      if (filter.size) out.minTokens = Number(filter.size);
      if (filter.time && anchorTime > 0) {
        // 锚点所在 UTC 日起往前第 N 天的日首（含锚点日共 N 天）
        out.since = Math.floor(anchorTime / DAY_MS) * DAY_MS - (Number(filter.time) - 1) * DAY_MS;
      }
      if (filter.sort) out.sort = filter.sort;
      return out;
    };

    const reload = async () => {
      const { container, doc } = ctx;
      container.replaceChildren(el(doc, "p", "zci-status", t("loading")));
      const result: ToolCallResult = await ctx.callTool("get_insights", args());
      container.replaceChildren();
      if (!result.ok) {
        container.append(renderToolError(doc, "get_insights", result.error));
        return;
      }
      const payload = result.payload as unknown as InsightsPayload;
      if (!payload.available) {
        container.append(renderUnavailable(doc, payload.reason ?? "未知原因"));
        return;
      }
      anchorTime = payload.anchorTime;
      // 活跃热力图与模型环形图（T9）：与首屏渲染并行取数、独立降级（渲染函数接受 null）
      const activityResult = await ctx.callTool("get_activity_insights", {});
      container.append(
        renderKpiBand(doc, payload.kpi),
        renderTrend(doc, payload.trend),
        renderActivitySection(
          doc,
          activityResult.ok ? (activityResult.payload as unknown as ActivityPayload) : null,
        ),
        renderSessionCards(doc, payload, filter, reload, ctx),
      );
    };

    await reload();
  },
};

/** KPI 带：总 token / 会话数 / 活跃天数（全局口径，不受列表筛选影响） */
function renderKpiBand(
  doc: Document,
  kpi: { totalTokens: number; totalSessions: number; activeDays: number },
): HTMLElement {
  const band = el(doc, "section", "zci-kpi-band");
  const card = (label: string, value: number) => {
    const c = el(doc, "div", "zci-kpi-card");
    c.append(el(doc, "div", "zci-kpi-value", fmtInt(value)), el(doc, "div", "zci-kpi-label", label));
    return c;
  };
  band.append(
    card(t("insightsKpiTotalTokens"), kpi.totalTokens),
    card(t("insightsKpiSessions"), kpi.totalSessions),
    card(t("insightsKpiActiveDays"), kpi.activeDays),
  );
  return band;
}

/** 日趋势：手写柱状图（每日一柱，值标签 + 日期标签，零日画基线）；标题显示实际窗口（载荷桶数） */
function renderTrend(
  doc: Document,
  days: Array<{ date: string; tokens: number; requests: number; sessions: number }>,
): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "h2", "zci-subtitle", t("insightsTrendTitle", { days: days.length })));
  const chart = el(doc, "div", "zci-trend");
  const max = Math.max(...days.map((d) => d.tokens), 1);
  for (const day of days) {
    const bar = el(doc, "div", "zci-trend-bar");
    bar.setAttribute("data-date", day.date);
    bar.setAttribute(
      "title",
      t("insightsTrendTooltip", {
        date: day.date,
        tokens: fmtInt(day.tokens),
        requests: day.requests,
        sessions: day.sessions,
      }),
    );
    const fill = el(doc, "div", "zci-trend-fill");
    // 峰值柱满高，零日保留 2px 基线
    fill.style.height = `${Math.max(Math.round((day.tokens / max) * 56), day.tokens > 0 ? 4 : 2)}px`;
    bar.append(
      fill,
      el(doc, "div", "zci-trend-value", day.tokens > 0 ? fmtInt(day.tokens) : ""),
      el(doc, "div", "zci-trend-date", day.date.slice(5)),
    );
    chart.append(bar);
  }
  section.append(chart);
  return section;
}

/** 会话卡片区：筛选行（项目/时间/规模/排序）+ 卡片列表；点卡片跳转 Context 仪表盘 */
function renderSessionCards(
  doc: Document,
  payload: InsightsPayload,
  filter: FilterState,
  reload: () => Promise<void>,
  ctx: PageContext,
): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", t("insightsSessionsTitle"));
  title.append(el(doc, "span", "zci-count", t("insightsSessionCount", { count: fmtInt(payload.sessions.total) })));
  section.append(title);

  // 筛选行（option 的 value 一律显式 setAttribute：未设时 DOM 回退取文本，不可靠）
  const row = el(doc, "div", "zci-filters");
  const option = (value: string, label: string) => {
    const opt = el(doc, "option", "", label);
    opt.setAttribute("value", value);
    return opt;
  };
  const projectSelect = el(doc, "select", "zci-filter zci-filter-project") as HTMLSelectElement;
  projectSelect.append(option("", t("insightsFilterAllProjects")));
  for (const p of payload.projects) {
    projectSelect.append(option(p.id, `${shortDir(p.directory)} (${p.sessions})`));
  }
  projectSelect.value = filter.project;

  const timeSelect = el(doc, "select", "zci-filter zci-filter-time") as HTMLSelectElement;
  for (const [value, label] of [
    ["", t("insightsFilterAllTime")],
    ["7", t("insightsFilterLast7")],
    ["30", t("insightsFilterLast30")],
  ] as const) {
    timeSelect.append(option(value, label));
  }
  timeSelect.value = filter.time;

  const sizeSelect = el(doc, "select", "zci-filter zci-filter-size") as HTMLSelectElement;
  for (const [value, label] of [
    ["", t("insightsFilterAllSizes")],
    ["1000", t("insightsFilterSize1k")],
    ["10000", t("insightsFilterSize10k")],
    ["100000", t("insightsFilterSize100k")],
  ] as const) {
    sizeSelect.append(option(value, label));
  }
  sizeSelect.value = filter.size;

  const sortSelect = el(doc, "select", "zci-filter zci-filter-sort") as HTMLSelectElement;
  for (const [value, label] of [
    ["recent", t("insightsFilterSortRecent")],
    ["tokens", t("insightsFilterSortTokens")],
  ] as const) {
    sortSelect.append(option(value, label));
  }
  sortSelect.value = filter.sort;

  for (const select of [projectSelect, timeSelect, sizeSelect, sortSelect]) {
    select.addEventListener("change", () => {
      filter.project = projectSelect.value;
      filter.time = timeSelect.value;
      filter.size = sizeSelect.value;
      filter.sort = sortSelect.value;
      void reload();
    });
  }
  row.append(projectSelect, timeSelect, sizeSelect, sortSelect);
  section.append(row);

  // 卡片列表
  const list = el(doc, "div", "zci-session-list");
  if (payload.sessions.items.length === 0) {
    list.append(el(doc, "p", "zci-status", t("insightsNoSessions")));
  }
  for (const item of payload.sessions.items) {
    list.append(renderSessionCard(doc, item, ctx));
  }
  section.append(list);
  return section;
}

/** 单张会话卡片（按钮语义：点击进入该会话的 Context 仪表盘——sessionId 路由缝） */
function renderSessionCard(doc: Document, item: SessionCardItem, ctx: PageContext): HTMLElement {
  const card = el(doc, "button", "zci-session-card");
  card.setAttribute("data-session-id", item.id);

  const head = el(doc, "div", "zci-session-head");
  head.append(el(doc, "span", "zci-session-title", item.title));
  if (item.taskType !== "interactive") {
    head.append(el(doc, "span", "zci-badge zci-badge-sub", t("insightsSubagentBadge")));
  }
  card.append(head);
  card.append(
    el(
      doc,
      "div",
      "zci-session-meta",
      t("insightsSessionMeta", {
        dir: shortDir(item.directory),
        time: fmtDateTime(item.timeUpdated),
        requests: fmtInt(item.requests),
      }),
    ),
    el(doc, "div", "zci-session-tokens", t("insightsSessionTokens", { value: fmtInt(item.totalTokens) })),
  );

  card.addEventListener("click", () => {
    // 跨页传参缝：会话概要随路由传递，Context 页区块（后续工单）读 ctx.params.sessionId 深入取数
    ctx.navigate("context", {
      sessionId: item.id,
      sessionTitle: item.title,
      sessionProject: item.projectId,
      sessionDirectory: item.directory,
      sessionTokens: item.totalTokens,
      sessionRequests: item.requests,
      sessionTimeUpdated: item.timeUpdated,
    });
  });
  return card;
}

function renderUnavailable(doc: Document, reason: string): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(
    el(doc, "h2", "zci-subtitle", t("insightsUnavailableTitle")),
    el(doc, "p", "zci-status", t("insightsUnavailableReason", { reason })),
  );
  return section;
}

function renderToolError(doc: Document, toolName: string, message: string): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "p", "zci-error", t("toolCallFailedTool", { tool: toolName, message })));
  return section;
}
