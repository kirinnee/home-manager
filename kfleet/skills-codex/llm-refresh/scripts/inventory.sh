#!/usr/bin/env bash
# Every model id / alias mapping the repo currently CONFIGURES, grouped by file.
# Compare against probe-catalogs.sh output; anything here that is not live (or
# is superseded) is a stale reference to fix. Run from the home-manager repo root.
set -uo pipefail
PAT='claude-(opus|fable|sonnet|haiku|mythos)-[0-9][0-9a-z.-]*(\[1m\])?|gpt-[0-9][0-9a-z.-]*|glm-[0-9][0-9a-z.-]*|MiniMax-[A-Za-z0-9.-]+|deepseek-[a-z0-9.-]+|kimi-[a-z0-9.-]+|moonshot-[a-z0-9.-]+|ANTHROPIC_DEFAULT_[A-Z]+_MODEL: *[^ #]+|KTEAM_MODEL: *[^ #]+'
FILES=(
  kfleet/config.yaml
  kfleet/templates
  kfleet/CLAUDE.md kfleet/CLAUDE.auto.md
  kfleet/skills/kteam/SKILL.md kfleet/skills-codex/kteam/SKILL.md
  kfleet/skills/rc-session/SKILL.md kfleet/skills-codex/rc-session/SKILL.md
  home-template.nix
  modules/kloge-ts/cliproxy-fork/models.overlay.json modules/kloge-ts/cliproxy-fork/build.sh modules/kloge-ts/README.md
  modules/kfleet-ts/README.md
  modules/kteam-ts/src/core.ts modules/kteam-ts/src/ui.ts modules/kteam-ts/src/fleet-inventory.ts
  modules/kteam-ts/src/model-cost.ts modules/kteam-ts/src/daemon-config.ts
  modules/kteam-ts/ui/src/pages/NewSessionPage.tsx
)
echo "# configured model ids (distinct, with counts)"
rg -o --no-filename -e "$PAT" "${FILES[@]}" 2>/dev/null | sort | uniq -c | sort -rn
echo
echo "# by file"
rg -n -o -e "$PAT" "${FILES[@]}" 2>/dev/null
echo
echo "# human-readable model names in docs/catalog (Opus 5, Fable 5.1, GLM-5.3, ...)"
rg -n -o -e '\b(Opus|Fable|Sonnet|Haiku|GPT|GLM|MiniMax|DeepSeek|Kimi)[ -][0-9][0-9a-zA-Z.-]*' "${FILES[@]}" modules/kteam-ts/src/core.ts 2>/dev/null | sort -u -t: -k3 | sort -u
