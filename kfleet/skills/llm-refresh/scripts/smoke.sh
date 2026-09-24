#!/usr/bin/env bash
# smoke.sh <kfleet wrapper> <model alias or id> — one cheap turn through the REAL
# wrapper, so the alias env, provider, and CLI version are all exercised.
# Claude wrappers print: served-model  context-window; codex wrappers print ok or the API error.
set -uo pipefail
wrapper="${1:?wrapper}"
model="${2:?model}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" || exit 1
case "$wrapper" in
claude*)
  out=$(timeout 180 "$wrapper" -p --model "$model" --max-turns 1 --output-format json "Reply with exactly: ok" </dev/null 2>/dev/null | tail -n1)
  if printf '%s' "$out" | jq -e '.is_error == false' >/dev/null 2>&1; then
    printf '%s' "$out" | jq -r '"OK  served=" + (.modelUsage | to_entries | map(.key + " (ctx " + ((.value.contextWindow // "?")|tostring) + ")") | join(", "))'
  else
    printf 'FAIL %s\n' "$(printf '%s' "$out" | jq -r '.result // empty' 2>/dev/null || printf '%s' "$out" | tail -c 400)"
  fi
  ;;
codex*)
  git init -q . 2>/dev/null
  out=$(timeout 180 "$wrapper" exec --skip-git-repo-check -m "$model" "Reply with exactly: ok" </dev/null 2>&1)
  if printf '%s' "$out" | grep -q '"status":4[0-9][0-9]\|ERROR'; then printf 'FAIL %s\n' "$(printf '%s' "$out" | grep -m1 -o '"message":"[^"]*"')"; else echo "OK  model=$model"; fi
  ;;
*)
  echo "unknown wrapper kind: $wrapper" >&2
  exit 2
  ;;
esac
