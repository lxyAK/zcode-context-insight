/**
 * 逐请求趋势视图（T4）：uPlot 趋势曲线 + 压缩事件标记。
 *
 * 打包口径（研究笔记 02 §5 方案 A）：uPlot 经 esbuild 全量内联进 panel.html 单文件，
 * 运行时零外链、零网络请求。canvas 2D 不可用（无头测试/极端降级）时回退 DOM 文本趋势，
 * 压缩标记列表与悬停 tooltip 在两条路径下都渲染（DOM 实现，可测）。
 *
 * 口径（GLOSSARY + 研究笔记 03）：input 已含缓存读；压缩标记展示
 * preCompactTokenCount → truePostCompactTokenCount（真实压缩后上下文），
 * postCompactTokenCount（含总结消息）仅在悬停明细中区分展示。
 */
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { el } from "./dom.ts";

/** 逐请求时间线行（get_session_timeline 返回形状） */
export interface TimelineRequest {
  index: number;
  startedAt: number;
  querySource: string;
  modelId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  computedTotalTokens: number;
  contextExceeded: boolean;
}

/** 压缩事件标记（get_session_timeline 返回形状） */
export interface TimelineCompaction {
  time: number;
  auto: boolean | null;
  trigger: string | null;
  phase: string | null;
  compactReason: string | null;
  preCompactTokenCount: number | null;
  postCompactTokenCount: number | null;
  truePostCompactTokenCount: number | null;
  summarizedMessageCount: number | null;
  keptMessageCount: number | null;
  requestIndex: number | null;
}

/** get_session_timeline 的 structuredContent 形状 */
export interface TimelinePayload {
  available: boolean;
  reason?: string;
  session?: {
    id: string;
    source: "heartbeat" | "inferred" | "explicit";
    title: string | null;
  } | null;
  requests?: TimelineRequest[] | null;
  compactions?: TimelineCompaction[] | null;
}

/** 图表墨色为固定色板（深浅底均可见）；周边 DOM 文本/背景一律用宿主 --color-* 变量 */
const COLOR_INPUT = "#4f8ef7"; // 输入（含缓存读）
const COLOR_CACHE_READ = "#9b7ef2"; // 缓存读
const COLOR_CACHE_WRITE = "#f2a94b"; // 缓存写
const COLOR_OUTPUT = "#3ecf8e"; // 输出
const COLOR_MARKER = "#e05252"; // 压缩标记

/** token 数值格式化（轴刻度与 tooltip 通用）：千位缩写，避免宽轴溢出 */
function fmtTokens(v: number): string {
  return v >= 10000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
}

/** Unix 毫秒 → 本地 HH:mm:ss（确定性展示；断言不依赖时区） */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 渲染时间线区块（panel.ts 只做最小挂载：取数后调用本函数并 append）。
 * payload 为 null（桥失败/工具报错）与 available=false 同走降级提示。
 */
export function renderTimelineSection(doc: Document, payload: TimelinePayload | null): HTMLElement {
  const section = el(doc, "section", "zci-section zci-timeline");
  const title = el(doc, "h2", "zci-subtitle", "逐请求趋势");
  section.append(title);

  if (!payload?.available || !payload.session || !payload.requests) {
    section.append(el(doc, "p", "zci-status", "时间线暂不可用（未检测到宿主数据库或心跳）"));
    return section;
  }

  const requests = payload.requests;
  const compactions = payload.compactions ?? [];

  if (requests.length === 0) {
    section.append(el(doc, "p", "zci-status", "该会话暂无模型请求记录"));
    section.append(...renderMarkers(doc, []));
    return section;
  }

  section.append(el(doc, "p", "zci-status", "input 已含缓存读；悬停查看逐点数值。"));

  const tip = el(doc, "div", "zci-tl-tip");
  tip.hidden = true;
  const chartBox = el(doc, "div", "zci-tl-chart");
  section.append(chartBox, tip);

  // 图表初始化失败（如无 canvas 的降级环境）→ 文本趋势，保证不白屏
  const chartReady = tryRenderChart(doc, chartBox, tip, requests, compactions);
  if (!chartReady) {
    renderTextTrend(doc, chartBox, requests);
  }

  section.append(...renderMarkers(doc, compactions, tip));
  return section;
}

/** x 轴点位（秒）与每个点位的请求/压缩归属 */
interface TimelinePoints {
  xs: number[];
  requestAt: Array<TimelineRequest | null>;
  compactionAt: Array<TimelineCompaction | null>;
}

/** 构造 uPlot 对齐数据：x = 请求时间 ∪ 压缩时间（升序去重，秒） */
function buildPoints(requests: TimelineRequest[], compactions: TimelineCompaction[]): TimelinePoints {
  const marks = new Map<number, TimelineCompaction>();
  for (const c of compactions) {
    const sec = Math.round(c.time / 1000);
    // 同秒多事件时保留最后一个（压缩事件在同秒内连续发生属边缘情况）
    marks.set(sec, c);
  }
  const xs = new Set<number>();
  for (const r of requests) xs.add(Math.round(r.startedAt / 1000));
  for (const s of marks.keys()) xs.add(s);
  const sorted = [...xs].sort((a, b) => a - b);
  // 单点序列补一个占位点（uPlot 退化区间保护），系列值置 null 不影响曲线
  if (sorted.length === 1) sorted.push(sorted[0] + 60);
  const reqMap = new Map<number, TimelineRequest>();
  for (const r of requests) reqMap.set(Math.round(r.startedAt / 1000), r);
  return {
    xs: sorted,
    requestAt: sorted.map((s) => reqMap.get(s) ?? null),
    compactionAt: sorted.map((s) => marks.get(s) ?? null),
  };
}

/** 环境预检：canvas 2D 上下文可用才尝试 uPlot（无头 DOM 的 getContext 返回 null） */
function canvas2dAvailable(doc: Document): boolean {
  try {
    return doc.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

/** 尝试用 uPlot 渲染趋势图（canvas 不可用等失败场景返回 false，由调用方回退） */
function tryRenderChart(
  doc: Document,
  chartBox: HTMLElement,
  tip: HTMLElement,
  requests: TimelineRequest[],
  compactions: TimelineCompaction[],
): boolean {
  if (!canvas2dAvailable(doc)) return false;
  try {
    const pts = buildPoints(requests, compactions);
    const pick = (at: Array<TimelineRequest | null>, key: keyof TimelineRequest): Array<number | null> =>
      at.map((r) => (r === null ? null : Number(r[key])));
    const data: Array<Array<number | null>> = [
      pts.xs,
      pick(pts.requestAt, "inputTokens"),
      pick(pts.requestAt, "cacheReadTokens"),
      pick(pts.requestAt, "cacheWriteTokens"),
      pick(pts.requestAt, "outputTokens"),
      pts.compactionAt.map((c) => (c === null ? null : (c.preCompactTokenCount ?? null))),
    ];

    const width = Math.max(Math.round(chartBox.clientWidth) || 600, 320);    const opts: uPlot.Options = {
      width,
      height: 240,
      // x 用秒数值 + 本地时间格式化（避免 uPlot 内置 UTC 时间轴与本地面板时区不一致）
      scales: { x: { time: false }, y: { auto: true } },
      axes: [
        { values: (_u, vals) => (vals as number[]).map((v) => fmtTime(v * 1000)) },
        { size: 54, values: (_u, vals) => (vals as number[]).map((v) => fmtTokens(v)) },
      ],
      series: [
        {},
        { label: "输入(含缓存读)", stroke: COLOR_INPUT, width: 1.5 },
        { label: "缓存读", stroke: COLOR_CACHE_READ, width: 1.5, dash: [4, 3] },
        { label: "缓存写", stroke: COLOR_CACHE_WRITE, width: 1.5, dash: [4, 3] },
        { label: "输出", stroke: COLOR_OUTPUT, width: 1.5 },
        {
          label: "压缩标记",
          stroke: COLOR_MARKER,
          // 散点系列：不连线，仅常显点（点高 = 压缩前 token，与用量同刻度）
          paths: () => null,
          points: { show: true, size: 9, width: 2, stroke: COLOR_MARKER, fill: "rgba(224,82,82,0.25)" },
          value: (_u, v) => (v == null ? "--" : fmtTokens(Number(v))),
        },
      ],
      cursor: { drag: { x: false, y: false } },
      hooks: {
        setCursor: [
          (u: uPlot) => {
            const idx = u.cursor.idx;
            if (idx == null || idx < 0 || idx >= pts.xs.length) {
              tip.hidden = true;
              return;
            }
            fillTip(tip, pts.requestAt[idx], pts.compactionAt[idx]);
            // cursor.left/top 为鼠标相对绘图区坐标（初始可能 undefined，容错到 0）
            positionTip(tip, (u.cursor.left ?? 0) + 14, (u.cursor.top ?? 0) + 14);
          },
        ],
      },
    };
    new uPlot(opts, data as unknown as uPlot.AlignedData, chartBox);
    return true;
  } catch {
    // 无 canvas（getContext 返回 null）等初始化失败：交由调用方渲染文本回退
    return false;
  }
}

/** 文本趋势回退（无 canvas 环境）：逐请求一行，保证数据可见不白屏 */
function renderTextTrend(doc: Document, chartBox: HTMLElement, requests: TimelineRequest[]): void {
  chartBox.replaceChildren(); // 清掉 uPlot 构造中途可能留下的残缺 DOM
  chartBox.classList.add("zci-tl-chart-fallback");
  chartBox.append(el(doc, "p", "zci-status", "图表引擎不可用（无 canvas），显示文本趋势"));
  for (const r of requests) {
    const row = el(
      doc,
      "div",
      "zci-tl-row",
      `#${r.index} ${fmtTime(r.startedAt)} ${r.querySource}` +
        ` · 输入 ${r.inputTokens}（缓存读 ${r.cacheReadTokens}/写 ${r.cacheWriteTokens}）` +
        ` · 输出 ${r.outputTokens} · 总量 ${r.computedTotalTokens}` +
        ` · ${r.modelId}${r.contextExceeded ? " · 超上下文" : ""}`,
    );
    chartBox.append(row);
  }
}

/** 压缩标记列表（DOM，两条路径都渲染）；传入 tip 时启用悬停明细 */
function renderMarkers(
  doc: Document,
  compactions: TimelineCompaction[],
  tip?: HTMLElement,
): HTMLElement[] {
  if (compactions.length === 0) return [];
  const nodes: HTMLElement[] = [el(doc, "h3", "zci-tl-markers-title", "压缩事件")];
  const list = el(doc, "ul", "zci-tl-markers");
  for (const c of compactions) {
    const triggerLabel = c.auto === null ? "" : c.auto ? "自动" : "手动";
    const item = el(
      doc,
      "li",
      "zci-tl-marker",
      `压缩${triggerLabel ? `（${triggerLabel}）` : ""} · ` +
        `压缩前 ${c.preCompactTokenCount ?? "?"} → 压缩后 ${c.truePostCompactTokenCount ?? "?"} token` +
        (c.requestIndex !== null ? ` · 请求 #${c.requestIndex} 后` : ""),
    );
    item.tabIndex = 0; // 可聚焦（键盘可达）
    if (tip) {
      item.addEventListener("mouseenter", () => {
        fillTip(tip, null, c);
        positionTip(tip, item.offsetLeft, item.offsetTop + item.offsetHeight + 4);
      });
      item.addEventListener("mouseleave", () => {
        tip.hidden = true;
      });
      item.addEventListener("focus", () => {
        fillTip(tip, null, c);
        positionTip(tip, item.offsetLeft, item.offsetTop + item.offsetHeight + 4);
      });
      item.addEventListener("blur", () => {
        tip.hidden = true;
      });
    }
    list.append(item);
  }
  nodes.push(list);
  return nodes;
}

/** 填充 tooltip 内容：请求行 + 压缩明细（两口径 post 并列可区分） */
function fillTip(tip: HTMLElement, request: TimelineRequest | null, compaction: TimelineCompaction | null): void {
  const doc = tip.ownerDocument;
  tip.replaceChildren();

  if (request) {
    tip.append(
      el(doc, "div", "zci-tl-tip-title", `请求 #${request.index} · ${fmtTime(request.startedAt)}`),
      el(doc, "div", "zci-tl-tip-row", `${request.querySource} · ${request.modelId} · ${request.status}`),
      el(
        doc,
        "div",
        "zci-tl-tip-row",
        `输入 ${request.inputTokens}（缓存读 ${request.cacheReadTokens} / 写 ${request.cacheWriteTokens}）`,
      ),
      el(doc, "div", "zci-tl-tip-row", `输出 ${request.outputTokens} · 推理 ${request.reasoningTokens} · 总量 ${request.computedTotalTokens}`),
    );
  }
  if (compaction) {
    tip.append(el(doc, "div", "zci-tl-tip-title", "压缩事件"));
    tip.append(
      el(
        doc,
        "div",
        "zci-tl-tip-row",
        `压缩前 ${compaction.preCompactTokenCount ?? "?"} → 真实压缩后 ${compaction.truePostCompactTokenCount ?? "?"} token`,
      ),
      el(
        doc,
        "div",
        "zci-tl-tip-row",
        `含总结消息口径 ${compaction.postCompactTokenCount ?? "?"}（≠ 真实压缩后）`,
      ),
      el(
        doc,
        "div",
        "zci-tl-tip-row",
        `总结 ${compaction.summarizedMessageCount ?? "?"} 条 / 保留 ${compaction.keptMessageCount ?? "?"} 条`,
      ),
    );
    const trigger = compaction.auto === null ? "?" : compaction.auto ? "自动" : "手动";
    tip.append(
      el(
        doc,
        "div",
        "zci-tl-tip-row",
        `触发: ${trigger}${compaction.compactReason ? ` · ${compaction.compactReason}` : ""}`,
      ),
    );
  }
  tip.hidden = false;
}

/** tooltip 定位（相对时间线区块，section 为定位上下文） */
function positionTip(tip: HTMLElement, left: number, top: number): void {
  tip.style.left = `${Math.max(left, 4)}px`;
  tip.style.top = `${Math.max(top, 4)}px`;
  tip.hidden = false;
}
