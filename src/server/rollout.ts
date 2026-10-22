/**
 * rollout model-io JSONL 解析底座（T3 组成估算；T6 Context Browser / T10 Fleet 复用缝）。
 *
 * 结构契约（研究笔记 03 §7，逐行对照实测）：
 *  - 每行一个 JSON 对象 = 一次完整模型请求-响应记录；
 *  - request.messagesKind 三态：full（messageOffset=0 携带完整上下文快照，组成估算唯一锚点）/
 *    delta（只携带尾部增量）/ tail（prefix 缓存命中的中间形态）——非 full 一律不锚定（ADR-0002）；
 *  - messageOffset 语义：该请求携带的 messages 对应会话消息流的 [messageOffset, messageCount) 区间；
 *  - response.usage 为 API 精确用量（camelCase）。
 *
 * 容错（ADR-0001 schema 漂移红线）：坏行跳过、字段缺失落默认值，绝不因单行/单字段抛错。
 * 只读红线：本模块只 readFileSync，绝不写入。
 */
import { readFileSync } from "node:fs";

/** response.usage 形状（camelCase，与 rollout 原文一致；缺字段落 0） */
export interface RolloutUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** request.messages 单条（content 保持原样：string 或分块数组；估算层负责折算） */
export interface RolloutMessage {
  role: string;
  content: unknown;
  toolCalls?: unknown;
}

/** 解析后的记录（index 为文件内 0 基行号，仅统计成功解析的行） */
export interface RolloutRecord {
  index: number;
  sessionId: string | null;
  requestId: string | null;
  startedAt: string | null;
  querySource: string | null;
  messagesKind: string | null;
  messageOffset: number | null;
  messageCount: number | null;
  messages: RolloutMessage[];
  /** request.body.system 各文本块的 text 内容 */
  systemBlocks: string[];
  /** request.body.tools 原样（估算层做 JSON 序列化折算） */
  tools: unknown[];
  usage: RolloutUsage | null;
}

/** 读取结果：失败携带机器可读原因（工具层据此降级，不抛错） */
export type RolloutReadResult =
  | { ok: true; records: RolloutRecord[] }
  | { ok: false; reason: "rollout-not-found" | "rollout-read-failed" | "rollout-empty" };

/** 已知 messagesKind 取值（tail 为实测补充，ADR-0002 未记录——见研究笔记 03 §7） */
export const KNOWN_KINDS = ["full", "delta", "tail"] as const;

/** 按已知 kind 分类计数；未知 kind 与缺省归 other */
export function countByKind(records: RolloutRecord[]): {
  total: number;
  full: number;
  delta: number;
  tail: number;
  other: number;
} {
  const counts = { total: records.length, full: 0, delta: 0, tail: 0, other: 0 };
  for (const r of records) {
    if (r.messagesKind === "full") counts.full++;
    else if (r.messagesKind === "delta") counts.delta++;
    else if (r.messagesKind === "tail") counts.tail++;
    else counts.other++;
  }
  return counts;
}

/**
 * 组成估算锚点：最后一个 messagesKind=full 且带非零精确用量的记录。
 * delta/tail/未知 kind 一律不锚定（ADR-0002：非 full 不估算）。
 */
export function pickFullAnchor(records: RolloutRecord[]): RolloutRecord | null {
  let anchor: RolloutRecord | null = null;
  for (const r of records) {
    if (r.messagesKind === "full" && (r.usage?.inputTokens ?? 0) > 0) anchor = r;
  }
  return anchor;
}

/** 最后一条带用量的记录的精确 input（纯 delta 会话的"只显示精确总量"来源） */
export function pickLatestInputTokens(records: RolloutRecord[]): number | null {
  let value: number | null = null;
  for (const r of records) {
    if (typeof r.usage?.inputTokens === "number") value = r.usage.inputTokens;
  }
  return value;
}

/** 单行容错解析：任何形状不符返回 null（由调用方跳过该行） */
function parseLine(line: string): Omit<RolloutRecord, "index"> | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  const request = (o.request ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const response = (o.response ?? {}) as Record<string, unknown>;
  const usageRaw = response.usage as Record<string, unknown> | undefined;

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

  // body.system：字符串或 {type:'text', text} 块数组，两种形态都取文本
  const systemBlocks: string[] = [];
  if (typeof body.system === "string") {
    systemBlocks.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (typeof block === "string") systemBlocks.push(block);
      else if (typeof block === "object" && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") systemBlocks.push(text);
      }
    }
  }

  const messages: RolloutMessage[] = Array.isArray(request.messages)
    ? request.messages
        .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
        .map((m) => {
          const msg: RolloutMessage = {
            role: typeof m.role === "string" ? m.role : "",
            content: m.content ?? "",
          };
          if ("toolCalls" in m) msg.toolCalls = m.toolCalls;
          return msg;
        })
    : [];

  const usage: RolloutUsage | null = usageRaw
    ? {
        inputTokens: num(usageRaw.inputTokens) ?? 0,
        outputTokens: num(usageRaw.outputTokens) ?? 0,
        totalTokens: num(usageRaw.totalTokens) ?? 0,
        cacheReadTokens: num(usageRaw.cacheReadTokens) ?? 0,
        cacheWriteTokens: num(usageRaw.cacheWriteTokens) ?? 0,
      }
    : null;

  return {
    sessionId: str(o.sessionId),
    requestId: str(o.requestId),
    startedAt: str(o.startedAt),
    querySource: str(o.querySource),
    messagesKind: str(request.messagesKind),
    messageOffset: num(request.messageOffset),
    messageCount: num(request.messageCount),
    messages,
    systemBlocks,
    tools: Array.isArray(body.tools) ? body.tools : [],
    usage,
  };
}

/** 读取并逐行解析 rollout 文件（只读；坏行跳过，零可解析行按 rollout-empty 降级） */
export function readRolloutFile(path: string): RolloutReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "rollout-not-found" };
    }
    return { ok: false, reason: "rollout-read-failed" };
  }
  const records: RolloutRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseLine(trimmed);
    if (parsed) records.push({ ...parsed, index: records.length });
  }
  if (records.length === 0) return { ok: false, reason: "rollout-empty" };
  return { ok: true, records };
}
