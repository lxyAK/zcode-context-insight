/**
 * db.sqlite 只读连接层（ADR-0001 红线：绝不写入）。
 *
 * 只读保证：node:sqlite 以 `mode=ro` URI 打开——连接层任何代码路径的写操作都会被
 * SQLite 以 "attempt to write a readonly database" 拒绝（测试有专项断言）。
 * WAL 库在宿主活跃写入下可能偶发 SQLITE_BUSY：连接上设置 busy_timeout 短等待。
 * 后续工单（T3-T9）的一切 db 访问都经由此层获取连接。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 打开结果：失败时携带机器可读原因（工具层据此降级，不抛错） */
export type DbOpenResult =
  | { ok: true; db: DatabaseSync }
  | { ok: false; reason: string };

const BUSY_TIMEOUT_MS = 2000;

/**
 * 以只读 URI 打开 db.sqlite；文件缺失或打开失败返回 { ok:false }。
 * 注意：返回的连接仍由调用方负责 close（server 侧当前按查询开关，见 usage.ts）。
 */
export function openReadonlyDatabase(dbPath: string): DbOpenResult {
  if (!dbPath || !existsSync(dbPath)) {
    return { ok: false, reason: "db-not-found" };
  }
  try {
    // pathToFileURL 生成 file:///D:/... 形式，追加 mode=ro 查询参数（只读红线）
    const db = new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro`, {
      open: true,
    });
    // 只读连接允许设置 busy_timeout（连接级 PRAGMA，不写库文件）；失败不致命
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    } catch {
      /* 旧版本宿主库拒绝该 PRAGMA 时忽略，BUSY 由查询层 catch 降级 */
    }
    return { ok: true, db };
  } catch (err) {
    return { ok: false, reason: `db-open-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
