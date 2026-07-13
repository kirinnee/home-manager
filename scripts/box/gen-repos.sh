#!/usr/bin/env bash

set -eou pipefail

# Regenerate the box clone manifest — .box.repos in the DECRYPTED secrets.yaml
# — from the git repos under ~/Workspace (<group>/<repo>, two levels). The
# manifest is kept inside sops because this repo is PUBLIC and the list names
# private/work repositories. Run on your main machine, then re-encrypt:
#
#   ./scripts/box/gen-repos.sh
#   ./scripts/secrets/encrypt.sh   # (pre-commit blocks you if you forget)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEC="$ROOT/secrets.yaml"
WORKSPACE="${WORKSPACE_DIR:-$HOME/Workspace}"

if [ ! -f "$DEC" ]; then
  echo "❌ secrets.yaml missing — run ./scripts/secrets/decrypt.sh first."
  exit 1
fi

# A repo lives at <group>/<repo> or, for nested groups (e.g. work/liftoff/<repo>),
# one level deeper. A depth-2 dir that IS a repo is recorded; otherwise its
# children are scanned — never both, so repos inside repos are not picked up.
emit_repo() {
  local d="$1" url rel
  url="$(git -C "$d" remote get-url origin 2>/dev/null || true)"
  [ -n "$url" ] || return 0
  rel="${d#"$WORKSPACE/"}"
  printf '%s\t%s\n' "${rel%/}" "$url"
}

repos="$(
  for d in "$WORKSPACE"/*/*/; do
    if [ -d "$d/.git" ]; then
      emit_repo "$d"
    else
      for sub in "$d"*/; do
        [ -d "$sub/.git" ] && emit_repo "$sub"
      done
    fi
  done | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {path: .[0], url: .[1]})'
)"

count="$(jq 'length' <<<"$repos")"
if [ "$count" -eq 0 ]; then
  echo "❌ No git repos with an origin found under $WORKSPACE/*/* — refusing to write an empty manifest."
  exit 1
fi

REPOS_JSON="$repos" yq -i '.box.repos = env(REPOS_JSON)' "$DEC"

echo "📝 Wrote $count repos to .box.repos in secrets.yaml:"
jq -r '.[] | "   \(.path) <- \(.url)"' <<<"$repos"
echo ""
echo "🔐 Now run: ./scripts/secrets/encrypt.sh  (and commit secrets.enc.yaml)"
