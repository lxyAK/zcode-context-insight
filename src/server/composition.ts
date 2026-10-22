/**
 * 组成估算（ADR-0002 口径，T3；P0-4 起为全部组成估算的单一底座——
 * get_current_session_composition / get_current_session_report /
 * get_request_detail 共用）：
 *  - 启发式分组折算：按内容字符特征估算 token（ASCII≈4 字符/token、CJK≈1 字符/token 的
 *    量级折算），分到固定四分组（GLOSSARY：system 提示 / 工具定义 / 历史消息 / 当前轮）；
 *  - system 双计去重（T6 实测结论）：body.system 与头部 role=system 消息逐字重复，
 *    分组只按 messages 计一次，body.system 仅在无 system 消息时兜底；
 *  - 锚点校准：以最近 full 请求的 API 精确 usage.inputTokens 为锚点做比例归一化，
 *    各组 floor(raw×scale) 后按最大余数法补齐差值（余数并列按组序稳定分配），
 *    保证 Σcalibrated === 锚点精确值——偏差归一化方式（比例 + 最大余数）在工具返回中原样透出；
 *  - 一切数字均为估算口径，展示层必须标注"估算"，不得冒充精确值（与精确用量并存）。
 */

/** 四分组固定顺序（GLOSSARY 第 15 条；校准并列时的稳定分配序） */
export interface CompositionGroups {
  system: number;
  tools: number;
  history: number;
  currentTurn: number;
}

export const GROUP_ORDER: Array<keyof CompositionGroups> = ["system", "tools", "history", "currentTurn"];

import type { RolloutMessage, RolloutRecord } from "./rollout.ts";

/**
 * 字符级启发式折算：ceil(ASCII 字符数 / 4) + CJK 字符数 × 1。
 * 只是量级估计（最终以锚点归一化收束）；CJK 权重取 1 字符/token 偏保守。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // CJK 统一表意文字与 CJK 标点/假名区段
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) || (code >= 0xff00 && code <= 0xffef)) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.ceil(ascii / 4) + cjk;
}

/** 提取单条消息参与折算的文本：content 字符串 / 分块 text / toolCalls 序列化 */
function messageTexts(message: RolloutMessage): string[] {
  const texts: string[] = [];
  const content = message.content;
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") texts.push(block);
      else if (typeof block === "object" && block !== null) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  if (message.toolCalls !== undefined) {
    try {
      texts.push(JSON.stringify(message.toolCalls));
    } catch {
      /* 循环引用等极端形状：跳过，估算不因单条消息失败 */
    }
  }
  return texts;
}

/** 工具定义折算：逐个 JSON 序列化后按字符折算（schema 结构天然进字符数） */
function estimateToolsTokens(tools: unknown[]): number {
  let total = 0;
  for (const tool of tools) {
    try {
      total += estimateTextTokens(JSON.stringify(tool));
    } catch {
      /* 序列化失败的单个定义跳过 */
    }
  }
  return total;
}

/**
 * 对 full 快照做四分组原始折算：
 *  - system：messages 中 role=system 的消息（含压缩摘要类注入）。body.system 与头部
 *    system 消息逐字重复（T6 实测结论，P0-4 统一）：分组只按 messages 计一次，
 *    body.system 仅在 messages 无 system 消息时兜底；
 *  - tools：body.tools 序列化折算；
 *  - 当前轮：最后一条 user 消息及其后的非 system 消息（当轮进行中的内容）；
 *  - 历史消息：此前全部非 system 消息。无 user 消息时全部归历史。
 */
export function estimateRawComposition(record: RolloutRecord): CompositionGroups {
  const groups: CompositionGroups = { system: 0, tools: 0, history: 0, currentTurn: 0 };

  // system 双计去重：messages 有 system 消息时 body.system 不再重复计入
  const hasSystemMessage = record.messages.some((m) => m.role === "system");
  if (!hasSystemMessage) {
    for (const block of record.systemBlocks) groups.system += estimateTextTokens(block);
  }
  groups.tools += estimateToolsTokens(record.tools);

  let lastUserIdx = -1;
  for (let i = 0; i < record.messages.length; i++) {
    if (record.messages[i].role === "user") lastUserIdx = i;
  }

  for (let i = 0; i < record.messages.length; i++) {
    const message = record.messages[i];
    if (message.role === "system") {
      for (const text of messageTexts(message)) groups.system += estimateTextTokens(text);
    } else if (lastUserIdx >= 0 && i >= lastUserIdx) {
      for (const text of messageTexts(message)) groups.currentTurn += estimateTextTokens(text);
    } else {
      for (const text of messageTexts(message)) groups.history += estimateTextTokens(text);
    }
  }
  return groups;
}

export interface CalibrationResult {
  calibrated: CompositionGroups;
  /** 比例归一化因子 = 锚点精确 inputTokens / Σraw（返回中原样透出，供展示层说明归一方式） */
  scaleFactor: number;
}

/**
 * 锚点校准（最大余数法）：calibrated[k] = floor(raw[k] × scale)，
 * 差值按小数部分从大到小逐个 +1 补齐（并列按 GROUP_ORDER 组序），保证总和恰等于锚点。
 * 调用方保证 anchorInputTokens > 0 且 rawTotal > 0。
 */
export function calibrateToAnchor(raw: CompositionGroups, anchorInputTokens: number): CalibrationResult {
  const scaleFactor = anchorInputTokens / GROUP_ORDER.reduce((sum, k) => sum + raw[k], 0);

  const exact = GROUP_ORDER.map((k) => raw[k] * scaleFactor);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = anchorInputTokens - floors.reduce((a, b) => a + b, 0);

  // 小数部分降序、并列按组序升序（稳定）
  const order = exact
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .map((e) => e.i);

  const calibrated = { system: floors[0], tools: floors[1], history: floors[2], currentTurn: floors[3] };
  let cursor = 0;
  while (remainder > 0) {
    const key = GROUP_ORDER[order[cursor % order.length]];
    calibrated[key] += 1;
    remainder -= 1;
    cursor += 1;
  }
  return { calibrated, scaleFactor };
}
