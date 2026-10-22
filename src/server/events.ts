/**
 * 会话事件流与文件活动查询（T7；part 表的事件视角读取缝）。
 *
 * 数据形状对照真实宿主库实测（研究笔记 03 §5）：
 *  - 压缩事件：part.data.type='compaction'，经 usage.ts 的 fetchCompactionEvents 统一
 *    解析（P0-5 唯一解析点：pre/post/truePostCompactTokenCount、summarized/kept
 *    MessageCount、归一触发方式与 time_created+sequence 序次键）；
 *  - 模型切换：part.data.type='timeline' 且 timelineType='model_change'，
 *    目标模型优先取 toModelSelection（camelCase），缺失回退 toModel（全大写键）；
 *  - 文件活动：part.data.type='tool' 且 tool ∈ {Read,Write,Edit,Grep,Glob}，
 *    路径取 input.file_path（Read/Write/Edit）或 input.path（Grep/Glob，搜索根目录），
 *    行数变化按 \n 分割计（空串 0 行）：Edit=additions(new)/deletions(old)、Write=additions(content)。
 *
 * 排序：一律按 part.time_created 升序（sequence 作稳定次序键）——时间流视图的公共契约。
 */
import type { DatabaseSync } from "node:sqlite";
import { fetchCompactionEvents } from "./usage.ts";

/** 会话事件（判别联合：compaction | model_change） */
export type SessionEvent =
  | {
      type: "compaction";
      time: number;
      /** 触发方式：manual=用户手动 / auto=宿主自动（spec 要求压缩事件必含） */
      trigger: "manual" | "auto" | "unknown";
      preCompactTokenCount: number | null;
      postCompactTokenCount: number | null;
      truePostCompactTokenCount: number | null;
      summarizedMessageCount: number | null;
      keptMessageCount: number | null;
    }
  | {
      type: "model_change";
      time: number;
      modelId: string | null;
      providerId: string | null;
    };

/** 一条文件活动记录（路径、操作类型、行数变化） */
export interface FileActivityItem {
  time: number;
  operation: "read" | "write" | "edit" | "search";
  /** Read/Write/Edit 为目标文件绝对路径；Grep/Glob 为搜索根目录（可能缺失为 null） */
  path: string | null;
  /** Grep/Glob 的 pattern，其他操作为 null */
  detail: string | null;
  additions: number | null;
  deletions: number | null;
  status: string | null;
}

/** 行数口径：按 \n 分割计，空串为 0 行 */
function countLines(s: unknown): number | null {
  if (typeof s !== "string") return null;
  return s.length === 0 ? 0 : s.split("\n").length;
}

/**
 * 安全 JSON 解析（T13 行级容错）：json_valid 已在 SQL 侧过滤绝大多数坏行，
 * 此处兜底个别 SQLite/JS 语法差异（如前导零数字），坏行返回 null 由调用方跳过。
 */
function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 查询会话事件流：压缩 + 模型切换，按时间升序合并返回
 * @param db 只读连接
 * @param sessionId 目标会话 ID
 * @return 按时间升序合并的事件列表
 */
export function listSessionEvents(db: DatabaseSync, sessionId: string): SessionEvent[] {
  const events: SessionEvent[] = [];

  // 压缩事件（spec 指定来源：DB 的 compaction part）：复用唯一解析点
  // fetchCompactionEvents（字段口径/触发方式/序次键统一，P0-5），此处只做载荷映射
  for (const c of fetchCompactionEvents(db, sessionId)) {
    events.push({
      type: "compaction",
      time: c.time,
      trigger: c.triggerKind,
      preCompactTokenCount: c.preCompactTokenCount,
      postCompactTokenCount: c.postCompactTokenCount,
      truePostCompactTokenCount: c.truePostCompactTokenCount,
      summarizedMessageCount: c.summarizedMessageCount,
      keptMessageCount: c.keptMessageCount,
    });
  }

  // 模型切换事件（timeline part；timelineType 分布还有 goal_verification/session_fork 等，此处只取 model_change）
  const changes = db
    .prepare(
      `SELECT time_created, data FROM part
       WHERE session_id = ? AND json_valid(data) AND json_extract(data, '$.type') = 'timeline'
         AND json_extract(data, '$.timelineType') = 'model_change'
       ORDER BY time_created ASC, sequence ASC`,
    )
    .all(sessionId) as Array<{ time_created: number; data: string }>;
  for (const row of changes) {
    const d = safeParseJson(row.data);
    if (!d) continue; // 坏行跳过
    // 两种键形态：toModelSelection（camelCase，优先）与 toModel（全大写，回退）
    const sel = (d.toModelSelection ?? {}) as Record<string, unknown>;
    const to = (d.toModel ?? {}) as Record<string, unknown>;
    const modelId = typeof sel.modelId === "string" ? sel.modelId : typeof to.modelID === "string" ? to.modelID : null;
    const providerId =
      typeof sel.providerId === "string" ? sel.providerId : typeof to.providerID === "string" ? to.providerID : null;
    events.push({ type: "model_change", time: row.time_created, modelId, providerId });
  }

  // 合并后按时间升序（两路各自有序，sort 稳定保证同刻事件保持查询内相对次序）
  events.sort((a, b) => a.time - b.time);
  return events;
}

/**
 * 查询文件活动：Read/Write/Edit/Grep/Glob 工具调用记录，按时间升序返回
 * @param db 只读连接
 * @param sessionId 目标会话 ID
 * @return 按时间升序的文件活动列表
 */
export function listSessionFileActivity(db: DatabaseSync, sessionId: string): FileActivityItem[] {
  // json_valid 前置过滤（T13）：data 非法 JSON 的行跳过，不毒化整查询
  const rows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.tool') AS tool,
              json_extract(data, '$.state.status') AS status,
              json_extract(data, '$.state.input.file_path') AS file_path,
              json_extract(data, '$.state.input.path') AS dir_path,
              json_extract(data, '$.state.input.pattern') AS pattern,
              json_extract(data, '$.state.input.content') AS content,
              json_extract(data, '$.state.input.new_string') AS new_string,
              json_extract(data, '$.state.input.old_string') AS old_string
       FROM part
       WHERE session_id = ? AND json_valid(data) AND json_extract(data, '$.type') = 'tool'
         AND json_extract(data, '$.tool') IN ('Read','Write','Edit','Grep','Glob')
       ORDER BY time_created ASC, sequence ASC`,
    )
    .all(sessionId) as Array<Record<string, string | number | null>>;

  const items: FileActivityItem[] = [];
  for (const r of rows) {
    const tool = String(r.tool);
    const status = typeof r.status === "string" ? r.status : null;
    const filePath = typeof r.file_path === "string" ? r.file_path : null;
    const dirPath = typeof r.dir_path === "string" ? r.dir_path : null;
    const pattern = typeof r.pattern === "string" ? r.pattern : null;
    if (tool === "Read") {
      items.push({ time: Number(r.time_created), operation: "read", path: filePath, detail: null, additions: null, deletions: null, status });
    } else if (tool === "Write") {
      items.push({ time: Number(r.time_created), operation: "write", path: filePath, detail: null, additions: countLines(r.content), deletions: null, status });
    } else if (tool === "Edit") {
      items.push({
        time: Number(r.time_created),
        operation: "edit",
        path: filePath,
        detail: null,
        additions: countLines(r.new_string),
        deletions: countLines(r.old_string),
        status,
      });
    } else {
      // Grep / Glob：搜索记录，路径为搜索根目录、pattern 为明细，无行数变化
      items.push({ time: Number(r.time_created), operation: "search", path: dirPath, detail: pattern, additions: null, deletions: null, status });
    }
  }
  return items;
}
