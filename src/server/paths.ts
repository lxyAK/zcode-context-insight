/**
 * 运行时路径解析（可注入缝）：
 *  - 环境变量显式覆盖（ZCI_DB_PATH / ZCI_HEARTBEAT_PATH / ZCI_ROLLOUT_DIR / ZCI_HOME）优先——测试与调试注入点；
 *  - ZCODE_PLUGIN_DATA 由宿主拉起插件 MCP server 时注入（zcode.cjs 环境构造实测含此键），
 *    心跳/设置文件默认落在插件数据目录（与 hooks/heartbeat.sh 写入路径一致）；
 *  - db.sqlite 为宿主活跃库，默认位于 <home>/.zcode/cli/db/db.sqlite；
 *  - rollout model-io JSONL 默认位于 <home>/.zcode/cli/rollout/（ADR-0001：组成数据源）。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * db.sqlite 路径（env 覆盖 → 宿主默认位置）
 * @param env 环境变量（默认 process.env；测试注入）
 * @return db.sqlite 绝对路径（env 覆盖 → 宿主默认位置）
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ZCI_HOME ?? homedir();
  return env.ZCI_DB_PATH ?? join(home, ".zcode", "cli", "db", "db.sqlite");
}

/**
 * 心跳文件路径（env 覆盖 → 插件数据目录 heartbeat.json；数据目录未知时返回空串）
 * @param env 环境变量（默认 process.env；测试注入）
 * @return heartbeat.json 路径；插件数据目录未知时为空串
 */
export function resolveHeartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCI_HEARTBEAT_PATH) return env.ZCI_HEARTBEAT_PATH;
  const dataDir = env.ZCODE_PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA ?? "";
  return dataDir ? join(dataDir, "heartbeat.json") : "";
}

/**
 * 设置文件路径（T12：env 覆盖 → 插件数据目录 settings.json；数据目录未知时返回空串）
 * @param env 环境变量（默认 process.env；测试注入）
 * @return settings.json 路径；插件数据目录未知时为空串
 */
export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCI_SETTINGS_PATH) return env.ZCI_SETTINGS_PATH;
  const dataDir = env.ZCODE_PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA ?? "";
  return dataDir ? join(dataDir, "settings.json") : "";
}

/**
 * rollout 目录（env 覆盖 → 宿主默认 <home>/.zcode/cli/rollout；T12 watcher 与 T3 组成估算共用）
 * @param env 环境变量（默认 process.env；测试注入）
 * @return rollout 目录路径
 */
export function resolveRolloutDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZCI_ROLLOUT_DIR) return env.ZCI_ROLLOUT_DIR;
  return join(env.ZCI_HOME ?? homedir(), ".zcode", "cli", "rollout");
}

/**
 * 会话 rollout 文件路径（文件名直拼契约 model-io-<sessionId>.jsonl，研究笔记 03 §7）
 * @param sessionId 会话 ID
 * @param env 环境变量（默认 process.env；测试注入）
 * @return 会话 rollout 文件完整路径（model-io-<sessionId>.jsonl）
 */
export function resolveRolloutPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRolloutDir(env), `model-io-${sessionId}.jsonl`);
}
