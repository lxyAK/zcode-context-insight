/**
 * Fleet 代理网络树视图（T10）：get_fleet_tree 载荷 → 刷新式静态树 + 节点卡片。
 * 独立视图文件：不发请求、不碰桥，只做纯渲染；请求由 panel.ts 装配层发出。
 * 节点卡片呈现该会话的 token / 请求耗时 / 状态（GLOSSARY「Fleet（代理网络）」口径）。
 */
import { t } from "../i18n.ts";
import { el } from "./dom.ts";

/** Fleet 树节点（get_fleet_tree structuredContent.root 的形状） */
export interface FleetNodePayload {
  id: string;
  title: string | null;
  taskType: string | null;
  parentId: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    computedTotalTokens: number;
    durationMsTotal: number;
    errorRequests: number;
    lastRequestStatus: string | null;
  };
  children: FleetNodePayload[];
}

/** get_fleet_tree 的 structuredContent 形状 */
export interface FleetTreePayload {
  available: boolean;
  reason?: string;
  rootSessionSource?: "heartbeat" | "inferred" | "explicit" | null;
  root?: FleetNodePayload | null;
}

/** task_type → 节点类型标签（未知类型统一归"子会话"，schema 漂移容错） */
function taskTypeLabel(taskType: string | null): string {
  if (taskType === "interactive") return t("fleetTaskInteractive");
  if (taskType === "subagent_child") return t("fleetTaskSubagent");
  return t("fleetTaskOther");
}

/** 最近请求状态 → 展示文案（含状态样式类名）；无请求行显示"无请求" */
function statusBadge(doc: Document, status: string | null): HTMLElement {
  const key =
    status === "completed"
      ? "fleetStatusCompleted"
      : status === "running"
        ? "fleetStatusRunning"
        : status === "error"
          ? "fleetStatusError"
          : status === "cancelled"
            ? "fleetStatusCancelled"
            : "fleetStatusIdle";
  return el(doc, "span", `zci-fleet-status zci-fleet-status-${status ?? "idle"}`, t(key));
}

/** 单个节点卡片：标题行（标题 + 类型 + 状态徽标）+ 用量指标行 */
function fleetCard(doc: Document, node: FleetNodePayload): HTMLElement {
  const card = el(doc, "li", "zci-fleet-node");
  const head = el(doc, "div", "zci-fleet-node-head");
  head.append(
    el(doc, "span", "zci-fleet-node-title", node.title ?? node.id),
    el(doc, "span", "zci-fleet-task", taskTypeLabel(node.taskType)),
    statusBadge(doc, node.usage.lastRequestStatus),
  );
  card.append(head);

  const metrics = el(doc, "div", "zci-fleet-metrics");
  const metric = (label: string, value: string) => {
    const item = el(doc, "span", "zci-fleet-metric");
    item.append(el(doc, "span", "zci-fleet-metric-label", label), el(doc, "span", "zci-fleet-metric-value", value));
    return item;
  };
  metrics.append(
    metric(t("kvRequests"), String(node.usage.requests)),
    metric(t("kvTotalTokens"), String(node.usage.computedTotalTokens)),
    metric(t("kvInputTokens"), String(node.usage.inputTokens)),
    metric(t("kvOutputTokens"), String(node.usage.outputTokens)),
    metric(t("fleetKvDuration"), t("fleetKvMs", { ms: node.usage.durationMsTotal })),
  );
  // 错误请求数只在非 0 时呈现（避免正常节点噪音）
  if (node.usage.errorRequests > 0) {
    metrics.append(metric(t("fleetKvErrorRequests"), String(node.usage.errorRequests)));
  }
  card.append(metrics);
  return card;
}

/** 递归渲染树分支：节点卡片 + 嵌套子层容器（缩进由 CSS 左边框呈现） */
function renderNode(doc: Document, node: FleetNodePayload): HTMLElement {
  const card = fleetCard(doc, node);
  if (node.children.length > 0) {
    const children = el(doc, "ul", "zci-fleet-children");
    for (const child of node.children) children.append(renderNode(doc, child));
    card.append(children);
  }
  return card;
}

/** Fleet 区（T10）：静态树；根识别来源标注（心跳精确/推断/指定会话）；不可用时降级提示 */
export function renderFleetSection(doc: Document, payload: FleetTreePayload | null): HTMLElement {
  const section = el(doc, "section", "zci-section");
  const title = el(doc, "h2", "zci-subtitle", t("fleetTitle"));
  section.append(title);

  if (!payload?.available || !payload.root) {
    section.append(el(doc, "p", "zci-status", t("fleetUnavailable")));
    return section;
  }

  // 根识别来源标注（ADR-0003：heartbeat=心跳精确；inferred=最近活跃推断；explicit=显式指定）
  const source = payload.rootSessionSource;
  if (source === "heartbeat" || source === "inferred") {
    title.append(
      el(
        doc,
        "span",
        source === "heartbeat" ? "zci-badge zci-badge-exact" : "zci-badge zci-badge-inferred",
        source === "heartbeat" ? t("badgeHeartbeat") : t("badgeInferred"),
      ),
    );
  } else if (source === "explicit") {
    title.append(el(doc, "span", "zci-badge zci-badge-inferred", t("fleetBadgeRootExplicit")));
  }

  const tree = el(doc, "ul", "zci-fleet-tree");
  tree.append(renderNode(doc, payload.root));
  section.append(tree);
  return section;
}
