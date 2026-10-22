/**
 * 面板视图共享 DOM/格式化工具（纯函数，无桥依赖；各页视图复用）。
 */

/** 建元素并可选挂类名与文本 */
export function el(
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

/** 千分位整数（不依赖 Intl，沙箱内确定性输出）：1815 → "1,815" */
export function fmtInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Unix 毫秒 → "YYYY-MM-DD HH:mm"（UTC，确定性；卡片与横幅的时间显示） */
export function fmtDateTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** 目录路径缩短显示：取最后一段（跨平台分隔符） */
export function shortDir(directory: string): string {
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : directory;
}
