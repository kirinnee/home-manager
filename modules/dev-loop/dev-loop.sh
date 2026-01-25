#!/usr/bin/env bash
set -euo pipefail

# Dev Loop - main entry point
# Dispatches to subcommands: init, run, status, cancel, logs

case "${1:-}" in
init)
  shift
  exec dev-loop-init "$@"
  ;;
run)
  shift
  exec dev-loop-run "$@"
  ;;
status)
  exec dev-loop-status
  ;;
cancel)
  exec dev-loop-cancel
  ;;
logs | log)
  shift
  exec dev-loop-logs "$@"
  ;;
-h | --help | "")
  echo "dev-loop - Spec-driven development with multi-reviewer consensus"
  echo ""
  echo "Usage: dev-loop <command>"
  echo ""
  echo "Commands:"
  echo "  init      Initialize a new dev-loop"
  echo "  run       Run the orchestration loop"
  echo "  status    Show current loop status"
  echo "  logs      View execution logs (interactive)"
  echo "  cancel    Cancel the current loop"
  ;;
*)
  echo "Unknown command: $1" >&2
  exit 1
  ;;
esac
