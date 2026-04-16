#!/usr/bin/env bash
# rtk-hook-version: 1
# Gemini CLI variant of the RTK rewrite hook.
#
# Gemini hook protocol differs from Claude/Codex:
#   - Tool name for shell: run_shell_command (not Bash)
#   - Decision schema: top-level {"decision": "allow"|"deny"|"block"}
#   - Rewrite via: hookSpecificOutput.tool_input (shallow-merged over model args)
#
# Delegates all rewrite/permission logic to `rtk rewrite`, same as the Claude
# hook. Translates the output to Gemini's schema.
#
# Exit code protocol from `rtk rewrite`:
#   0 + stdout  Rewrite found
#   1           No RTK equivalent → pass through
#   2           Deny rule matched → pass through (let Gemini's own rules decide)
#   3 + stdout  Ask rule matched → rewrite (Gemini has no "ask"; treat as allow)

if ! command -v jq &>/dev/null; then
  echo "[rtk] WARNING: jq is not installed. Hook cannot rewrite commands." >&2
  exit 0
fi

if ! command -v rtk &>/dev/null; then
  echo "[rtk] WARNING: rtk is not installed or not in PATH." >&2
  exit 0
fi

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only act on shell commands; for everything else pass through.
if [ "$TOOL" != "run_shell_command" ] || [ -z "$CMD" ]; then
  echo '{"decision":"allow"}'
  exit 0
fi

REWRITTEN=$(rtk rewrite "$CMD" 2>/dev/null)
EXIT_CODE=$?

case $EXIT_CODE in
0 | 3)
  if [ "$CMD" = "$REWRITTEN" ]; then
    echo '{"decision":"allow"}'
  else
    jq -nc --arg c "$REWRITTEN" \
      '{decision:"allow", hookSpecificOutput:{tool_input:{command:$c}}}'
  fi
  ;;
*)
  echo '{"decision":"allow"}'
  ;;
esac
exit 0
