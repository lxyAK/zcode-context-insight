/**
 * 工具 get_current_session_report（T11，model+app 双可见）：
 * /context 命令的后端——返回当前会话的组成摘要：
 *  - 精确用量（aggregateSessionUsage，API 精确值，总量以 computed_total_tokens 为准）；
 *  - 组成估算（T3 rollout 估算未接入前：estimated=false，以 API 精确总量兜底呈现，
 *    四分组留空待接）；
 *  - 接近压缩提醒（启发式：最近 completed main_turn 请求的 input_tokens（含缓存读，
 *    近似最近上下文占用）÷ 该会话最近压缩事件 preCompactTokenCount（实测阈值代理），
 *    ≥80% 判定接近；无压缩历史即无依据，省略提醒）。
 *
 * 会话识别复用 resolveCurrentSession（ADR-0003：心跳优先，无心跳兜底最近活跃
 * interactive 会话并标注推断）。依赖注入缝与降级语义同 get_current_session_usage。
 */
import { z } from "zod";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath } from "../paths.ts";
import { openReadonlyDatabase } from "../db.ts";
import { aggregateSessionUsage, getSessionRow, getLatestCompactionThreshold, getRecentContextTokens, resolveCurrentSession } from "../usage.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface CurrentSessionReportDeps {
  dbPath?: string;
  heartbeatPath?: string;
}

export function createCurrentSessionReportTool(
  deps: CurrentSessionReportDeps = {},
): ToolDefinition {
  return {
    name: "get_current_session_report",
    title: "当前会话组成摘要",
    description:
      "返回当前会话的组成摘要（/context 命令后端）：精确用量（请求数、" +
      "input/output/缓存读/缓存写/推理 token 合计，总量以宿主 computed_total_tokens 口径为准，" +
      "input 已含缓存读部分）、组成估算（四分组：system 提示/工具定义/历史消息/当前轮，" +
      "标注估算；估算源不可用时降级为精确总量兜底）与接近压缩提醒（基于最近上下文占用" +
      "占该会话最近压缩事件实测阈值的比例，无依据时省略）。" +
      "会话识别来源：heartbeat=用户提交心跳（精确）；inferred=最近活跃 interactive 会话（推断）。",
    inputSchema: z.object({}),
    visibility: ["model", "app"],
    execute: async () => {
      const payload = collectCurrentSessionReport(deps);
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };
}

/** 压缩提醒触发比例（占用 ≥ 阈值的 80% 判定"接近压缩"，口径自定并在返回 basis 中声明） */
const COMPACTION_TRIGGER_RATIO = 0.8;

/** ratio 保留 4 位小数（浮点除法避免长尾） */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 压缩提醒（返回中声明启发式口径）；分子分母任一缺失（无依据）时省略整个字段 */
function assessCompaction(
  db: Parameters<typeof getRecentContextTokens>[0],
  sessionId: string,
): Record<string, unknown> | null {
  const currentContextTokens = getRecentContextTokens(db, sessionId);
  const thresholdTokens = getLatestCompactionThreshold(db, sessionId);
  if (currentContextTokens === null || thresholdTokens === null) return null;
  const ratio = round4(currentContextTokens / thresholdTokens);
  return {
    present: ratio >= COMPACTION_TRIGGER_RATIO,
    ratio,
    currentContextTokens,
    thresholdTokens,
    triggerRatio: COMPACTION_TRIGGER_RATIO,
    basis:
      "启发式口径：最近一次 completed main_turn 模型请求的 input_tokens（含缓存读，近似最近上下文占用）" +
      "÷ 该会话最近压缩事件的 preCompactTokenCount（宿主实测触发压缩的上下文规模，作压缩阈值代理）；" +
      `比值 ≥ ${COMPACTION_TRIGGER_RATIO} 判定接近压缩。无压缩历史或无请求样本时不猜阈值，省略本字段。`,
  };
}

/** 采集逻辑（同步；任何失败降级为 available=false，不炸面板） */
function collectCurrentSessionReport(deps: CurrentSessionReportDeps): Record<string, unknown> {
  const dbPath = deps.dbPath ?? resolveDbPath();
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();

  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) {
    return { available: false, reason: opened.reason, session: null, usage: null };
  }
  try {
    const current = resolveCurrentSession(opened.db, heartbeatPath);
    if (!current) {
      return { available: false, reason: "no-interactive-session", session: null, usage: null };
    }
    const row = getSessionRow(opened.db, current.id);
    const usage = aggregateSessionUsage(opened.db, current.id);
    // 组成估算（T3 rollout 四分组估算）未接入：以 API 精确总量兜底呈现，结构缝保留
    // groups 字段待接（接入后 estimated=true 并填 system 提示/工具定义/历史消息/当前轮）。
    const composition = {
      estimated: false,
      basis: "exact-usage-fallback",
      exactTotalTokens: usage.computedTotalTokens,
      groups: null,
      note: "组成估算暂不可用（待 rollout 组成估算接入），以下为 API 精确总量兜底，不含分组",
    };
    return {
      available: true,
      session: {
        id: current.id,
        source: current.source,
        heartbeatAt: current.heartbeatAt,
        title: row?.title ?? null,
        taskType: row?.taskType ?? null,
        timeCreated: row?.timeCreated ?? null,
        timeUpdated: row?.timeUpdated ?? null,
      },
      usage,
      composition,
      compactionWarning: assessCompaction(opened.db, current.id),
    };
  } catch (err) {
    // schema 漂移（缺表缺列）等查询期异常：降级而非炸面板（细粒度探测见 T13）
    return {
      available: false,
      reason: `query-failed: ${err instanceof Error ? err.message : String(err)}`,
      session: null,
      usage: null,
    };
  } finally {
    opened.db.close();
  }
}
