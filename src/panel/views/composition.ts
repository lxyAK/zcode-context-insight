/**
 * 上下文组成条视图（T3，ADR-0002 口径）：
 *  - 手写 SVG 堆叠条渲染四分组（system 提示 / 工具定义 / 历史消息 / 当前轮，GLOSSARY 固定命名）；
 *  - 分组数值为"组成估算"，标题带"估算"角标，不冒充精确值；
 *  - 顶部总量始终为 API 精确值（锚点 usage.inputTokens），与估算并存；
 *  - 纯 delta 会话（无 full 快照）：只显示精确总量，组成条为说明性空态；
 *  - 颜色一律引用宿主 --color-* CSS 变量（深浅色自动适配）。
 */

/** get_current_session_composition 的 structuredContent 形状（面板侧只声明消费字段） */
export interface CompositionPayload {
  available: boolean;
  reason?: string;
  session?: { id: string; source: string } | null;
  exactTotalTokens?: number | null;
  anchor?: {
    requestId: string | null;
    index: number;
    kind: string;
    inputTokens: number;
    messageCount: number | null;
    messageOffset: number | null;
  } | null;
  composition?: {
    estimated: boolean;
    raw: Record<string, number>;
    calibrated: Record<string, number>;
    scaleFactor: number;
  } | null;
  compositionReason?: string;
}

/** 四分组展示配置（GLOSSARY 第 15 条固定命名；宿主题色变量区分分组） */
const GROUPS: Array<{ key: string; label: string; color: string }> = [
  { key: "system", label: "system 提示", color: "var(--color-info, #3498db)" },
  { key: "tools", label: "工具定义", color: "var(--color-success, #27ae60)" },
  { key: "history", label: "历史消息", color: "var(--color-warning, #e67e22)" },
  { key: "currentTurn", label: "当前轮", color: "var(--color-danger, #c0392b)" },
];

/** SVG 命名空间（手写 SVG，不引第三方库） */
const SVG_NS = "http://www.w3.org/2000/svg";

/** 条带总宽（viewBox 单位）：段宽 = 分组占比 × 100，段间起点累计衔接 */
const BAR_WIDTH = 100;
const BAR_HEIGHT = 12;

function svgEl(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function htmlEl(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 降级原因 → 面向用户的说明（ADR-0001：rollout 清理属预期，明示而非报错） */
function degradeMessage(reason: string | undefined): string {
  if (reason === "rollout-not-found") return "组成不可用：rollout 文件缺失或已被宿主清理（对较早的会话属预期）";
  if (reason === "rollout-empty" || reason === "rollout-read-failed") return "组成不可用：rollout 文件无法解析";
  if (reason === "no-session") return "组成不可用：无法识别当前会话（无心跳且数据库不可读）";
  return `组成不可用：${reason ?? "未知原因"}`;
}

/**
 * 渲染"上下文组成"区块。
 * panel.ts 只做最小挂载：本函数独立负责全部 DOM 构造与空态/降级分支。
 */
export function renderCompositionSection(doc: Document, payload: CompositionPayload | null): HTMLElement {
  const section = htmlEl(doc, "section", "zci-section");
  const title = htmlEl(doc, "h2", "zci-subtitle", "上下文组成");
  section.append(title);

  // 工具调用失败（桥错误）/ 空载荷
  if (!payload) {
    section.append(htmlEl(doc, "p", "zci-status", "组成暂不可用（工具调用失败）"));
    return section;
  }
  if (!payload.available) {
    section.append(htmlEl(doc, "p", "zci-status", degradeMessage(payload.reason)));
    return section;
  }

  const total = payload.exactTotalTokens ?? 0;
  const kvRow = htmlEl(doc, "div", "zci-kv");
  kvRow.append(
    htmlEl(doc, "span", "zci-kv-label", "精确总量（API）"),
    htmlEl(doc, "span", "zci-kv-value", `${total} tokens`),
  );

  const composition = payload.composition;
  if (!composition) {
    // 纯 delta 会话：只显示精确总量，组成条为说明性空态（ADR-0002）
    title.append(htmlEl(doc, "span", "zci-badge zci-badge-inferred", "精确总量"));
    const bar = svgEl(doc, "svg", {
      class: "zci-comp-bar zci-comp-empty",
      viewBox: `0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "组成估算不可用（无 full 请求快照）",
    });
    bar.append(svgEl(doc, "rect", {
      class: "zci-comp-empty-rect",
      x: "0",
      y: "0",
      width: String(BAR_WIDTH),
      height: String(BAR_HEIGHT),
    }));
    section.append(kvRow, bar, htmlEl(doc, "p", "zci-comp-note",
      "无法估算组成：本会话暂无 full 请求快照（delta/tail 请求仅携带尾部增量，不能作为组成基准）。"));
    return section;
  }

  // 估算角标（ADR-0002：估算必须标注、不冒充精确）
  title.append(htmlEl(doc, "span", "zci-badge zci-badge-estimate", "估算"));

  const calibrated = composition.calibrated;
  const bar = svgEl(doc, "svg", {
    class: "zci-comp-bar",
    viewBox: `0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `上下文组成估算（总量 ${total} tokens 为 API 精确值，分组为估算）`,
  });
  let x = 0;
  for (const group of GROUPS) {
    const value = calibrated[group.key] ?? 0;
    const width = total > 0 ? (value / total) * BAR_WIDTH : 0;
    bar.append(svgEl(doc, "rect", {
      class: "zci-comp-seg",
      "data-group": group.key,
      x: x.toFixed(3),
      y: "0",
      width: width.toFixed(3),
      height: String(BAR_HEIGHT),
      fill: group.color,
    }));
    x += width;
  }
  section.append(kvRow, bar);

  // 图例：分组名 + 校准值 + 占比
  const legend = htmlEl(doc, "div", "zci-comp-legend");
  for (const group of GROUPS) {
    const value = calibrated[group.key] ?? 0;
    const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
    const row = htmlEl(doc, "div", "zci-comp-legend-row");
    const swatch = htmlEl(doc, "span", "zci-comp-swatch");
    swatch.style.background = group.color;
    row.append(
      swatch,
      htmlEl(doc, "span", "zci-comp-legend-label", group.label),
      htmlEl(doc, "span", "zci-comp-legend-value", `${value} · ${pct}%`),
    );
    legend.append(row);
  }
  section.append(legend);

  // 口径脚注：估算方式与锚点（归一化方式说明）
  const anchorNote = payload.anchor?.requestId
    ? `锚定最近 full 请求（${payload.anchor.requestId}）的 API 精确用量，按比例归一化（因子 ${composition.scaleFactor.toFixed(3)}）。`
    : "锚定最近 full 请求的 API 精确用量，按比例归一化。";
  section.append(htmlEl(doc, "p", "zci-comp-note", `分组为启发式折算的估算值。${anchorNote}`));
  return section;
}
