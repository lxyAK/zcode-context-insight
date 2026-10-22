#!/usr/bin/env bash
# 心跳脚本（T2，当前会话识别主方案，ADR-0003）：
# UserPromptSubmit hook 在用户每次提交时把当前会话 ID 写入插件数据目录的 heartbeat.json，
# MCP server 读取即知当前会话（宿主不向 server 暴露会话 ID，plugin.json env 引用会加载期报错）。
#
# 环境变量由宿主注入（研究笔记 01 §5.2，原型 prototype/hook-heartbeat 已验证）：
#   ZCODE_SESSION_ID / CLAUDE_SESSION_ID / CLAUDE_CODE_SESSION_ID —— 三别名一致，任取其一
#   ZCODE_PLUGIN_DATA —— 插件数据目录（C:\Users\<u>\.zcode\cli\plugins\data\<name>@<marketplace>\）
#
# 约定：不向 stdout 输出任何内容（宿主按严格 schema 解析 hook stdout，空输出合法），恒定退出 0；
# 缺任一要素时静默跳过（server 侧走"最近活跃 interactive 会话"推断兜底，不视为错误）。
set -u

session_id="${ZCODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}}"
data_dir="${ZCODE_PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}"

[ -n "$session_id" ] && [ -n "$data_dir" ] || exit 0

mkdir -p "$data_dir"
now_ms="$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )))"

# 临时文件 + mv 原子替换，避免 server 读到半截 JSON
tmp="$(mktemp "$data_dir/heartbeat.json.tmp.XXXXXX")" || exit 0
printf '{"sessionId":"%s","time":%s}\n' "$session_id" "$now_ms" > "$tmp"
mv -f "$tmp" "$data_dir/heartbeat.json"

exit 0
