/**
 * 工具 get_current_session_composition（T3，面板专用 app 可见）：
 * 返回当前会话的上下文组成——以最近 full 请求为锚点的四分组组成估算
 * （system 提示 / 工具定义 / 历史消息 / 当前轮，ADR-0002：必须标注估算）
 * 与 API 精确总量（锚点 response.usage.inputTokens）。
 *
 * 口径（ADR-0002 / 研究笔记 03 §7）：
 *  - messagesKind 三态 full/delta/tail，只有 full 可作估算锚点，delta/tail 一律不锚定；
 *  - 纯 delta 会话（无 full 快照）：只返回精确总量，composition=null（面板显空态）；
 *  - rollout 文件被宿主清理属预期（ADR-0001）：available=false 降级，不抛错。
 *
 * 依赖注入缝：deps 显式指定 db/心跳/rollout 目录（测试/调试），缺省经 paths.ts
 * 从环境变量与宿主默认位置解析（env：ZCI_DB_PATH / ZCI_HEARTBEAT_PATH / ZCI_ROLLOUT_DIR）。
 */
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath, resolveRolloutDir } from "../paths.ts";
import { classifyDbError, openReadonlyDatabase } from "../db.ts";
import { readHeartbeat } from "../heartbeat.ts";
import { resolveCurrentSession } from "../usage.ts";
import { countByKind, pickFullAnchor, pickLatestInputTokens, readRolloutFile } from "../rollout.ts";
import { calibrateToAnchor, estimateRawComposition, GROUP_ORDER } from "../composition.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface CurrentSessionCompositionDeps {
  dbPath?: string;
  heartbeatPath?: string;
  rolloutDir?: string;
}

export function createCurrentSessionCompositionTool(
  deps: CurrentSessionCompositionDeps = {},
): ToolDefinition {
  return {
    name: "get_current_session_composition",
    title: "当前会话上下文组成",
    description:
      "返回当前会话的上下文组成：以最近 full 请求为锚点的四分组组成估算" +
      "（system 提示 / 工具定义 / 历史消息 / 当前轮，均为估算值并附锚点归一化因子）" +
      "与 API 精确总量（锚点 inputTokens）。delta/tail 请求不参与锚定；" +
      "纯 delta 会话只返回精确总量（composition 为空）；rollout 文件被宿主清理时降级返回。",
    inputSchema: z.object({}),
    visibility: ["app"],
    execute: async () => {
      const payload = collectCurrentSessionComposition(deps);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 采集逻辑（任何失败降级为 available=false，不抛错） */
function collectCurrentSessionComposition(
  deps: CurrentSessionCompositionDeps,
): Record<string, unknown> {
  // 1) 会话识别：心跳精确优先；无心跳走 db 最近活跃 interactive 兜底（ADR-0003）。
  //    兜底查询遇 schema 漂移（如 session 表缺失）按 T13 分类降级，不抛错
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();
  let session: { id: string; source: "heartbeat" | "inferred" } | null = null;
  const heartbeat = readHeartbeat(heartbeatPath);
  if (heartbeat) {
    session = { id: heartbeat.sessionId, source: "heartbeat" };
  } else {
    const opened = openReadonlyDatabase(deps.dbPath ?? resolveDbPath());
    if (opened.ok) {
      try {
        const current = resolveCurrentSession(opened.db, ""); // 心跳路径传空 → 走推断兜底分支
        if (current) session = { id: current.id, source: current.source };
      } catch (err) {
        return {
          available: false,
          reason: classifyDbError(err),
          session: null,
          exactTotalTokens: null,
          anchor: null,
          composition: null,
        };
      } finally {
        opened.db.close();
      }
    }
  }
  if (!session) {
    return { available: false, reason: "no-session", session: null, exactTotalTokens: null, anchor: null, composition: null };
  }

  // 2) 读取该会话的 rollout JSONL（文件名直拼契约：model-io-<sessionId>.jsonl）
  const rolloutDir = deps.rolloutDir ?? resolveRolloutDir();
  const rolloutResult = readRolloutFile(join(rolloutDir, `model-io-${session.id}.jsonl`));
  if (!rolloutResult.ok) {
    return {
      available: false,
      reason: rolloutResult.reason,
      session,
      rollout: { found: false, requests: null },
      exactTotalTokens: null,
      anchor: null,
      composition: null,
    };
  }

  // 3) 分类计数 + 锚点选择（非 full 一律不锚定）
  const records = rolloutResult.records;
  const anchor = pickFullAnchor(records);

  const payload: Record<string, unknown> = {
    available: true,
    session,
    rollout: { found: true, requests: countByKind(records) },
  };

  if (!anchor) {
    // 纯 delta 会话：只展示精确总量（取最后一条带用量记录的 inputTokens）
    payload.anchor = null;
    payload.composition = null;
    payload.compositionReason = "no-full-snapshot";
    payload.exactTotalTokens = pickLatestInputTokens(records);
    return payload;
  }

  payload.exactTotalTokens = anchor.usage!.inputTokens;
  payload.anchor = {
    requestId: anchor.requestId,
    index: anchor.index,
    kind: "full",
    inputTokens: anchor.usage!.inputTokens,
    messageCount: anchor.messageCount,
    messageOffset: anchor.messageOffset,
  };

  // 4) 四分组原始折算 + 锚点校准（归一化方式随 scaleFactor 透出）
  const raw = estimateRawComposition(anchor);
  const rawTotal = GROUP_ORDER.reduce((sum, k) => sum + raw[k], 0);
  if (rawTotal <= 0) {
    payload.composition = null;
    payload.compositionReason = "empty-anchor-content";
    return payload;
  }
  const { calibrated, scaleFactor } = calibrateToAnchor(raw, anchor.usage!.inputTokens);
  payload.composition = { estimated: true, raw, calibrated, scaleFactor };
  return payload;
}
