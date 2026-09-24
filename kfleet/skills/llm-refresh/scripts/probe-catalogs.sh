#!/usr/bin/env bash
# Print the LIVE model catalog of every provider the fleet uses, plus the CLI
# versions that gate them. Read-only except for one trivial Codex exec (the only
# way to refresh codex's models_cache.json). Needs: curl, jq, ~/.secrets.
set -uo pipefail
# shellcheck source=/dev/null
[[ -f ~/.secrets ]] && source ~/.secrets
# shellcheck source=/dev/null
[[ -f ~/.secrets.local ]] && source ~/.secrets.local
CODEX_WRAPPER="${CODEX_WRAPPER:-codex-auto-loai}" # never the personal daily driver
say() { printf '\n== %s ==\n' "$*"; }

say "CLI versions (installed)"
claude --version 2>/dev/null || echo "claude: not on PATH"
codex --version 2>/dev/null || echo "codex: not on PATH"
if [[ -f flake.lock ]]; then
  say "CLI versions (flake.lock)"
  for input in claude-code codex-cli; do
    rev=$(jq -r ".nodes[\"$input\"].locked.rev // empty" flake.lock)
    owner=$(jq -r ".nodes[\"$input\"].locked.owner // empty" flake.lock)
    repo=$(jq -r ".nodes[\"$input\"].locked.repo // empty" flake.lock)
    [[ -z $rev ]] && continue
    attr=$([[ $input == claude-code ]] && echo claude-code || echo default)
    sys=$(nix eval --raw --impure --expr builtins.currentSystem 2>/dev/null)
    printf '%s: ' "$input"
    nix eval --raw "github:$owner/$repo/$rev#packages.$sys.$attr.version" 2>/dev/null || echo "(eval failed)"
    echo
  done
fi

say "Anthropic (OAuth /v1/models — needs a CLAUDE_CODE_OAUTH_TOKEN-style token)"
tok="${ANTHROPIC_PROBE_TOKEN:-${LOGE_CLAUDE_1_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}}"
if [[ -n $tok ]]; then
  curl -s -m 20 'https://api.anthropic.com/v1/models?limit=100' \
    -H "Authorization: Bearer $tok" -H 'anthropic-beta: oauth-2025-04-20' -H 'anthropic-version: 2023-06-01' |
    jq -r 'if .data then (.data[] | [.id, .display_name, (.max_input_tokens|tostring), .created_at] | @tsv) else . end'
else
  echo "no token (set ANTHROPIC_PROBE_TOKEN or LOGE_CLAUDE_1_TOKEN in ~/.secrets)"
fi

say "Anthropic pricing (docs, current models)"
curl -s -m 20 -L https://docs.anthropic.com/en/docs/about-claude/pricing.md |
  grep -E '^\| Claude (Fable|Opus|Sonnet|Haiku|Mythos)' | sed 's/  */ /g; s/<sup>[0-9]*<\/sup>//g' | head -20

say "OpenAI Codex (ChatGPT catalog; refreshes ~/.${CODEX_WRAPPER}/models_cache.json via one trivial exec)"
if command -v "$CODEX_WRAPPER" >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  (cd "$tmp" && timeout 120 "$CODEX_WRAPPER" exec --skip-git-repo-check "Reply with exactly: ok" >/dev/null 2>&1)
  rm -rf "$tmp"
  cache="$HOME/.${CODEX_WRAPPER}/models_cache.json"
  [[ -f $cache ]] && jq -r '.fetched_at as $f | .models[] | [$f, .slug, (.visibility//""), (.priority|tostring), (.display_name//"")] | @tsv' "$cache"
else
  echo "wrapper $CODEX_WRAPPER not found (set CODEX_WRAPPER)"
fi
echo "codex caches on this machine:"
for h in "$HOME"/.codex-*; do
  f="$h/models_cache.json"
  [[ -f $f ]] && printf '  %s %s :: %s\n' "$(basename "$h")" "$(jq -r .fetched_at "$f")" "$(jq -r '[.models[].slug]|join(",")' "$f")"
done

say "z.ai GLM (coding plan)"
[[ -n ${ZAI_API_KEY_A:-} ]] && curl -s -m 20 https://api.z.ai/api/anthropic/v1/models -H "x-api-key: $ZAI_API_KEY_A" -H 'anthropic-version: 2023-06-01' | jq -r '.data[] | [.id, .created_at] | @tsv' || echo "no ZAI_API_KEY_A"

say "MiniMax"
[[ -n ${MINIMAX_API_KEY:-} ]] && curl -s -m 20 https://api.minimax.io/anthropic/v1/models -H "x-api-key: $MINIMAX_API_KEY" -H 'anthropic-version: 2023-06-01' | jq -r '.data[] | [.id, .created_at] | @tsv' || echo "no MINIMAX_API_KEY"

say "DeepSeek"
[[ -n ${DEEPSEEK_API_KEY:-} ]] && curl -s -m 20 https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_API_KEY" | jq -r '.data[].id' || echo "no DEEPSEEK_API_KEY"

say "Kimi / Moonshot"
kimi="${MOONSHOT_API_KEY:-${KIMI_API_KEY:-}}"
[[ -n $kimi ]] && curl -s -m 20 https://api.moonshot.ai/v1/models -H "Authorization: Bearer $kimi" | jq -r '.data[].id' || echo "no MOONSHOT_API_KEY/KIMI_API_KEY (skip unless a kimi account exists in kfleet/config.yaml)"

say "kloge (local CLIProxyAPI for the loge pool)"
command -v kloge >/dev/null 2>&1 && timeout 30 kloge status 2>&1 | tail -6 || echo "kloge not installed"
[[ -f modules/kloge-ts/cliproxy-fork/models.overlay.json ]] && {
  echo "overlay ids:"
  jq -r '.[][].id' modules/kloge-ts/cliproxy-fork/models.overlay.json
}

say "Other provider profiles in kfleet/config.yaml (add a probe above for any new base URL)"
[[ -f kfleet/config.yaml ]] && grep -n 'ANTHROPIC_BASE_URL\|base_url' kfleet/config.yaml
