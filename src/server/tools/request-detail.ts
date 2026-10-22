/**
 * 请求明细工具（T6，app+model 双可见）：Context Browser 与 DNA 扁平视图的数据面。
 *
 *  - list_session_requests：列出会话的模型请求序列（来自 rollout model-io JSONL，
 *    每行=一次完整请求记录），返回形态（messagesKind full/delta/tail）与精确 usage；
 *  - get_request_detail：单次请求的组成明细——四分组（GLOSSARY：system 提示 / 工具定义 /
 *    历史消息 / 当前轮）下的块级列表、块/分组/合计三级 token 估算与精确总量校准系数。
 *
 * 口径（ADR-0002 / 研究笔记 03 §7）：
 *  - 组成估算只锚定 messagesKind=full 的请求快照；delta/tail（非 full）一律 snapshot=none
 *    不做估算——纯 delta 会话的请求显示"无快照"空态；
 *  - 估算为字符特征折算（ASCII 约 4 字符/token、CJK 约 1.5 字符/token），必须标注"估算"；
 *    精确总量始终用 response.usage 的 API 值，两者并存不冒充（scale=精确输入/估算合计，
 *    供锚点校准展示）；
 *  - 实测头部 system 消息与 request.body.system 逐字重复：分组只按 messages 数组计一次，
 *    body.system 仅在 messages 无 system 消息时兜底；工具定义取 request.body.tools。
 *
 * 依赖注入缝：deps 允许显式指定 db / 心跳 / rollout 目录（测试与调试），
 * 缺 sessionId 时默认解析当前会话（心跳优先，兜底最近活跃 interactive，ADR-0003）。
 * rollout 缺文件/坏行容错（ADR-0001：文件被清理属预期，降级不抛错）。
 *
 * 边界：本文件自带最小 rollout 解析（单请求明细用途）；T3 的会话级组成估算若合入
 * 共享解析底座（src/server/rollout/），由 merge 阶段统一整合，避免两套并存。
 */
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../registry.ts";
import { resolveDbPath, resolveHeartbeatPath, resolveRolloutDir } from "../paths.ts";
import { openReadonlyDatabase } from "../db.ts";
import { resolveCurrentSession } from "../usage.ts";

/** 工具依赖（测试注入缝；缺省从环境与宿主默认路径解析） */
export interface RequestDetailDeps {
  dbPath?: string;
  heartbeatPath?: string;
  rolloutDir?: string;
}

// ---------------------------------------------------------------------------
// 字符特征估算（ADR-0002）
// ---------------------------------------------------------------------------

/** 预览截断上限（明细只回结构化摘要，不外漏全文正文） */
const PREVIEW_MAX_CHARS = 120;

/** CJK 码位（统一表意/扩展/兼容/假名与 CJK 标点/全角形式）：按约 1.5 字符/token 折算 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** 字符特征 token 估算：ceil(ASCII/4) + ceil(CJK×2/3) + 其余字符数（展示必须标注"估算"） */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) ascii++;
    else if (isCjkCodePoint(code)) cjk++;
    else other++;
  }
  return Math.ceil(ascii / 4) + Math.ceil((cjk * 2) / 3) + other;
}

/** 预览文本：压缩空白后截断，避免面板载荷外漏全文 */
function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// rollout model-io JSONL 解析（容错：坏行跳过计数，字段漂移降级为 null）
// ---------------------------------------------------------------------------

/** messages 数组元素（content 为字符串或 [{type,text}] 分块数组，实测 03 笔记 §7） */
interface RolloutMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
  toolName?: string;
  toolCallId?: string;
}

/** 单行请求记录（解析后的最小形状） */
interface RolloutRequestLine {
  index: number;
  requestId: string;
  attempt: number | null;
  querySource: string | null;
  modelId: string | null;
  providerId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  messagesKind: string;
  messageOffset: number | null;
  messageCount: number | null;
  messages: RolloutMessage[];
  tools: Array<Record<string, unknown>>;
  bodySystemTexts: string[];
  toolNames: string[];
  usage: Record<string, number> | null;
}

interface RolloutReadResult {
  ok: true;
  lines: RolloutRequestLine[];
  parseSkipped: number;
}

/** 读取并解析 model-io-<sessionId>.jsonl；文件缺失或目录缺失 → rollout-not-found */
function readRolloutRequests(rolloutDir: string, sessionId: string): RolloutReadResult | { ok: false; reason: string } {
  const file = join(rolloutDir, `model-io-${sessionId}.jsonl`);
  if (!existsSync(file)) return { ok: false, reason: "rollout-not-found" };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "rollout-not-found" };
  }

  const lines: RolloutRequestLine[] = [];
  let parseSkipped = 0;
  let index = 0;
  for (const rawLine of raw.split("\n")) {
    if (!rawLine.trim()) continue; // 尾空行
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      parseSkipped++; // 坏行容错：跳过并计数
      continue;
    }
    const line = parseRolloutLine(parsed, index);
    if (line) {
      lines.push(line);
      index++;
    } else {
      parseSkipped++;
    }
  }
  return { ok: true, lines, parseSkipped };
}

/** 逐字段容错解析一行（缺字段/类型漂移降级为 null，不含 requestId 的行整行丢弃） */
function parseRolloutLine(parsed: unknown, index: number): RolloutRequestLine | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const requestId = typeof root.requestId === "string" ? root.requestId : null;
  if (!requestId) return null;

  const request = asRecord(root.request);
  const body = asRecord(request?.body);
  const response = asRecord(root.response);
  const model = asRecord(root.model);

  return {
    index,
    requestId,
    attempt: typeof root.attempt === "number" ? root.attempt : null,
    querySource: typeof root.querySource === "string" ? root.querySource : null,
    modelId: typeof model?.modelId === "string" ? model.modelId : null,
    providerId: typeof model?.providerId === "string" ? model.providerId : null,
    startedAt: typeof root.startedAt === "string" ? root.startedAt : null,
    completedAt: typeof root.completedAt === "string" ? root.completedAt : null,
    durationMs: typeof root.durationMs === "number" ? root.durationMs : null,
    messagesKind: typeof request?.messagesKind === "string" ? request.messagesKind : "",
    messageOffset: typeof request?.messageOffset === "number" ? request.messageOffset : null,
    messageCount: typeof request?.messageCount === "number" ? request.messageCount : null,
    messages: normalizeMessages(request?.messages),
    tools: Array.isArray(body?.tools) ? (body.tools.filter(asRecord) as Array<Record<string, unknown>>) : [],
    bodySystemTexts: Array.isArray(body?.system)
      ? body.system
          .map((b) => asRecord(b))
          .filter((b): b is Record<string, unknown> => b !== null)
          .map((b) => (typeof b.text === "string" ? b.text : ""))
      : [],
    toolNames: Array.isArray(request?.toolNames)
      ? request.toolNames.filter((t): t is string => typeof t === "string")
      : [],
    usage: normalizeUsage(asRecord(response?.usage)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeMessages(value: unknown): RolloutMessage[] {
  if (!Array.isArray(value)) return [];
  const out: RolloutMessage[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec || typeof rec.role !== "string") continue;
    const content: RolloutMessage["content"] =
      typeof rec.content === "string"
        ? rec.content
        : Array.isArray(rec.content)
          ? rec.content
              .map((p) => asRecord(p))
              .filter((p): p is Record<string, unknown> => p !== null)
              .map((p) => ({
                type: typeof p.type === "string" ? p.type : "unknown",
                text: typeof p.text === "string" ? p.text : "",
              }))
          : "";
    out.push({
      role: rec.role,
      content,
      toolName: typeof rec.toolName === "string" ? rec.toolName : undefined,
      toolCallId: typeof rec.toolCallId === "string" ? rec.toolCallId : undefined,
    });
  }
  return out;
}

function normalizeUsage(usage: Record<string, unknown> | null): Record<string, number> | null {
  if (!usage) return null;
  const out: Record<string, number> = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    const v = usage[key];
    if (typeof v === "number") out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// 组成明细构建（四分组 + 块级扁平序）
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
 * 顺序规则：messages 数组顺序即请求内顺序；工具定义插在首条非 system 消息之前
 * （对应 API 报文 system → tools → messages 的逻辑顺序）；尾部 system 提醒保留其实际位置。
 */
function buildComposition(line: RolloutRequestLine): Composition | null {
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
  if (!hasSystemMessage && line.bodySystemTexts.length > 0) {
    for (const text of line.bodySystemTexts) {
      blocks.push({
        seq: seq++,
        groupKey: "system",
        kind: "message",
        role: "system",
        estimatedTokens: estimateTokens(text),
        preview: previewOf(text),
      });
    }
  }

  const pushToolBlocks = () => {
    for (const def of line.tools) {
      const json = safeStringify(def);
      const name = typeof def.name === "string" ? def.name : "(unnamed)";
      const description = typeof def.description === "string" ? def.description : "";
      blocks.push({
        seq: seq++,
        groupKey: "tools",
        kind: "tool",
        name,
        estimatedTokens: estimateTokens(json),
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
    const groupKey: GroupKey =
      m.role === "system" ? "system" : i === lastUserIndex ? "current" : "history";

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

    if (typeof m.content === "string") {
      block.estimatedTokens = estimateTokens(m.content);
      block.preview = previewOf(m.content);
    } else if (Array.isArray(m.content)) {
      const parts = m.content.map((p) => {
        const text = p.text ?? "";
        return { type: p.type ?? "unknown", estimatedTokens: estimateTokens(text), preview: previewOf(text) };
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

/** sessionId 缺省时解析当前会话（心跳优先 → 最近活跃 interactive 兜底） */
function resolveSessionId(
  deps: RequestDetailDeps,
  input: { sessionId?: string },
): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof input.sessionId === "string" && input.sessionId.length > 0) {
    return { ok: true, id: input.sessionId };
  }
  const dbPath = deps.dbPath ?? resolveDbPath();
  const heartbeatPath = deps.heartbeatPath ?? resolveHeartbeatPath();
  const opened = openReadonlyDatabase(dbPath);
  if (!opened.ok) return { ok: false, reason: opened.reason };
  try {
    const current = resolveCurrentSession(opened.db, heartbeatPath);
    return current ? { ok: true, id: current.id } : { ok: false, reason: "no-interactive-session" };
  } catch {
    return { ok: false, reason: "session-resolve-failed" };
  } finally {
    opened.db.close();
  }
}

/** 请求序列行载荷（list 工具输出形状） */
function toRequestSummary(line: RolloutRequestLine): Record<string, unknown> {
  return {
    index: line.index,
    requestId: line.requestId,
    attempt: line.attempt,
    querySource: line.querySource,
    model: { modelId: line.modelId, providerId: line.providerId },
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

function countKinds(lines: RolloutRequestLine[]): Record<string, number> {
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
    visibility: ["model", "app"],
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
    visibility: ["model", "app"],
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
