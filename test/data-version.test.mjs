/**
 * 数据版本监视器功能缝基线（T12，工单预先约定的缝与测法：
 * 临时目录夹具触发 fs.watch 断言——不触碰 ~/.zcode 真实数据源）。
 *
 * 外部行为契约：
 *  - watcher 维护单调递增 dataVersion（初始 1），任一数据源变更（防抖窗口后）版本 +1；
 *  - db 源：监听 db.sqlite 所在目录，前缀匹配主文件与 -wal/-shm（宿主 WAL 写入可感知）；
 *  - rollout 源：监听 rollout 目录，仅 *.jsonl 计入；
 *  - 无关文件变更不计入；目录缺失容错（watching 状态反映，不抛错）；
 *  - get_data_version 工具把 { dataVersion, watching } 透出给面板轮询比对。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataVersionWatcher } from "../src/server/watcher.ts";
import { createGetDataVersionTool } from "../src/server/tools/get_data_version.ts";

/** 防抖窗口（与实现默认同量级，显式注入加速测试） */
const DEBOUNCE_MS = 40;
/** 等待上界：写文件 → fs.watch 事件 → 防抖 → bump，全链路远小于 4s */
const WAIT_TIMEOUT_MS = 4000;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 轮询等待谓词成立（watch 事件是异步的，断言必须带超时轮询而非 sleep） */
async function waitFor(predicate, what) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时: ${what}`);
}

function makeWatcher(dirs) {
  return createDataVersionWatcher({
    dbPath: dirs.dbPath,
    rolloutDir: dirs.rolloutDir,
    debounceMs: DEBOUNCE_MS,
  });
}

describe("DataVersionWatcher（fs.watch 双源感知）", () => {
  it("初始版本为 1；无变更时不增长", async () => {
    const root = tempDir("zci-watch-");
    const dbDir = join(root, "db");
    const rolloutDir = join(root, "rollout");
    mkdirSync(dbDir);
    mkdirSync(rolloutDir);
    writeFileSync(join(dbDir, "db.sqlite"), "x", "utf8");
    const watcher = makeWatcher({ dbPath: join(dbDir, "db.sqlite"), rolloutDir });
    try {
      watcher.start();
      expect(watcher.getDataVersion()).toBe(1);
      // 防抖窗口数倍时间内无写入 → 版本不变
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 5));
      expect(watcher.getDataVersion()).toBe(1);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db.sqlite 写入：版本 +1（宿主写主文件路径）", async () => {
    const root = tempDir("zci-watch-");
    const dbDir = join(root, "db");
    const rolloutDir = join(root, "rollout");
    mkdirSync(dbDir);
    mkdirSync(rolloutDir);
    const dbPath = join(dbDir, "db.sqlite");
    writeFileSync(dbPath, "x", "utf8");
    const watcher = makeWatcher({ dbPath, rolloutDir });
    try {
      watcher.start();
      appendFileSync(dbPath, "more", "utf8"); // 模拟宿主 checkpoint 写主文件
      await waitFor(() => watcher.getDataVersion() >= 2, "db.sqlite 写入应触发版本 +1");
      expect(watcher.getDataVersion()).toBe(2);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db.sqlite-wal / -shm 写入同样计入（WAL 库常态写入路径）", async () => {
    const root = tempDir("zci-watch-");
    const dbDir = join(root, "db");
    const rolloutDir = join(root, "rollout");
    mkdirSync(dbDir);
    mkdirSync(rolloutDir);
    const dbPath = join(dbDir, "db.sqlite");
    writeFileSync(dbPath, "x", "utf8");
    const watcher = makeWatcher({ dbPath, rolloutDir });
    try {
      watcher.start();
      appendFileSync(join(dbDir, "db.sqlite-wal"), "w", "utf8"); // 宿主常态：写 WAL 不动主文件
      await waitFor(() => watcher.getDataVersion() >= 2, "-wal 写入应触发版本 +1");
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rollout 目录新增/追加 model-io-*.jsonl：版本 +1", async () => {
    const root = tempDir("zci-watch-");
    const dbDir = join(root, "db");
    const rolloutDir = join(root, "rollout");
    mkdirSync(dbDir);
    mkdirSync(rolloutDir);
    writeFileSync(join(dbDir, "db.sqlite"), "x", "utf8");
    const watcher = makeWatcher({ dbPath: join(dbDir, "db.sqlite"), rolloutDir });
    try {
      watcher.start();
      const jsonl = join(rolloutDir, "model-io-session_abc.jsonl");
      writeFileSync(jsonl, '{"type":"model_io"}\n', "utf8"); // 新文件（rename 事件）
      await waitFor(() => watcher.getDataVersion() >= 2, "rollout 新增 jsonl 应触发版本 +1");
      appendFileSync(jsonl, '{"type":"model_io"}\n', "utf8"); // 追加（change 事件）
      await waitFor(() => watcher.getDataVersion() >= 3, "rollout 追加 jsonl 应再触发版本 +1");
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无关文件不计入：db 目录其他文件名 / rollout 目录非 jsonl", async () => {
    const root = tempDir("zci-watch-");
    const dbDir = join(root, "db");
    const rolloutDir = join(root, "rollout");
    mkdirSync(dbDir);
    mkdirSync(rolloutDir);
    const dbPath = join(dbDir, "db.sqlite");
    writeFileSync(dbPath, "x", "utf8");
    const watcher = makeWatcher({ dbPath, rolloutDir });
    try {
      watcher.start();
      writeFileSync(join(dbDir, "unrelated.log"), "noise", "utf8");
      writeFileSync(join(rolloutDir, "notes.txt"), "noise", "utf8");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 5));
      expect(watcher.getDataVersion()).toBe(1); // 噪声不触发
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("源目录/文件缺失：start 容错不抛错，watching 状态如实反映，版本仍可读", async () => {
    const root = tempDir("zci-watch-");
    const watcher = createDataVersionWatcher({
      dbPath: join(root, "absent", "db.sqlite"),
      rolloutDir: join(root, "absent-rollout"),
      debounceMs: DEBOUNCE_MS,
    });
    try {
      expect(() => watcher.start()).not.toThrow();
      expect(watcher.getDataVersion()).toBe(1);
      const watching = watcher.getWatching();
      expect(watching.db).toBe(false);
      expect(watching.rollout).toBe(false);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("close() 后停止感知（写文件不再 bump）", async () => {
    const root = tempDir("zci-watch-");
    const dbDir = join(root, "db");
    const rolloutDir = join(root, "rollout");
    mkdirSync(dbDir);
    mkdirSync(rolloutDir);
    const dbPath = join(dbDir, "db.sqlite");
    writeFileSync(dbPath, "x", "utf8");
    const watcher = makeWatcher({ dbPath, rolloutDir });
    watcher.start();
    watcher.close();
    try {
      appendFileSync(dbPath, "after-close", "utf8");
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 5));
      expect(watcher.getDataVersion()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("get_data_version 工具（面板轮询缝）", () => {
  it("透传 watcher 的 dataVersion 与 watching 状态", async () => {
    const root = tempDir("zci-version-");
    try {
      // 夹具：已存在源目录，watching 应为 true
      const dbDir = join(root, "db");
      const rolloutDir = join(root, "rollout");
      mkdirSync(dbDir);
      mkdirSync(rolloutDir);
      const watcher = createDataVersionWatcher({
        dbPath: join(dbDir, "db.sqlite"),
        rolloutDir,
        debounceMs: DEBOUNCE_MS,
      });
      watcher.start();
      const tool = createGetDataVersionTool({ watcher });
      const payload = (await tool.execute({})).structuredContent;
      expect(payload.dataVersion).toBe(1);
      expect(payload.watching).toEqual({ db: true, rollout: true });
      watcher.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dataVersion 变更后工具返回新值（供面板比对触发刷新）", async () => {
    const root = tempDir("zci-version-");
    try {
      const dbDir = join(root, "db");
      const rolloutDir = join(root, "rollout");
      mkdirSync(dbDir);
      mkdirSync(rolloutDir);
      const dbPath = join(dbDir, "db.sqlite");
      writeFileSync(dbPath, "x", "utf8");
      const watcher = createDataVersionWatcher({ dbPath, rolloutDir, debounceMs: DEBOUNCE_MS });
      watcher.start();
      const tool = createGetDataVersionTool({ watcher });
      appendFileSync(dbPath, "more", "utf8");
      await waitFor(
        () => (watcher.getDataVersion() >= 2),
        "写文件应触发版本增长",
      );
      const payload = (await tool.execute({})).structuredContent;
      expect(payload.dataVersion).toBe(2);
      watcher.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
