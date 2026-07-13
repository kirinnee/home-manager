#!/usr/bin/env bash

set -eou pipefail

# Install the nightly backup job on the box: expects the runner already at
# ~/.local/bin/box-backup (scp'd by replicate.sh). Creates a systemd USER
# service+timer (nightly at 03:00 box time, Persistent so a powered-off window
# still triggers on boot) and enables lingering so the user manager runs
# without an active login. Idempotent. Runs ON the box.

RUNNER="$HOME/.local/bin/box-backup"
UNIT_DIR="$HOME/.config/systemd/user"

if [ ! -x "$RUNNER" ]; then
  echo "❌ $RUNNER missing — run scripts/box/replicate.sh (it installs the runner)."
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat >"$UNIT_DIR/box-backup.service" <<EOF
[Unit]
Description=Restic backup of ~/Workspace to R2

[Service]
Type=oneshot
ExecStart=$RUNNER
EOF

cat >"$UNIT_DIR/box-backup.timer" <<EOF
[Unit]
Description=Nightly restic backup (keep 7 days)

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
EOF

sudo loginctl enable-linger "$USER"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user daemon-reload
systemctl --user enable --now box-backup.timer

echo "✅ box-backup.timer installed:"
systemctl --user list-timers box-backup.timer --no-pager | head -3
