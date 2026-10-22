/**
 * Fleet 页（T10 代理网络树装载于此；T8 建立页面骨架）。
 * 取数 get_fleet_tree（以当前会话为根的父子树），渲染树形节点卡片；
 * 刷新式静态树，无实时推送。工具失败/不可用由渲染函数降级。
 */
import type { PageDefinition } from "../registry.ts";
import { t } from "../../i18n.ts";
import { renderFleetSection, type FleetTreePayload } from "../fleet.ts";

export const fleetPage: PageDefinition = {
  id: "fleet",
  title: t("navFleet"),
  mount: async (ctx) => {
    const result = await ctx.callTool("get_fleet_tree", {});
    ctx.container.append(
      renderFleetSection(
        ctx.doc,
        result.ok ? (result.payload as unknown as FleetTreePayload) : null,
      ),
    );
  },
};
