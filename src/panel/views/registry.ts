/**
 * 页面注册表与路由契约（T8 建立，T9/T10 及后续工单的挂载基础）：
 *  - 新页面 = views/pages/ 下新模块导出 PageDefinition，加入 PAGES 数组即出现在导航；
 *  - 页面经 PageContext 取数（callTool）与导航（navigate），不直接触碰桥协议层；
 *  - 跨页传参缝：RouteParams（如 Insights 会话卡片 → Context 仪表盘的 sessionId），
 *    后续工单的会话级区块直接读 ctx.params.sessionId。
 */
import { insightsPage } from "./pages/insights.ts";
import { contextPage } from "./pages/context.ts";
import { fleetPage } from "./pages/fleet.ts";

/** 路由参数（跨页传值缝；sessionId 供 Context 仪表盘锚定目标会话） */
export type RouteParams = Record<string, string | number | boolean | null | undefined>;

/** callTool 结果：桥错误携带 message 供页面渲染（不吞错） */
export type ToolCallResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/** 页面渲染上下文（挂载缝：视图模块的唯一外部依赖） */
export interface PageContext {
  doc: Document;
  /** 页面内容挂载容器（导航之外的正文区） */
  container: HTMLElement;
  /** 本页当前路由参数（如 { sessionId }） */
  params: RouteParams;
  /** 跳转页面（带参数）；目标页 mount 时经 ctx.params 收到 */
  navigate: (pageId: string, params?: RouteParams) => void;
  /** callServerTool 封装：解析 text 块 JSON；桥失败返回 { ok:false, error } */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  /** 宿主名（页头"已连接"标注用；装配层注入） */
  hostName?: string;
}

/** 页面定义（注册表条目） */
export interface PageDefinition {
  id: string;
  title: string;
  mount: (ctx: PageContext) => void | Promise<void>;
}

/** 页面注册表：新页在此追加（顺序即导航顺序） */
export const PAGES: PageDefinition[] = [insightsPage, contextPage, fleetPage];

/** 初始页（Insights 为跨会话总览，作默认落地页） */
export const DEFAULT_PAGE_ID = "insights";
