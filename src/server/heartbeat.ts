/**
 * 心跳文件读取（ADR-0003 主方案）：
 * hooks/heartbeat.sh 在用户每次提交时原子写入 { sessionId, time }（Unix 毫秒）。
 * 任何读取异常（缺文件/半截 JSON/缺字段）都返回 null，由调用方走"最近活跃推断"兜底。
 */
import { readFileSync } from "node:fs";

/** 心跳文件形状（与 hooks/heartbeat.sh 写入格式一一对应） */
export interface Heartbeat {
  sessionId: string;
  time: number;
}

/** 读取并校验心跳文件；不可用（缺失/损坏/形状不符）时返回 null，绝不抛错 */
export function readHeartbeat(path: string): Heartbeat | null {
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // 缺文件或不可读（hook 尚未触发过）
  }
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; time?: unknown };
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return null;
    if (typeof parsed.time !== "number" || !Number.isFinite(parsed.time)) return null;
    return { sessionId: parsed.sessionId, time: parsed.time };
  } catch {
    return null; // 半截 JSON（极小概率读到写入中的文件）等
  }
}
