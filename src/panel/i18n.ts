/**
 * 面板文案中心（i18n 骨架，T14 建立）。
 * 约定（见 spec issue #1 Implementation Decisions）：
 *  - zh-CN 为默认且当前唯一语言；面板文案 zh-CN，仅留 i18n 扩展结构，不做英文文案。
 *  - 面板侧用户可见文案逐步迁入此处（本票迁移骨架期既有文案；
 *    各视图工单新增的文案后续自行迁入，不强制一次性全量迁移）。
 *  - 协议层（bridge.ts）的错误信息不经过本模块，保持桥独立。
 */

/** zh-CN 文案表：键名即语义，值必须为 zh-CN 文案；占位符形如 {host} */
const zhCN = {
  /** 页头品牌名（专有名词，各语言一致） */
  brandName: "Context Insight",
  /** 概览区 */
  connectedHost: "已连接 {host}",
  kvPlugin: "插件",
  kvServer: "MCP server",
  footerSkeleton: "骨架就绪：后续工单将在此装载 Insights / Context 仪表盘 / Fleet 页面。",
  /** 当前会话精确用量区（T2） */
  usageTitle: "当前会话精确用量",
  badgeHeartbeat: "心跳精确",
  badgeInferred: "推断（最近活跃会话）",
  kvSession: "会话",
  kvRequests: "请求数",
  kvInputTokens: "输入 token",
  kvOutputTokens: "输出 token",
  kvCacheReadTokens: "缓存读 token",
  kvCacheWriteTokens: "缓存写 token",
  kvTotalTokens: "总量 token",
  kvVersion: "版本",
  usageUnavailable: "用量暂不可用（未检测到宿主数据库或心跳）",
  usageUnavailableReason: "用量暂不可用（{reason}）",
  /** 初始/错误态 */
  loading: "加载中…",
  noRootContainer: "面板缺少 #root 容器",
  overviewNoText: "get_overview 未返回文本内容",
  toolCallFailed: "工具调用失败: {message}",
  toolCallFailedTool: "工具调用失败（{tool}）: {message}",
  panelLoadFailed: "面板加载失败: {message}",
  pageLoadFailed: "页面加载失败（{page}）: {message}",
  /** 三页路由壳（T8） */
  headerConnected: "已连接 {host}",
  navInsights: "Insights",
  navContext: "Context",
  navFleet: "Fleet",
  /** Insights 页（T8） */
  insightsKpiTotalTokens: "总 token",
  insightsKpiSessions: "会话数",
  insightsKpiActiveDays: "活跃天数",
  insightsTrendTitle: "7 天 token 趋势",
  insightsTrendTooltip: "{date}：{tokens} token / {requests} 请求 / {sessions} 会话",
  insightsSessionsTitle: "会话卡片",
  insightsSessionCount: "共 {count} 个",
  insightsFilterAllProjects: "全部项目",
  insightsFilterAllTime: "全部时间",
  insightsFilterLast7: "最近 7 天",
  insightsFilterLast30: "最近 30 天",
  insightsFilterAllSizes: "全部规模",
  insightsFilterSize1k: "≥1k token",
  insightsFilterSize10k: "≥10k token",
  insightsFilterSize100k: "≥100k token",
  insightsFilterSortRecent: "按时间排序",
  insightsFilterSortTokens: "按规模排序",
  insightsNoSessions: "无符合筛选条件的会话",
  insightsUnavailableTitle: "Insights 总览暂不可用",
  insightsUnavailableReason: "原因：{reason}",
  insightsSubagentBadge: "子代理",
  insightsSessionMeta: "{dir} · {time} · {requests} 请求",
  insightsSessionTokens: "{value} token",
  insightsRouteFrom: "来自 Insights",
  /** Context 仪表盘页（T8；区块文案由各区块视图自带） */
  contextSelectedTitle: "已选会话",
  contextKvTitle: "标题",
  contextKvSessionId: "会话 ID",
  contextKvTokens: "合计 token",
  contextKvRequests: "请求数",
  contextKvRecent: "最近更新",
  contextSelectedNote: "会话级明细区块（组成/趋势/事件流）由后续工单在此装载。",
  /** Fleet 页占位（T8 骨架，T10 装载） */
  fleetTitle: "Fleet 代理网络",
  fleetPlaceholder: "待装载：主会话与子代理的父子树及节点用量卡片（T10）。",
} as const;

export type MessageKey = keyof typeof zhCN;

/** 语言包注册表：新增语言时在此扩展键（如 "en-US": enUS），并让 t() 类型收敛 */
const dictionaries: Record<string, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
};

/** 默认语言（zh-CN 为默认且唯一） */
export const DEFAULT_LOCALE = "zh-CN";

let currentLocale: string = DEFAULT_LOCALE;

/** 设定面板语言；未知/未注册语言回落默认。宿主 locale 经握手可得时在此接入 */
export function setLocale(locale: string | undefined): void {
  if (locale && dictionaries[locale]) currentLocale = locale;
}

/** 当前语言（骨架期恒为 zh-CN） */
export function getLocale(): string {
  return currentLocale;
}

/** 取文案；params 做 {name} 占位符替换 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text = dictionaries[currentLocale][key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
