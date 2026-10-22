/**
 * 请求明细工具（T6，面板专用 app 可见）：Context Browser 与 DNA 扁平视图的数据面。
 *
 *  - list_session_requests：列出会话的模型请求序列（来自 rollout model-io JSONL，
 *    每行=一次完整请求记录），返回形态（messagesKind full/delta/tail）与精确 usage；
 *  - get_request_detail：单次请求的组成明细——四分组（GLOSSARY：system 提示 / 工具定义 /
 *    历史消息 / 当前轮）下的块级列表、块/分组/合计三级 token 估算与精确总量校准系数。
 *
 * 口径（ADR-0002 / 研究笔记 03 §7）：
 *  - 组成估算只锚定 messagesKind=full 的请求快照；delta/tail（非 full）一律 snapshot=none
 *    不做估算——纯 delta 会话的请求显示"无快照"空态；
 *  - 估算复用单一底座（P0-4 统一）：行解析 = src/server/rollout.ts 的 readRolloutFile，
 *    字符折算 = src/server/composition.ts 的 estimateTextTokens（ceil(ASCII/4) + CJK×1），
 *    分组口径与 estimateRawComposition 一致（system 去重、当前轮=最后一条 user 起的非
 *    system 消息）；本文件只在其上构建块级明细结构；
 *  - 精确总量始终用 response.usage 的 API 值，估算与精确并存不冒充（scale=精确输入/
 *    估算合计，供锚点校准展示）。
 *
 * 依赖注入缝：deps 允许显式指定 db / 心跳 / rollout 目录（测试与调试），
 * 缺 sessionId 时默认解析当前会话（心跳优先，兜底最近活跃 interactive，ADR-0003）。
 * rollout 缺文件/坏行容错（ADR-0001：文件被清理属预期，降级不抛错）。
 */
import { z } from "zod";
import { join } from "node:path";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath, resolveRolloutDir } from "../paths.ts";
import { classifyDbError, openReadonlyDatabase } from "../db.ts";
import { readHeartbeat } from "../heartbeat.ts";
import { resolveInferredSession } from "../usage.ts";
import { readRolloutFile, type RolloutRecord } from "../rollout.ts";
import { estimateTextTokens } from "../composition.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface RequestDetailDeps {
  dbPath?: string;
  heartbeatPath?: string;
  rolloutDir?: string;
}

// ---------------------------------------------------------------------------
// 预览截断（明细只回结构化摘要，不外漏全文正文）
// ---------------------------------------------------------------------------

/** 预览截断上限 */
const PREVIEW_MAX_CHARS = 120;

/** 预览文本：压缩空白后截断，避免面板载荷外漏全文 */
function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// rollout 读取（复用底座 readRolloutFile；此处只做请求序列语义的薄适配）
// ---------------------------------------------------------------------------

/** 请求序列读取结果（空文件按"可用但零请求"保留 T6 既有行为） */
type RequestLineSource =
  | { ok: true; lines: RolloutRecord[]; parseSkipped: number }
  | { ok: false; reason: string };

/**
 * 读取会话的 rollout 请求行：底座解析 + 无 requestId 行计入跳过数
 * （请求序列语义要求每行可按 requestId 定位，明细工具据此查找单行）。
 */
function readRolloutRequests(rolloutDir: string, sessionId: string): RequestLineSource {
  const read = readRolloutFile(join(rolloutDir, `model-io-${sessionId}.jsonl`));
  if (!read.ok) {
    if (read.reason === "rollout-empty") return { ok: true, lines: [], parseSkipped: 0 };
    return { ok: false, reason: read.reason };
  }
  const lines = read.records.filter((r) => typeof r.requestId === "string" && r.requestId.length > 0);
  const parseSkipped = read.parseSkipped + (read.records.length - lines.length);
  return { ok: true, lines, parseSkipped };
}

// ---------------------------------------------------------------------------
// 组成明细构建（四分组 + 块级扁平序；分组口径与底座 estimateRawComposition 一致）
// ---------------------------------------------------------------------------

type GroupKey = "system" | "tools" | "history" | "current";

/** 四分组固定顺序与中文名（GLOSSARY #15） */
const GROUP_ORDER: Array<{ key: GroupKey; label: string }> = [
  { key: "system", label: "system 提示" },
  { key: "tools", label: "工具定义" },
  { key: "history", label: "历史消息" },
  { key: "current", label: "当前轮" },
];

/** 消息块（字符串 content 为整块；数组 content 附 parts 分块） */
interface MessageBlock {
  seq: number;
  groupKey: GroupKey;
  kind: "message";
  role: string;
  estimatedTokens: number;
  preview: string;
  toolName?: string;
  toolCallId?: string;
  parts?: Array<{ type: string; estimatedTokens: number; preview: string }>;
}

/** 工具定义块（估算基线 = 工具定义 JSON 序列化文本，即请求报文实际载荷） */
interface ToolBlock {
  seq: number;
  groupKey: "tools";
  kind: "tool";
  name: string;
  estimatedTokens: number;
  preview: string;
}

type CompositionBlock = MessageBlock | ToolBlock;

interface Composition {
  /** 估算合计（各块估算之和；与精确 usage 并存，展示需标注"估算"） */
  estimatedTotalTokens: number;
  /** 锚点校准系数 = 精确 inputTokens / 估算合计（任一为 0 时为 null） */
  scale: number | null;
  groups: Array<{ key: GroupKey; label: string; estimatedTokens: number; blockCount: number }>;
  /** 块级扁平序（DNA 模式数据底座）：按请求内顺序编号，工具定义插在头部 system 提示之后 */
  blocks: CompositionBlock[];
}

/**
 * 构建 full 请求的组成明细。非 full 请求返回 null（ADR-0002：delta/tail 不作基准）。
 * 分组口径与底座 estimateRawComposition 一致：system=role=system 消息（body.system
 * 仅在 messages 无 system 消息时兜底）；当前轮=最后一条 user 及其后的非 system 消息。
 * 顺序规则：messages 数组顺序即请求内顺序；工具定义插在首条非 system 消息之前
 * （对应 API 报文 system → tools → messages 的逻辑顺序）；尾部 system 提醒保留其实际位置。
 */
function buildComposition(line: RolloutRecord): Composition | null {
  if (line.messagesKind !== "full") return null;

  const messages = line.messages;
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") lastUserIndex = i;
  }

  const blocks: CompositionBlock[] = [];
  let seq = 0;

  // 兜底：messages 无 system 消息但 body.system 有定义（防御性，真实形态两处逐字重复）
  const hasSystemMessage = messages.some((m) => m.role === "system");
  if (!hasSystemMessage && line.systemBlocks.length > 0) {
    for (const text of line.systemBlocks) {
      blocks.push({
        seq: seq++,
        groupKey: "system",
        kind: "message",
        role: "system",
        estimatedTokens: estimateTextTokens(text),
        preview: previewOf(text),
      });
    }
  }

  const pushToolBlocks = () => {
    for (const def of line.tools) {
      const json = safeStringify(def);
      const name = typeof (def as Record<string, unknown>).name === "string"
        ? (def as Record<string, unknown>).name as string
        : "(unnamed)";
      const description = typeof (def as Record<string, unknown>).description === "string"
        ? (def as Record<string, unknown>).description as string
        : "";
      blocks.push({
        seq: seq++,
        groupKey: "tools",
        kind: "tool",
        name,
        estimatedTokens: estimateTextTokens(json),
        preview: previewOf(description || json),
      });
    }
  };

  let toolsInserted = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "system" && !toolsInserted) {
      pushToolBlocks(); // 头部 system 提示结束、首条会话消息之前
      toolsInserted = true;
    }
    // 分组口径与底座一致：system → system；最后一条 user 起的非 system → 当前轮
    const groupKey: GroupKey =
      m.role === "system" ? "system" : lastUserIndex >= 0 && i >= lastUserIndex ? "current" : "history";

    const block: MessageBlock = {
      seq: seq++,
      groupKey,
      kind: "message",
      role: m.role,
      estimatedTokens: 0,
      preview: "",
    };
    if (m.toolName !== undefined) block.toolName = m.toolName;
    if (m.toolCallId !== undefined) block.toolCallId = m.toolCallId;

    const content = m.content;
    if (typeof content === "string") {
      block.estimatedTokens = estimateTextTokens(content);
      block.preview = previewOf(content);
    } else if (Array.isArray(content)) {
      const parts = content.map((part) => {
        const text = typeof (part as Record<string, unknown>)?.text === "string"
          ? ((part as Record<string, unknown>).text as string)
          : "";
        const type = typeof (part as Record<string, unknown>)?.type === "string"
          ? ((part as Record<string, unknown>).type as string)
          : "unknown";
        return { type, estimatedTokens: estimateTextTokens(text), preview: previewOf(text) };
      });
      block.parts = parts;
      block.estimatedTokens = parts.reduce((sum, p) => sum + p.estimatedTokens, 0);
      block.preview = parts.length > 0 ? parts[0].preview : "";
    }
    blocks.push(block);
  }
  if (!toolsInserted) pushToolBlocks(); // 全 system 消息的极端情形：工具定义放末尾

  const groups = GROUP_ORDER.map(({ key, label }) => {
    const groupBlocks = blocks.filter((b) => b.groupKey === key);
    return {
      key,
      label,
      estimatedTokens: groupBlocks.reduce((sum, b) => sum + b.estimatedTokens, 0),
      blockCount: groupBlocks.length,
    };
  });
  const estimatedTotalTokens = groups.reduce((sum, g) => sum + g.estimatedTokens, 0);
  const exactInput = line.usage?.inputTokens ?? 0;
  const scale = exactInput > 0 && estimatedTotalTokens > 0 ? exactInput / estimatedTotalTokens : null;

  return { estimatedTotalTokens, scale, groups, blocks };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 会话解析与工具装配
// ---------------------------------------------------------------------------

/**
 * sessionId 缺省时解析当前会话：心跳精确优先 → 最近活跃 interactive 兜底。
 * T13：有精确心跳时无需开库（db 缺失/被锁不阻断 rollout 侧的序列与明细）；
 * 兜底查询复用 resolveInferredSession（P1-8 会话识别归一），异常按 classifyDbError 分类降级。
 */
function resolveSessionId(
  deps: RequestDetailDeps,
  input: { sessionId?: string },
): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof input.sessionId === "string" && input.sessionId.length > 0) {
    return { ok: true, id: input.sessionId };
  }
  const heartbeat = readHeartbeat(deps.heartbeatPath ?? resolveHeartbeatPath());
  if (heartbeat) {
    return { ok: true, id: heartbeat.sessionId };
  }
  const dbPath = deps.dbPath ?? resolveDbPath();
  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) return { ok: false, reason: opened.reason };
  try {
    const current = resolveInferredSession(opened.db);
    return current ? { ok: true, id: current.id } : { ok: false, reason: "no-interactive-session" };
  } catch (err) {
    return { ok: false, reason: classifyDbError(err) };
  } finally {
    opened.db.close();
  }
}

/** 请求序列行载荷（list 工具输出形状） */
function toRequestSummary(line: RolloutRecord): Record<string, unknown> {
  return {
    index: line.index,
    requestId: line.requestId,
    attempt: line.attempt,
    querySource: line.querySource,
    model: { modelId: line.model.modelId, providerId: line.model.providerId },
    startedAt: line.startedAt,
    completedAt: line.completedAt,
    durationMs: line.durationMs,
    messagesKind: line.messagesKind,
    messageOffset: line.messageOffset,
    messageCount: line.messageCount,
    toolCount: line.toolNames.length > 0 ? line.toolNames.length : line.tools.length,
    usage: line.usage,
  };
}

function countKinds(lines: RolloutRecord[]): Record<string, number> {
  const counts = { total: lines.length, full: 0, delta: 0, tail: 0 };
  for (const line of lines) {
    if (line.messagesKind === "full") counts.full++;
    else if (line.messagesKind === "delta") counts.delta++;
    else if (line.messagesKind === "tail") counts.tail++;
  }
  return counts;
}

/** 请求序列工具（Context Browser 的列表入口） */
export function createListSessionRequestsTool(deps: RequestDetailDeps = {}): ToolDefinition {
  return {
    name: "list_session_requests",
    title: "会话请求序列（rollout）",
    description:
      "列出指定会话（缺省=当前会话，心跳优先、兜底最近活跃推断）的模型请求序列，数据来自 rollout " +
      "model-io JSONL：每行含请求标识、形态（messagesKind：full=完整快照 / delta=尾部增量 / tail=中间形态）、" +
      "消息偏移与条数、精确 usage。rollout 文件不存在（被清理的旧会话）时 available=false 降级。",
    inputSchema: z.object({ sessionId: z.string().optional() }),
    visibility: ["app"],
    execute: async (args) => {
      const input = args as { sessionId?: string };
      const payload = collectRequestList(deps, input);
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    },
  };
}

function collectRequestList(deps: RequestDetailDeps, input: { sessionId?: string }): Record<string, unknown> {
  const session = resolveSessionId(deps, input);
  if (!session.ok) {
    return { available: false, reason: session.reason, session: null, requests: null };
  }
  const rolloutDir = deps.rolloutDir ?? resolveRolloutDir();
  const read = readRolloutRequests(rolloutDir, session.id);
  if (!read.ok) {
    return { available: false, reason: read.reason, session: { id: session.id }, requests: null };
  }
  return {
    available: true,
    session: { id: session.id },
    requests: read.lines.map(toRequestSummary),
    counts: countKinds(read.lines),
    parseSkipped: read.parseSkipped,
  };
}

/** 单请求组成明细工具（四分组的块级列表与三级估算；非 full 显示无快照空态） */
export function createGetRequestDetailTool(deps: RequestDetailDeps = {}): ToolDefinition {
  return {
    name: "get_request_detail",
    title: "模型请求组成明细",
    description:
      "返回单次模型请求的组成明细（四分组：system 提示/工具定义/历史消息/当前轮）：块级列表、" +
      "块/分组/合计三级 token 估算（字符特征折算，标注估算）与精确 usage（API 值，总量以此为准；" +
      "scale=精确输入/估算合计 供锚点校准）。仅 messagesKind=full 的请求有组成快照，" +
      "delta/tail 返回 snapshot=none（纯 delta 会话显示无快照空态）。",
    inputSchema: z.object({ sessionId: z.string().optional(), requestId: z.string() }),
    visibility: ["app"],
    execute: async (args) => {
      const input = args as { sessionId?: string; requestId?: string };
      const payload = collectRequestDetail(deps, input);
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    },
  };
}

function collectRequestDetail(
  deps: RequestDetailDeps,
  input: { sessionId?: string; requestId?: string },
): Record<string, unknown> {
  const session = resolveSessionId(deps, input);
  if (!session.ok) {
    return { available: false, reason: session.reason, session: null, request: null };
  }
  const notFound = (reason: string) => ({
    available: false,
    reason,
    session: { id: session.id },
    request: null,
  });

  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    return notFound("request-not-found");
  }
  const rolloutDir = deps.rolloutDir ?? resolveRolloutDir();
  const read = readRolloutRequests(rolloutDir, session.id);
  if (!read.ok) return notFound(read.reason);

  const line = read.lines.find((l) => l.requestId === input.requestId);
  if (!line) return notFound("request-not-found");

  const composition = buildComposition(line);
  return {
    available: true,
    session: { id: session.id },
    request: {
      ...toRequestSummary(line),
      requestIndexInFile: line.index,
    },
    usage: line.usage,
    snapshot: composition ? "full" : "none",
    composition,
  };
}
