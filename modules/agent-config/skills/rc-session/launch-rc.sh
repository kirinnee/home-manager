#!/usr/bin/env bash
# launch-rc.sh — start a detached Claude Code remote-control session inside zellij.
#
# zellij needs a PTY and cannot be started directly from a non-interactive tool
# call. We bootstrap it inside a detached tmux session (which provides the PTY),
# wait for the zellij session to come up, then kill the tmux boot client. The
# zellij server keeps the session running independently, so it survives the
# Claude session that launched it and can be attached to later with
# `zellij attach <slug>`.
#
# Usage: launch-rc.sh <work_dir> <zellij_slug> <display_name> <yolo_bin>
#   work_dir      directory to start the session in (repo root or worktree)
#   zellij_slug   zellij session name — no spaces (also used for tmux boot name)
#   display_name  value passed to `--name` (may contain spaces)
#   yolo_bin      yolo-kirin | yolo-liftoff | yolo-atomi
set -euo pipefail

WORK_DIR="${1:?work_dir required}"
SLUG="${2:?zellij_slug required}"
DISPLAY_NAME="${3:?display_name required}"
YOLO_BIN="${4:?yolo_bin required}"

command -v zellij >/dev/null || {
  echo "ERROR: zellij not found on PATH" >&2
  exit 1
}
command -v tmux >/dev/null || {
  echo "ERROR: tmux not found on PATH" >&2
  exit 1
}

# Resolve the yolo wrapper to an absolute path so it works regardless of the
# PATH zellij/tmux inherit.
YOLO_PATH="$(command -v "$YOLO_BIN" || true)"
[ -n "$YOLO_PATH" ] || {
  echo "ERROR: '$YOLO_BIN' not found on PATH" >&2
  exit 1
}
[ -d "$WORK_DIR" ] || {
  echo "ERROR: work_dir '$WORK_DIR' does not exist" >&2
  exit 1
}

# `zellij list-sessions --short` prints one bare session name per line (no ANSI
# codes), so an exact line match is reliable.
session_exists() { zellij list-sessions --short 2>/dev/null | grep -qxF "$SLUG"; }

# Refuse to clobber an existing session.
if session_exists; then
  echo "ERROR: a zellij session named '$SLUG' already exists." >&2
  echo "       Attach with: zellij attach \"$SLUG\"  (or pick a different name)" >&2
  exit 2
fi

# Tiny launcher script — generated with printf %q so values with spaces or
# special characters (e.g. an apostrophe in a ticket title) are quoted safely
# and never injected into the zellij KDL layout.
LAUNCHER="$(mktemp "${TMPDIR:-/tmp}/rc-run-XXXXXX.sh")"
printf '#!/usr/bin/env bash\ncd %q || exit 1\nexec %q --rc --name %q --chrome\n' \
  "$WORK_DIR" "$YOLO_PATH" "$DISPLAY_NAME" >"$LAUNCHER"
chmod +x "$LAUNCHER"

LAYOUT="$(mktemp "${TMPDIR:-/tmp}/rc-layout-XXXXXX.kdl")"
cat >"$LAYOUT" <<EOF
layout {
    pane command="$LAUNCHER"
}
EOF

BOOT="rcboot-$SLUG"
tmux kill-session -t "$BOOT" 2>/dev/null || true
# tmux supplies the PTY; zellij creates the session inside it.
tmux new-session -d -s "$BOOT" "zellij --session '$SLUG' --new-session-with-layout '$LAYOUT'"

ok=false
for _ in $(seq 1 30); do
  if session_exists; then
    ok=true
    break
  fi
  sleep 0.5
done

# Detach: killing the boot tmux client leaves the zellij session running.
tmux kill-session -t "$BOOT" 2>/dev/null || true
rm -f "$LAYOUT"
# The launcher has already been exec'd into by the time the session is up; clean
# it up best-effort (a small delay so a slow start still finds it).
(
  sleep 5
  rm -f "$LAUNCHER"
) >/dev/null 2>&1 &

if [ "$ok" = true ]; then
  echo "OK: remote-control session is running."
  echo "  display name : $DISPLAY_NAME"
  echo "  directory    : $WORK_DIR"
  echo "  zellij session: $SLUG"
  echo "  attach with  : zellij attach \"$SLUG\""
else
  echo "ERROR: zellij session '$SLUG' did not come up in time." >&2
  echo "       Check: zellij list-sessions" >&2
  rm -f "$LAUNCHER"
  exit 3
fi
