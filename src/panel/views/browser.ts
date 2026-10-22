/**
 * Context Browser 视图（T6）：请求序列列表 + 单请求组成明细（分组 / DNA 扁平两模式）。
 *
 * 装配约定：本文件只做视图，不触碰桥协议；数据经注入的 callTool（panel.ts 装配层
 * 用 BridgeClient 包装 tools/call）。公开缝：
 *  - render()：渲染请求序列列表（默认当前会话，list_session_requests）；
 *  - open(sessionId, requestId)：按请求标识直接打开明细——T3 组成条 / T4 趋势图
 *    点选下钻的联动入口（可复用组件，不依赖列表存在）。
 *
 * 口径（ADR-0002）：估算值一律带"估算"角标，精确总量用 usage API 值；
 * 非 full 请求（delta/tail）显示"无快照"空态；rollout 不可用显示"明细不可用"空态。
 */

/** 面板取数函数（panel.ts 注入；测试可 mock） */
export type CallToolFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Context Browser 公开视图接口（render/open 为联动缝） */
export interface BrowserView {
  /** 视图根元素（装配层负责挂载；内部状态切换时替换 children） */
  element: HTMLElement;
  /** 渲染请求序列列表（默认当前会话） */
  render(): Promise<void>;
  /** 按请求标识打开组成明细（T3/T4 下钻联动缝） */
  open(sessionId: string, requestId: string): Promise<void>;
}

// —— 载荷形状（工具 structuredContent 的宽松子集，字段漂移容错） ——

interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface RequestSummaryPayload {
  index?: number;
  requestId: string;
  messagesKind?: string;
  messageOffset?: number | null;
  messageCount?: number | null;
  startedAt?: string | null;
  durationMs?: number | null;
  querySource?: string | null;
  model?: { modelId?: string | null; providerId?: string | null } | null;
  usage?: UsagePayload | null;
}

interface ListPayload {
  available?: boolean;
  reason?: string;
  session?: { id?: string } | null;
  requests?: RequestSummaryPayload[] | null;
  counts?: { total?: number; full?: number; delta?: number; tail?: number } | null;
}

interface BlockPayload {
  seq: number;
  groupKey: string;
  kind: string;
  role?: string;
  name?: string;
  estimatedTokens?: number;
  preview?: string;
  toolName?: string;
  parts?: Array<{ type: string; estimatedTokens: number; preview: string }>;
}

interface CompositionPayload {
  estimatedTotalTokens?: number;
  scale?: number | null;
  groups?: Array<{ key: string; label: string; estimatedTokens?: number; blockCount?: number }>;
  blocks?: BlockPayload[];
}

interface DetailPayload {
  available?: boolean;
  reason?: string;
  usage?: UsagePayload | null;
  snapshot?: string;
  composition?: CompositionPayload | null;
  request?: RequestSummaryPayload | null;
}

export function createBrowserView(opts: {
  doc: Document;
  callTool: CallToolFn;
  /** 默认会话（review 修复 P0-3）：Insights 跳转携带 sessionId 时请求序列按该会话取 */
  sessionId?: string;
}): BrowserView {
  const { doc, callTool, sessionId } = opts;
  const element = el("div", "zci-browser");

  let listPayload: ListPayload | null = null;
  let detailPayload: DetailPayload | null = null;
  let detailIds: { sessionId: string; requestId: string } | null = null;
  let dnaMode = false;

  async function render(): Promise<void> {
    try {
      listPayload = (await callTool("list_session_requests", sessionId ? { sessionId } : {})) as ListPayload;
    } catch {
      listPayload = { available: false, reason: "tool-call-failed" };
    }
    detailPayload = null;
    detailIds = null;
    dnaMode = false;
    renderList();
  }

  async function open(sessionId: string, requestId: string): Promise<void> {
    try {
      detailPayload = (await callTool("get_request_detail", { sessionId, requestId })) as DetailPayload;
    } catch {
      detailPayload = { available: false, reason: "tool-call-failed" };
    }
    detailIds = { sessionId, requestId };
    dnaMode = false;
    renderDetail();
  }

  // ------------------------------------------------------------------
  // 请求序列列表
  // ------------------------------------------------------------------

  function renderList(): void {
    element.replaceChildren();
    const payload = listPayload;
    if (!payload?.available || !payload.requests) {
      element.append(emptyState("明细不可用：rollout 文件不存在或已被清理（对旧会话属预期）"));
      return;
    }

    const head = el("div", "zci-browser-head");
    const counts = payload.counts;
    head.append(
      el("span", "zci-browser-title", "请求序列"),
      el(
        "span",
        "zci-browser-meta",
        counts
          ? `${counts.total ?? payload.requests.length} 次请求 · full ${counts.full ?? 0} · delta ${counts.delta ?? 0} · tail ${counts.tail ?? 0}`
          : "",
      ),
    );
    element.append(head);

    const sessionId = payload.session?.id ?? "";
    const list = el("div", "zci-req-list");
    for (const req of payload.requests) {
      list.append(renderRequestRow(sessionId, req));
    }
    element.append(list);
  }

  function renderRequestRow(sessionId: string, req: RequestSummaryPayload): HTMLElement {
    const row = el("div", "zci-req-row");
    row.dataset.requestId = req.requestId;
    row.dataset.kind = req.messagesKind ?? "";
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const left = el("span", "zci-req-left");
    left.append(
      el("span", "zci-req-index", `#${req.index ?? 0}`),
      kindBadge(req.messagesKind),
      el("span", "zci-req-time", req.startedAt ? req.startedAt.slice(11, 19) : ""),
    );

    const right = el("span", "zci-req-right");
    const input = req.usage?.inputTokens;
    right.append(el("span", "zci-req-tokens", typeof input === "number" ? `输入 ${input}` : ""));

    row.append(left, right);
    row.addEventListener("click", () => void open(sessionId, req.requestId));
    return row;
  }

  // ------------------------------------------------------------------
  // 单请求明细（分组 / DNA 扁平）
  // ------------------------------------------------------------------

  function renderDetail(): void {
    element.replaceChildren();
    const payload = detailPayload;
    if (!payload) {
      element.append(emptyState("明细不可用"));
      return;
    }

    const toolbar = el("div", "zci-browser-toolbar");
    const back = el("button", "zci-btn", "← 返回请求列表");
    back.dataset.action = "back";
    back.addEventListener("click", () => {
      detailPayload = null;
      detailIds = null;
      dnaMode = false;
      renderList();
    });
    toolbar.append(back);
    element.append(toolbar);

    if (!payload.available) {
      element.append(emptyState(`明细不可用（${payload.reason ?? "未知原因"}）`));
      return;
    }

    // 请求摘要（形态徽标 + 模型 + 来源）
    const meta = el("div", "zci-detail-meta");
    const req = payload.request;
    meta.append(
      kindBadge(req?.messagesKind),
      el(
        "span",
        "zci-req-time",
        `${req?.requestId ?? detailIds?.requestId ?? ""} · ${req?.model?.modelId ?? ""} · ${req?.querySource ?? ""}`,
      ),
    );
    element.append(meta, renderUsageRow(payload));

    if (payload.snapshot !== "full" || !payload.composition) {
      // delta/tail 请求：无完整上下文快照（ADR-0002：非 full 不做组成估算）
      element.append(
        emptyState("无快照：该请求为 delta/tail 形态，未携带完整上下文——组成估算仅锚定 full 请求，精确用量见上方。"),
      );
      return;
    }

    // DNA 切换（分组 ↔ 扁平）
    const toggle = el("button", "zci-btn", dnaMode ? "分组模式" : "DNA 扁平模式");
    toggle.dataset.action = "toggle-dna";
    toggle.addEventListener("click", () => {
      dnaMode = !dnaMode;
      renderDetail();
    });
    element.append(toggle);

    element.append(dnaMode ? renderDna(payload.composition) : renderGrouped(payload.composition));
  }

  /** 精确 usage 行 + 估算合计行（估算/精确并存且视觉可区分，ADR-0002） */
  function renderUsageRow(payload: DetailPayload): HTMLElement {
    const u = payload.usage;
    const comp = payload.composition;
    const row = el("div", "zci-detail-usage");

    const exact = el("span", "zci-usage-exact");
    exact.append(
      el("span", "zci-badge zci-badge-exact", "精确"),
      el(
        "span",
        "zci-usage-text",
        `输入 ${u?.inputTokens ?? 0} · 输出 ${u?.outputTokens ?? 0} · 缓存读 ${u?.cacheReadTokens ?? 0} · 总量 ${u?.totalTokens ?? 0}`,
      ),
    );

    const est = el("span", "zci-usage-est");
    est.append(
      el("span", "zci-badge zci-badge-est", "估算"),
      el(
        "span",
        "zci-usage-text",
        comp
          ? `合计 ${comp.estimatedTotalTokens ?? 0} token` +
              (typeof comp.scale === "number" ? ` · 校准系数 ${comp.scale.toFixed(2)}` : "")
          : "",
      ),
    );

    row.append(exact, est);
    return row;
  }

  /** 分组模式：四分组小节 + 块列表 */
  function renderGrouped(comp: CompositionPayload): HTMLElement {
    const wrap = el("div", "zci-groups");
    for (const group of comp.groups ?? []) {
      const section = el("div", "zci-group");
      section.dataset.group = group.key;
      const title = el("div", "zci-group-title");
      title.append(
        el("span", "zci-group-name", group.label),
        el("span", "zci-group-est", `估算 ${group.estimatedTokens ?? 0} · ${group.blockCount ?? 0} 块`),
      );
      section.append(title);
      for (const block of (comp.blocks ?? []).filter((b) => b.groupKey === group.key)) {
        section.append(renderBlock(block, false));
      }
      wrap.append(section);
    }
    return wrap;
  }

  /** DNA 扁平模式：块按请求内顺序（seq）一维铺开 */
  function renderDna(comp: CompositionPayload): HTMLElement {
    const wrap = el("div", "zci-dna");
    const labelOf = new Map((comp.groups ?? []).map((g) => [g.key, g.label]));
    const blocks = [...(comp.blocks ?? [])].sort((a, b) => a.seq - b.seq);
    for (const block of blocks) {
      wrap.append(renderBlock(block, true, labelOf.get(block.groupKey) ?? block.groupKey));
    }
    return wrap;
  }

  /** 单块行：role/工具名 + 预览 + 估算；assistant 分块附 parts 子行 */
  function renderBlock(block: BlockPayload, dna: boolean, groupLabel?: string): HTMLElement {
    const row = el("div", dna ? "zci-dna-row" : "zci-block");
    const left = el("span", "zci-block-left");
    if (dna) {
      left.append(el("span", "zci-block-seq", `#${block.seq}`));
      if (groupLabel !== undefined) left.append(el("span", "zci-block-group", groupLabel));
    }
    const name =
      block.kind === "tool"
        ? `工具 ${block.name ?? ""}`
        : block.role === "tool" && block.toolName
          ? `tool · ${block.toolName}`
          : (block.role ?? "");
    left.append(el("span", "zci-block-role", name));
    if (block.preview) left.append(el("span", "zci-block-preview", block.preview));
    row.append(left, el("span", "zci-block-est", `${block.estimatedTokens ?? 0}`));

    if (block.parts && block.parts.length > 0) {
      const parts = el("div", "zci-block-parts");
      for (const part of block.parts) {
        const partRow = el("div", "zci-block-part");
        partRow.append(
          el("span", "zci-block-role", part.type),
          el("span", "zci-block-preview", part.preview ?? ""),
          el("span", "zci-block-est", `${part.estimatedTokens}`),
        );
        parts.append(partRow);
      }
      row.append(parts);
    }
    return row;
  }

  // ------------------------------------------------------------------
  // 小件
  // ------------------------------------------------------------------

  /** 形态徽标：full（有快照，正常态）/ delta、tail（无快照，弱化态） */
  function kindBadge(kind: string | undefined): HTMLElement {
    return el("span", `zci-kind-badge zci-kind-${kind === "full" ? "full" : "delta"}`, kind ?? "");
  }

  function emptyState(text: string): HTMLElement {
    return el("p", "zci-empty", text);
  }

  function el(tag: string, className: string, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined && text !== "") node.textContent = text;
    return node;
  }

  return { element, render, open };
}
