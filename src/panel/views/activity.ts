/**
 * Insights 活跃区视图（T9）：活跃热力图 + 模型组成/供应商占比环形图。
 *
 * 手写 SVG（零图表库、零外链，沙箱 CSP 禁网）；颜色一律引用宿主 --color-* CSS 变量，
 * 深浅色自动适配。数据形状与工具 get_activity_insights 的 structuredContent 对应。
 *
 * 边界（工单验收）：
 *  - 空数据日期：渲染 0 级灰格（悬停"无活动"），完全无活动显示空态提示；
 *  - 单模型：一段 100% 完整圆环，图例单项 100.0%。
 */
import { t } from "../i18n.ts";
import { el } from "./dom.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** get_activity_insights 的 structuredContent 形状（面板消费的载荷类型） */
export interface ActivityDailyRow {
  date: string;
  requests: number;
  computedTotalTokens: number;
  sessions: number;
}

export interface ActivityModelRow {
  providerId: string;
  modelId: string;
  requests: number;
  computedTotalTokens: number;
}

export interface ActivityProviderRow {
  providerId: string;
  requests: number;
  computedTotalTokens: number;
}

export interface ActivityPayload {
  available?: boolean;
  reason?: string;
  rangeDays?: number;
  nowMs?: number;
  querySourcesExcluded?: string[];
  daily?: ActivityDailyRow[] | null;
  models?: ActivityModelRow[] | null;
  providers?: ActivityProviderRow[] | null;
}

/** 环形图/热力图色板（宿主 CSS 变量，末位兜底值仅供变量缺失时） */
const PALETTE = [
  "var(--color-info, #3b82f6)",
  "var(--color-success, #22c55e)",
  "var(--color-warning, #f59e0b)",
  "var(--color-danger, #ef4444)",
  "var(--color-text-secondary, #888)",
  "var(--color-border-default, #ccc)",
];

/** 热力图格子几何（含 2px 间隙） */
const CELL = 12;
const CELL_SIZE = 10;

/** 占比标签：统一一位小数（95.0% / 5.0% / 100.0%） */
function pctLabel(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(1)}%`;
}

function svgEl(
  doc: Document,
  tag: string,
  attrs: Record<string, string | number>,
): Element {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 本地日历日键（YYYY-MM-DD）。与 server 侧 activity.ts 同一算法的浏览器端副本：两端运行时隔离（node:sqlite 不可进面板 bundle），跨端小重复优于跨 bundle 依赖 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 渲染 Insights 活跃区（面板装配层的唯一公共入口） */
export function renderActivitySection(
  doc: Document,
  payload: ActivityPayload | null,
): HTMLElement {
  const section = el(doc, "section", "zci-section zci-activity");
  const range = payload?.rangeDays;
  section.append(
    el(doc, "h2", "zci-subtitle", range ? t("activityTitleRanged", { range }) : t("activityTitle")),
  );

  if (!payload?.available) {
    section.append(el(doc, "p", "zci-status", t("activityUnavailable")));
    return section;
  }

  const grid = el(doc, "div", "zci-activity-grid");
  grid.append(
    renderHeatmapCard(doc, payload),
    renderDonutCard(
      doc,
      "zci-activity-models",
      t("modelsTitle"),
      (payload.models ?? []).map((m) => ({ label: m.modelId, value: m.computedTotalTokens })),
    ),
    renderDonutCard(
      doc,
      "zci-activity-providers",
      t("providersTitle"),
      (payload.providers ?? []).map((p) => ({ label: p.providerId, value: p.computedTotalTokens })),
    ),
  );
  section.append(grid);
  return section;
}

/** 活跃热力图卡片：列=周（周一开头）、行=周几；空数据日期渲染 0 级格 */
function renderHeatmapCard(doc: Document, payload: ActivityPayload): HTMLElement {
  const card = el(doc, "div", "zci-activity-card zci-activity-heat");
  card.append(el(doc, "h3", "zci-activity-card-title", t("heatmapTitle")));

  const daily = payload.daily ?? [];
  if (daily.length === 0) {
    card.append(el(doc, "p", "zci-status", t("noActivity")));
    return card;
  }

  card.append(buildHeatmapSvg(doc, payload));
  card.append(buildHeatLegend(doc));
  return card;
}

function buildHeatmapSvg(doc: Document, payload: ActivityPayload): Element {
  const rangeDays = payload.rangeDays ?? 91;
  const nowMs = payload.nowMs ?? Date.now();
  const byDate = new Map((payload.daily ?? []).map((d) => [d.date, d]));
  const maxRequests = Math.max(...[...byDate.values()].map((d) => d.requests), 1);

  // 窗口首日 = 当日 - (rangeDays-1) 个日历日；逐日用日期算术推进（DST 安全）
  const now = new Date(nowMs);
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (rangeDays - 1));
  const lead = (first.getDay() + 6) % 7; // 周一=0 首列对齐
  const cols = Math.ceil((lead + rangeDays) / 7);

  const svg = svgEl(doc, "svg", {
    class: "zci-heatmap",
    role: "img",
    "aria-label": t("heatmapAria", { range: rangeDays }),
    viewBox: `0 0 ${cols * CELL + 2} ${7 * CELL + 2}`,
    width: cols * CELL + 2,
    height: 7 * CELL + 2,
  });

  for (let i = 0; i < rangeDays; i++) {
    const dayMs = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime();
    const date = localDayKey(dayMs);
    const cellIndex = lead + i;
    const col = Math.floor(cellIndex / 7);
    const weekday = cellIndex % 7;
    const data = byDate.get(date);
    const requests = data?.requests ?? 0;

    // 活跃度分级：峰值日四分位（>=1 即有活动；max=1 时单请求日为 4 级）
    let level = 0;
    if (requests > 0) {
      const ratio = requests / maxRequests;
      level = ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
    }

    const rect = svgEl(doc, "rect", {
      class: "zci-heat-cell",
      "data-date": date,
      "data-level": level,
      x: col * CELL + 1,
      y: weekday * CELL + 1,
      width: CELL_SIZE,
      height: CELL_SIZE,
      rx: 2,
    });
    rect.setAttribute(
      "style",
      level === 0
        ? "fill: var(--color-background-tertiary, #e5e7eb)"
        : `fill: var(--color-info, #3b82f6); opacity: ${[0, 0.3, 0.5, 0.75, 1][level]}`,
    );
    const title = svgEl(doc, "title", {});
    title.textContent = data
      ? t("heatCellActive", {
          date,
          requests: data.requests,
          tokens: data.computedTotalTokens,
          sessions: data.sessions,
        })
      : t("heatCellEmpty", { date });
    rect.append(title);
    svg.append(rect);
  }
  return svg;
}

/** 热力图图例：0-4 级色块 + 少/多 */
function buildHeatLegend(doc: Document): HTMLElement {
  const legend = el(doc, "div", "zci-heat-legend");
  legend.append(el(doc, "span", "zci-heat-legend-text", t("heatLegendLess")));
  for (let level = 0; level <= 4; level++) {
    const swatch = el(doc, "span", "zci-heat-swatch");
    swatch.setAttribute("data-level", String(level));
    swatch.setAttribute(
      "style",
      level === 0
        ? "background: var(--color-background-tertiary, #e5e7eb)"
        : `background: var(--color-info, #3b82f6); opacity: ${[0, 0.3, 0.5, 0.75, 1][level]}`,
    );
    legend.append(swatch);
  }
  legend.append(el(doc, "span", "zci-heat-legend-text", t("heatLegendMore")));
  return legend;
}

/** 环形图卡片：单段 100% 渲染完整圆环；空数据渲染空态提示 */
function renderDonutCard(
  doc: Document,
  cardClass: string,
  title: string,
  slices: Array<{ label: string; value: number }>,
): HTMLElement {
  const card = el(doc, "div", `zci-activity-card ${cardClass}`);
  card.append(el(doc, "h3", "zci-activity-card-title", title));

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (slices.length === 0 || total <= 0) {
    card.append(el(doc, "p", "zci-status", t("noActivity")));
    return card;
  }

  card.append(buildDonutSvg(doc, slices, total));

  const legend = el(doc, "ul", "zci-legend");
  for (const s of slices) {
    const pct = pctLabel(s.value, total);
    const li = el(doc, "li", "zci-legend-item");
    const dot = el(doc, "span", "zci-legend-dot");
    dot.setAttribute("style", `background: ${PALETTE[slices.indexOf(s) % PALETTE.length]}`);
    li.append(dot);
    li.append(el(doc, "span", "zci-legend-label", s.label));
    li.append(el(doc, "span", "zci-legend-value", t("donutLegendValue", { value: s.value, pct })));
    legend.append(li);
  }
  card.append(legend);
  return card;
}

function buildDonutSvg(doc: Document, slices: Array<{ label: string; value: number }>, total: number): Element {
  const R = 32;
  const C = 2 * Math.PI * R;
  const svg = svgEl(doc, "svg", {
    class: "zci-donut",
    role: "img",
    viewBox: "0 0 80 80",
    width: 96,
    height: 96,
  });
  const g = svgEl(doc, "g", { transform: "rotate(-90 40 40)" });
  svg.append(g);

  let accumulated = 0;
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    const len = (s.value / total) * C;
    const pct = pctLabel(s.value, total);
    const circle = svgEl(doc, "circle", {
      class: "zci-donut-slice",
      cx: 40,
      cy: 40,
      r: R,
      fill: "none",
      "stroke-width": 16,
      "stroke-dasharray": `${len} ${C - len}`,
      "stroke-dashoffset": -accumulated,
    });
    circle.setAttribute("style", `stroke: ${PALETTE[i % PALETTE.length]}`);
    const title = svgEl(doc, "title", {});
    title.textContent = t("donutSlice", { label: s.label, value: s.value, pct });
    circle.append(title);
    g.append(circle);
    accumulated += len;
  }
  return svg;
}
