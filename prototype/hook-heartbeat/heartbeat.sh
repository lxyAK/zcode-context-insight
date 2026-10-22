#!/usr/bin/env bash
# ============================================================
# PROTOTYPE: hook-heartbeat —— 一次性验证脚本，验证后删除
# 问题：UserPromptSubmit hook 触发时环境里有无 ZCODE_SESSION_ID，
#       能否写心跳文件供 MCP server 读取（ADR-0003 主方案）
# 输出：同目录 heartbeat.log（PROTOTYPE, wipe me）
# ============================================================
out="D:/.opensource/zcode-context-insight/prototype/hook-heartbeat/heartbeat.log"
{
  echo "---- $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "ZCODE_SESSION_ID=${ZCODE_SESSION_ID:-<missing>}"
  echo "CLAUDE_SESSION_ID=${CLAUDE_SESSION_ID:-<missing>}"
  echo "CLAUDE_CODE_SESSION_ID=${CLAUDE_CODE_SESSION_ID:-<missing>}"
  echo "ZCODE_PROJECT_DIR=${ZCODE_PROJECT_DIR:-<missing>}"
  echo "cwd=$(pwd)"
  echo ""
} >> "$out" 2>&1
exit 0
