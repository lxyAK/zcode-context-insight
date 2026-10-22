/**
 * T7 面板视图：事件流与文件活动两个可滚动列表（数据载荷为对应 MCP 工具的
 * structuredContent 形状）。本文件只做渲染；取数与挂载在 panel.ts 装配层。
 *
 * 空态约定：available=true 且列表为空 → .zci-empty（"暂无…记录"）；
 * 工具失败/不可用 → .zci-status 降级提示（"…暂不可用"）。
 * 可滚动由 .zci-list 的 max-height + overflow-y 样式契约提供（panel.css）。
 */

/** get_session_events 的 structuredContent 形状 */
export interface EventsPayload {
  available: boolean;
  reason?: string;
  events?: Array<{
    type: "compaction" | "model_change" | string;
    time: number;
    trigger?: "manual" | "auto" | "unknown" | null;
    preCompactTokens?: number | null;
    postCompactTokens?: number | null;
    summarizedMessages?: number | null;
    modelId?: string | null;
    providerId?: string | null;
  }> | null;
}

/** get_session_file_activity 的 structuredContent 形状 */
export interface FileActivityPayload {
  available: boolean;
  reason?: string;
  activities?: Array<{
    time: number;
    operation: "read" | "write" | "edit" | "search" | string;
    path: string | null;
    detail: string | null;
    additions: number | null;
    deletions: number | null;
    status: string | null;
  }> | null;
}

function el(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 事件时间显示（本地时区 HH:MM:SS；宿主时间戳为 Unix 毫秒） */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 渲染事件流区（压缩 / 模型切换，按工具返回的时间升序） */
export function renderEventsSection(doc: Document, payload: EventsPayload | null): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "h2", "zci-subtitle", "事件流"));

  if (!payload?.available || !payload.events) {
    section.append(el(doc, "p", "zci-status", "事件暂不可用（未检测到宿主数据库或心跳）"));
    return section;
  }
  if (payload.events.length === 0) {
    section.append(el(doc, "p", "zci-empty", "暂无事件记录"));
    return section;
  }

  const list = el(doc, "div", "zci-list");
  for (const ev of payload.events) {
    const item = el(doc, "div", "zci-list-item");
    let main: string;
    let detail = "";
    if (ev.type === "compaction") {
      // 触发方式（spec：压缩事件必含）；token 数缺失时只显示触发方式
      main = ev.trigger === "manual" ? "压缩（手动）" : ev.trigger === "auto" ? "压缩（自动）" : "压缩";
      if (ev.preCompactTokens != null && ev.postCompactTokens != null) {
        detail = `${ev.preCompactTokens} → ${ev.postCompactTokens} token`;
      }
      if (ev.summarizedMessages != null) detail += ` · 总结 ${ev.summarizedMessages} 条`;
    } else if (ev.type === "model_change") {
      main = "模型切换";
      detail = ev.modelId ?? ev.providerId ?? "";
    } else {
      main = String(ev.type); // 漂移容错：未知事件类型原样展示类型名
    }
    item.append(
      el(doc, "span", "zci-item-time", formatTime(ev.time)),
      el(doc, "span", "zci-item-main", detail ? `${main} ${detail}` : main),
    );
    list.append(item);
  }
  section.append(list);
  return section;
}

/** 文件操作类型 → 中文标签 */
const OP_LABELS: Record<string, string> = {
  read: "读取",
  write: "写入",
  edit: "编辑",
  search: "搜索",
};

/** 行数变化显示：编辑 +a / -d，写入 +a，读取/搜索无 */
function formatLines(additions: number | null, deletions: number | null): string {
  const parts: string[] = [];
  if (additions != null) parts.push(`+${additions}`);
  if (deletions != null) parts.push(`-${deletions}`);
  return parts.join(" / ");
}

/** 渲染文件活动区（读取/写入/编辑/搜索，按工具返回的时间升序） */
export function renderFileActivitySection(doc: Document, payload: FileActivityPayload | null): HTMLElement {
  const section = el(doc, "section", "zci-section");
  section.append(el(doc, "h2", "zci-subtitle", "文件活动"));

  if (!payload?.available || !payload.activities) {
    section.append(el(doc, "p", "zci-status", "文件活动暂不可用（未检测到宿主数据库或心跳）"));
    return section;
  }
  if (payload.activities.length === 0) {
    section.append(el(doc, "p", "zci-empty", "暂无文件活动记录"));
    return section;
  }

  const list = el(doc, "div", "zci-list");
  for (const act of payload.activities) {
    const item = el(doc, "div", "zci-list-item");
    // 路径：Read/Write/Edit 为目标文件；Grep/Glob 为搜索根目录 + pattern
    const pathText = act.detail ? `${act.path ?? "-"} · ${act.detail}` : (act.path ?? "-");
    item.append(
      el(doc, "span", "zci-item-time", formatTime(act.time)),
      el(doc, "span", "zci-item-op", OP_LABELS[act.operation] ?? String(act.operation)),
      el(doc, "span", "zci-item-path", pathText),
    );
    const lines = formatLines(act.additions, act.deletions);
    if (lines) item.append(el(doc, "span", "zci-item-lines", lines));
    if (act.status === "error") item.append(el(doc, "span", "zci-tag-error", "失败"));
    list.append(item);
  }
  section.append(list);
  return section;
}
