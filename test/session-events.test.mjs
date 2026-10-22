/**
 * T7 功能缝基线（工单预先约定的缝：in-process 直调工具 execute）：
 *  - get_session_events：会话事件流（压缩 + 模型切换）按时间升序，压缩事件含触发方式
 *  - get_session_file_activity：文件读写/搜索记录（路径、操作类型、行数变化）
 *
 * 期望值全部为独立手算常量（对照 scripts/make-fixtures.mjs 的 T7 行集注释），
 * 夹具行按时间乱序落库——断言升序即证明排序来自查询层。
 *
 * 红线对照：所有测试读写 test/fixtures 合成夹具，绝不触碰 ~/.zcode 真实库。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionEventsTool } from "../src/server/tools/get_session_events.ts";
import { createSessionFileActivityTool } from "../src/server/tools/get_session_file_activity.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDb = join(repoRoot, "test", "fixtures", "db.sqlite");
const fixtureHeartbeat = join(repoRoot, "test", "fixtures", "heartbeat.json");

// 夹具会话 ID（与 make-fixtures.mjs 同源常量）
const S_MAIN = "session_00000000000000000000000000000001";
const S_OLD = "session_00000000000000000000000000000002";
// 夹具时间基准（make-fixtures.mjs 的 T0）
const T0 = 1792600000000;

/** S_MAIN 事件流手算期望（时间升序；行集乱序落库） */
const MAIN_EVENTS = [
  { type: "model_change", time: T0 + 15000, modelId: "GLM-5.3", providerId: "account:fixture" },
  { type: "model_change", time: T0 + 35000, modelId: "GLM-5.4", providerId: "account:fixture" },
  {
    type: "compaction", time: T0 + 55000, trigger: "auto",
    preCompactTokens: 1800, postCompactTokens: 300, truePostCompactTokens: 300,
    summarizedMessages: 2, keptMessages: 1,
  },
  {
    type: "compaction", time: T0 + 58000, trigger: "manual",
    preCompactTokens: 4000, postCompactTokens: 900, truePostCompactTokens: 500,
    summarizedMessages: 5, keptMessages: 2,
  },
];

/** S_MAIN 文件活动手算期望（时间升序；行数按 \n 分割计、空串 0 行；非搜索项 detail=null） */
const MAIN_ACTIVITIES = [
  { time: T0 + 16000, operation: "read", path: "D:\\repo\\src\\a.ts", detail: null, additions: null, deletions: null, status: "completed" },
  { time: T0 + 17000, operation: "search", path: "D:\\repo\\src", detail: "handleRequest", additions: null, deletions: null, status: "completed" },
  { time: T0 + 18000, operation: "edit", path: "D:\\repo\\src\\a.ts", detail: null, additions: 4, deletions: 3, status: "completed" },
  { time: T0 + 19000, operation: "write", path: "D:\\repo\\out\\new.ts", detail: null, additions: 5, deletions: null, status: "completed" },
  { time: T0 + 20000, operation: "search", path: "D:\\repo", detail: "*.ts", additions: null, deletions: null, status: "completed" },
  { time: T0 + 21000, operation: "edit", path: "D:\\repo\\src\\missing.ts", detail: null, additions: 1, deletions: 0, status: "error" },
];

/** 写一个临时心跳文件，返回路径（测试后由调用方清理目录） */
function writeHeartbeat(dir, obj) {
  const p = join(dir, "heartbeat.json");
  writeFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  return p;
}

async function callEventsTool(args = {}, deps = {}) {
  const tool = createSessionEventsTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

async function callFileActivityTool(args = {}, deps = {}) {
  const tool = createSessionFileActivityTool(deps);
  const result = await tool.execute(args);
  return result.structuredContent;
}

describe("get_session_events（功能缝：直调 execute）", () => {
  it("心跳会话：事件按时间升序返回，压缩含触发方式与 token 数，模型切换含目标模型", async () => {
    const payload = await callEventsTool(
      {}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("heartbeat");
    expect(payload.events).toEqual(MAIN_EVENTS);
  });

  it("事件时间严格升序且非落库顺序（乱序夹具的反证）", async () => {
    const payload = await callEventsTool(
      {}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });
    const times = payload.events.map((e) => e.time);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
    // 落库顺序是 [T0+35000, T0+15000, T0+55000(旧锚点), T0+58000]——若未排序此处必挂
    expect(times[0]).toBe(T0 + 15000);
    expect(times[times.length - 1]).toBe(T0 + 58000);
  });

  it("显式 sessionId 参数：直接按该会话查询（source=explicit）", async () => {
    const payload = await callEventsTool(
      { sessionId: S_MAIN }, { dbPath: fixtureDb, heartbeatPath: join(tmpdir(), "absent.json") });
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.session.source).toBe("explicit");
    expect(payload.events).toHaveLength(4);
  });

  it("无事件的会话：available=true 且 events 为空数组（空态数据源）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-events-"));
    try {
      const hb = writeHeartbeat(dir, { sessionId: S_OLD, time: T0 + 30000 });
      const payload = await callEventsTool(
        {}, { dbPath: fixtureDb, heartbeatPath: hb });
      expect(payload.available).toBe(true);
      expect(payload.events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-events-"));
    try {
      const payload = await callEventsTool(
        {}, { dbPath: join(dir, "no-such.sqlite"), heartbeatPath: join(dir, "absent.json") });
      expect(payload.available).toBe(false);
      expect(typeof payload.reason).toBe("string");
      expect(payload.events).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("get_session_file_activity（功能缝：直调 execute）", () => {
  it("心跳会话：按时间升序返回路径/操作/行数变化，非文件工具（Bash）被排除", async () => {
    const payload = await callFileActivityTool(
      {}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });

    expect(payload.available).toBe(true);
    expect(payload.session.id).toBe(S_MAIN);
    expect(payload.activities).toEqual(MAIN_ACTIVITIES);
    // 排除反证：夹具里的 Bash 行不出现
    const asText = JSON.stringify(payload.activities);
    expect(asText).not.toContain("npm test");
  });

  it("行数变化口径：Edit additions/deletions 为新旧串行数，Write 只计 additions，空串 0 行", async () => {
    const payload = await callFileActivityTool(
      {}, { dbPath: fixtureDb, heartbeatPath: fixtureHeartbeat });
    const byPath = Object.fromEntries(payload.activities.map((a) => [a.path + a.time, a]));
    // old 'a\nb\nc'=3 行 → new 'a\nx\nc\nd'=4 行
    expect(byPath["D:\\repo\\src\\a.ts" + (T0 + 18000)]).toMatchObject({ additions: 4, deletions: 3 });
    // content 5 行
    expect(byPath["D:\\repo\\out\\new.ts" + (T0 + 19000)]).toMatchObject({ additions: 5, deletions: null });
    // old 空串 → 0 行；error 状态也保留
    expect(byPath["D:\\repo\\src\\missing.ts" + (T0 + 21000)]).toMatchObject({ additions: 1, deletions: 0, status: "error" });
  });

  it("无记录的会话：available=true 且 activities 为空数组（空态数据源）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-files-"));
    try {
      const hb = writeHeartbeat(dir, { sessionId: S_OLD, time: T0 + 30000 });
      const payload = await callFileActivityTool(
        {}, { dbPath: fixtureDb, heartbeatPath: hb });
      expect(payload.available).toBe(true);
      expect(payload.activities).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("db 缺失：available=false 降级返回，不抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zci-files-"));
    try {
      const payload = await callFileActivityTool(
        {}, { dbPath: join(dir, "no-such.sqlite"), heartbeatPath: join(dir, "absent.json") });
      expect(payload.available).toBe(false);
      expect(payload.activities).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
