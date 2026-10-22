/**
 * Fleet 页占位（T8 只建立骨架；T10 在此渲染主会话与子代理的父子树与节点卡片）。
 * 挂载方式：替换本模块 mount 的占位渲染，或经 PAGES 注册表扩展。
 */
import type { PageDefinition } from "../registry.ts";
import { el } from "../dom.ts";

export const fleetPage: PageDefinition = {
  id: "fleet",
  title: "Fleet",
  mount: (ctx) => {
    const section = el(ctx.doc, "section", "zci-section");
    section.append(
      el(ctx.doc, "h2", "zci-subtitle", "Fleet 代理网络"),
      el(ctx.doc, "p", "zci-status", "待装载：主会话与子代理的父子树及节点用量卡片（T10）。"),
    );
    ctx.container.append(section);
  },
};
