/**
 * 运行时路径解析（可注入缝）：
 *  - 环境变量显式覆盖（ZCI_DB_PATH / ZCI_HEARTBEAT_PATH / ZCI_HOME）优先——测试与调试注入点；
 *  - ZCODE_PLUGIN_DATA 由宿主拉起插件 MCP server 时注入（zcode.cjs 环境构造实测含此键），
 *    心跳文件默认落在插件数据目录（与 hooks/heartbeat.sh 写入路径一致）；
 *  - db.sqlite 为宿主活跃库，默认位于 <home>/.zcode/cli/db/db.sqlite。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** db.sqlite 路径（env 覆盖 → 宿主默认位置） */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ZCI_HOME ?? homedir();
  return env.ZCI_DB_PATH ?? join(home, ".zcode", "cli", "db", "db.sqlite");
}

/** 心跳文件路径（env 覆盖 → 插件数据目录 heartbeat.json；数据目录未知时返回空串） */
export function resolveHeartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCI_HEARTBEAT_PATH) return env.ZCI_HEARTBEAT_PATH;
  const dataDir = env.ZCODE_PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA ?? "";
  return dataDir ? join(dataDir, "heartbeat.json") : "";
}

/** rollout 目录（env 覆盖 → 宿主默认 <home>/.zcode/cli/rollout） */
export function resolveRolloutDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCI_ROLLOUT_DIR) return env.ZCI_ROLLOUT_DIR;
  return join(env.ZCI_HOME ?? homedir(), ".zcode", "cli", "rollout");
}

/** 会话 rollout 文件路径（文件名直拼契约 model-io-<sessionId>.jsonl，研究笔记 03 §7） */
export function resolveRolloutPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRolloutDir(env), `model-io-${sessionId}.jsonl`);
}
