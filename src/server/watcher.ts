/**
 * 数据版本监视器（T12 自动刷新的 server 侧感知层）：
 * fs.watch 监听双数据源，维护单调递增 dataVersion 供面板轮询比对
 * （MCP Apps 面板协议无服务端推送，自动刷新 = get_data_version 轻量轮询 + 版本比对）。
 *
 * 感知口径：
 *  - db 源：监听 db.sqlite 所在目录，前缀匹配主文件名（连带 -wal/-shm）——
 *    宿主为 WAL 库，常态写入落在 -wal 文件，只盯主文件会漏感知；
 *  - rollout 源：监听 rollout 目录，仅 *.jsonl 计入（新增/追加都是数据变更）；
 *  - 两源严格只读：本模块只 watch，绝不打开/写入被监听文件（ADR-0001 红线）。
 *
 * 容错：目录缺失/watch 建立失败/error 事件一律降级为 watching=false，不抛错；
 * 防抖：首个变更事件后 debounceMs 毫秒合并 bump（窗口内连发事件只 +1，bump 延迟有上界）。
 */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

/** 监视器选项 */
export interface WatcherOptions {
  /** db.sqlite 路径（只读数据源；空串表示禁用该源） */
  dbPath: string;
  /** rollout 目录路径（只读数据源；空串表示禁用该源） */
  rolloutDir: string;
  /** 变更防抖窗口毫秒（默认 200） */
  debounceMs?: number;
}

/** 监视器公共面（get_data_version 工具与测试的消费缝） */
export interface DataVersionWatcher {
  /** 开始监听（幂等；源不可用只置 watching=false，不抛错） */
  start(): void;
  /** 停止监听并清理定时器（幂等） */
  close(): void;
  /** 当前数据版本（初始 1，每次感知到变更 +1，单调递增） */
  getDataVersion(): number;
  /** 各源 watch 是否建立成功 */
  getWatching(): { db: boolean; rollout: boolean };
}

/** 默认防抖窗口：覆盖宿主单次写库的 WAL+主文件多点落盘，同时保证面板秒级感知 */
const DEFAULT_DEBOUNCE_MS = 200;

export function createDataVersionWatcher(opts: WatcherOptions): DataVersionWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let version = 1;
  let started = false;
  let closed = false;
  let bumpTimer: NodeJS.Timeout | null = null;
  const watchers: FSWatcher[] = [];
  const watching: { db: boolean; rollout: boolean } = { db: false, rollout: false };

  /** 防抖 bump：首个事件起 debounceMs 后版本 +1；窗口内后续事件不重复计时 */
  function scheduleBump(): void {
    if (bumpTimer !== null) return;
    bumpTimer = setTimeout(() => {
      bumpTimer = null;
      version += 1;
    }, debounceMs);
    bumpTimer.unref?.();
  }

  /** 监听目录并以文件名过滤；建立失败/运行期 error 降级为 watching[key]=false */
  function watchDirectory(
    key: "db" | "rollout",
    dir: string,
    include: (filename: string) => boolean,
  ): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // filename 为 null 的事件（平台差异）无法过滤，保守忽略
        if (typeof filename === "string" && include(filename)) scheduleBump();
      });
    } catch {
      watching[key] = false; // 目录缺失等：不炸 server，面板退化为手动刷新
      return;
    }
    watching[key] = true;
    watchers.push(watcher);
    watcher.on("error", () => {
      watching[key] = false;
      watcher.close();
    });
  }

  return {
    start(): void {
      if (started || closed) return;
      started = true;
      // db 源：watch 所在目录，前缀匹配主文件名（覆盖 -wal/-shm；空路径禁用）
      if (opts.dbPath) {
        const name = basename(opts.dbPath);
        watchDirectory("db", dirname(opts.dbPath), (filename) => filename.startsWith(name));
      }
      // rollout 源：watch 目录，仅 *.jsonl 计入
      if (opts.rolloutDir) {
        watchDirectory("rollout", opts.rolloutDir, (filename) => filename.endsWith(".jsonl"));
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const w of watchers) w.close();
      watchers.length = 0;
      if (bumpTimer !== null) {
        clearTimeout(bumpTimer);
        bumpTimer = null;
      }
      watching.db = false;
      watching.rollout = false;
    },
    getDataVersion(): number {
      return version;
    },
    getWatching(): { db: boolean; rollout: boolean } {
      return { ...watching };
    },
  };
}
