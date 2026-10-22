/**
 * 统计卡视图（T5）：get_session_stats 载荷 → Context / Token / Timing 三组统计卡。
 * 独立视图文件：不发请求、不碰桥，只做纯渲染；请求由 panel.ts 装配层发出。
 * 无数据项（样本缺失的比率/分位数、无请求时的量值）显示占位 "—" 而非 0。
 */

import { el } from "./dom.ts";
/** 会话统计载荷（get_session_stats 的 structuredContent 形状） */
export interface SessionStatsPayload {
  available: boolean;
  reason?: string;
  session?: {
    id: string;
    source: "heartbeat" | "inferred";
    title: string | null;
  } | null;
  stats?: {
    requests: number;
    cacheHitRate: number | null;
    contextExceededCount: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    computedTotalTokens: number;
    ttftCount: number;
    ttftP50Ms: number | null;
    ttftP95Ms: number | null;
    retryCount: number;
  } | null;
}

/** 占位符：样本缺失/无数据时显示，与真 0 区分（工单口径） */
const PLACEHOLDER = "—";

/** 比率 → 百分比（一位小数）；null 显示占位 */
function fmtPercent(rate: number | null): string {
  return rate === null ? PLACEHOLDER : `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;
}

/** 毫秒值带单位；null 显示占位 */
function fmtMs(value: number | null): string {
  return value === null ? PLACEHOLDER : `${value} ms`;
}

/** 量值（token 数等）；无请求数据时显示占位而非 0 */
function fmtAmount(value: number, hasData: boolean): string {
  return hasData ? String(value) : PLACEHOLDER;
}

/** 单张统计卡：label 在上、value 在下 */
function statCard(doc: Document, label: string, value: string): HTMLElement {
  const card = el(doc, "div", "zci-stat");
  card.append(el(doc, "span", "zci-stat-label", label), el(doc, "span", "zci-stat-value", value));
  return card;
}

/** 一组卡：组标题 + 卡片网格 */
function statGroup(doc: Document, title: string, cards: HTMLElement[]): HTMLElement {
  const group = el(doc, "div", "zci-stat-group");
  group.append(el(doc, "h3", "zci-stat-group-title", title));
  const grid = el(doc, "div", "zci-stat-cards");
  grid.append(...cards);
  group.append(grid);
  return group;
}

/** 统计卡区（T5）：三组卡；载荷不可用时降级提示 */
export function renderStatsSection(doc: Document, payload: SessionStatsPayload | null): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "h2", "zci-subtitle", "会话统计"));

  if (!payload?.available || !payload.stats) {
    section.append(el(doc, "p", "zci-status", "统计暂不可用（未检测到宿主数据库或心跳）"));
    return section;
  }

  const s = payload.stats;
  const hasData = s.requests > 0; // 无请求 → 量值类显示占位（"未知"而非 0）

  const context = statGroup(doc, "Context Stats", [
    statCard(doc, "缓存命中率", fmtPercent(s.cacheHitRate)),
    statCard(doc, "上下文超限", String(s.contextExceededCount)),
  ]);
  const token = statGroup(doc, "Token Stats", [
    statCard(doc, "输入 token", fmtAmount(s.inputTokens, hasData)),
    statCard(doc, "输出 token", fmtAmount(s.outputTokens, hasData)),
    statCard(doc, "缓存读 token", fmtAmount(s.cacheReadTokens, hasData)),
    statCard(doc, "缓存写 token", fmtAmount(s.cacheWriteTokens, hasData)),
    statCard(doc, "总量 token", fmtAmount(s.computedTotalTokens, hasData)),
  ]);
  const timing = statGroup(doc, "Timing Stats", [
    statCard(doc, "TTFT p50", fmtMs(s.ttftP50Ms)),
    statCard(doc, "TTFT p95", fmtMs(s.ttftP95Ms)),
    statCard(doc, "重试", String(s.retryCount)),
    statCard(doc, "请求数", String(s.requests)),
  ]);

  const groups = el(doc, "div", "zci-stat-groups");
  groups.append(context, token, timing);
  section.append(groups);
  return section;
}
