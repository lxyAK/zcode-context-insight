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
  /** 设置卡片（T12；设置持久于 server 侧 settings.json，跨会话生效） */
  settingsTitle: "设置",
  settingsFieldDefaultView: "默认视图",
  settingsFieldTrendGranularity: "趋势粒度",
  settingsFieldEstimationDensity: "估算密度",
  optionViewInsights: "Insights 总览",
  optionViewContext: "Context 仪表盘",
  optionViewFleet: "Fleet 代理网络",
  optionGranularityRequest: "逐请求",
  optionGranularityTurn: "按轮",
  optionGranularityDay: "按天",
  optionDensityCoarse: "粗略",
  optionDensityBalanced: "均衡",
  optionDensityDetailed: "精细",
  settingsSaved: "设置已保存",
  settingsSaveFailed: "保存失败：{message}",
  settingsUnavailable: "设置暂不可用",
  /** 刷新（T12：手动按钮兜底；自动刷新经 get_data_version 轮询，无需文案） */
  refreshButton: "刷新",
  /** Insights 活跃区（T9） */
  activityTitle: "活跃与模型组成",
  activityTitleRanged: "活跃与模型组成（最近 {range} 天）",
  activityUnavailable: "活跃数据暂不可用（未检测到宿主数据库）",
  heatmapTitle: "活跃热力图",
  heatmapAria: "最近 {range} 天活跃热力图",
  noActivity: "窗口内无活动",
  heatCellEmpty: "{date}｜无活动",
  heatCellActive: "{date}｜{requests} 次请求 · {tokens} token · {sessions} 会话",
  heatLegendLess: "少",
  heatLegendMore: "多",
  modelsTitle: "模型组成",
  providersTitle: "按供应商",
  donutSlice: "{label}｜{value} token（{pct}）",
  donutLegendValue: "{value} token｜{pct}",
  /** Fleet 代理网络树（T10） */
  fleetTitle: "Fleet 代理网络",
  fleetUnavailable: "代理网络暂不可用（未检测到宿主数据库或心跳）",
  fleetBadgeRootExplicit: "指定会话",
  fleetKvDuration: "请求耗时",
  fleetKvErrorRequests: "错误请求",
  fleetKvMs: "{ms} ms",
  fleetTaskInteractive: "主会话",
  fleetTaskSubagent: "子代理",
  fleetTaskOther: "子会话",
  fleetStatusCompleted: "已完成",
  fleetStatusRunning: "进行中",
  fleetStatusError: "错误",
  fleetStatusCancelled: "已取消",
  fleetStatusIdle: "无请求",
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
