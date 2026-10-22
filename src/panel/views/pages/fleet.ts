/**
 * Fleet 页占位（T8 只建立骨架；T10 在此渲染主会话与子代理的父子树与节点卡片）。
 * 挂载方式：替换本模块 mount 的占位渲染，或经 PAGES 注册表扩展。
 */
import type { PageDefinition } from "../registry.ts";
import { el } from "../dom.ts";
import { t } from "../../i18n.ts";

export const fleetPage: PageDefinition = {
  id: "fleet",
  title: t("navFleet"),
  mount: (ctx) => {
    const section = el(ctx.doc, "section", "zci-section");
    section.append(
      el(ctx.doc, "h2", "zci-subtitle", t("fleetTitle")),
      el(ctx.doc, "p", "zci-status", t("fleetPlaceholder")),
    );
    ctx.container.append(section);
  },
};
