#!/usr/bin/env bash
# codex-db-maint.sh — checkpoint the shared kfleet codex sqlite WALs.
#
# Why: every fleet codex account (~/.kfleet/shared/codex/sqlite/) writes to the
# same sqlite databases. Concurrent sessions grow the WAL without a clean
# checkpoint until a cold start has to chew through hundreds of MB of WAL just
# to open — codex's connection pool times out and it reports the DB as
# "damaged" (2026-08-24: logs_2.sqlite 4.7G + 742M WAL → "pool timed out").
# A nightly TRUNCATE checkpoint keeps the WAL small. Checkpointing is
# concurrency-safe: readers/writers keep working; busy just means try again.
#
# sqlite3 CLI is not in the nix profile; bun:sqlite is always available.
set -euo pipefail

SQLITE_DIR="$HOME/.kfleet/shared/codex/sqlite"
BUN="${BUN:-$HOME/.nix-profile/bin/bun}"

if [ ! -d "$SQLITE_DIR" ]; then
  echo "no $SQLITE_DIR — nothing to maintain"
  exit 0
fi
if [ ! -x "$BUN" ]; then
  echo "bun not found at $BUN" >&2
  exit 1
fi

exec "$BUN" run - "$SQLITE_DIR" <<'EOF'
import { Database } from "bun:sqlite";
const dir = process.argv[2];
let checked = 0;
for (const name of ["logs_2", "state_5", "goals_1", "memories_1"]) {
  const path = `${dir}/${name}.sqlite`;
  const file = Bun.file(path);
  if (!(await file.exists())) continue;
  checked++;
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout=30000;");
  const before = (db.query("PRAGMA wal;").get() as any)?.wal;
  const r = db.query("PRAGMA wal_checkpoint(TRUNCATE);").get() as any;
  console.log(
    `${name}: wal=${before} -> busy=${r?.busy} log_frames=${r?.log} checkpointed=${r?.checkpointed}`,
  );
  db.close();
}
console.log(`maintained ${checked} db(s)`);
EOF
