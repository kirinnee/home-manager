---
name: llm-refresh
description: Refresh every LLM model reference in the agent fleet (kfleet wrappers, kteam routing catalog + pricing, kloge proxy image, fleet docs/skills) against the LIVE provider catalogs — Anthropic (Opus/Fable/Sonnet/Haiku), OpenAI Codex (GPT-x), z.ai GLM, MiniMax, DeepSeek, Kimi/Moonshot and any new provider. Use when a new model ships, when the user says "update the models", "refresh the LLMs", "is X configured", "new Opus/Fable/GPT/GLM is out", or right after `nix flake update` bumps Claude Code / Codex.
---

# LLM refresh

One procedure, run from the home-manager repo (`~/.config/home-manager`), that brings every
model id/alias/price/doc in the fleet up to date with what the providers actually serve today.
It is probe-driven: **never** trust training memory or old comments for model ids — run the
scripts, read the live answers, then edit.

Read [reference.md](reference.md) first if you do not already know how the multi-account
fleet resolves models (wrapper env → alias → provider). Getting that wrong silently 400s
whole accounts.

## When to Use

- A provider shipped a new model (Opus/Fable/Sonnet, GPT-x, GLM-x, MiniMax-Mx, DeepSeek, Kimi…).
- The user asks to "update/refresh the models" or whether model X is configured.
- After `nix flake update` (Claude Code / Codex bumps often gate new models).
- A wrapper starts returning `does not support this model` / `model is not supported`.

## Instructions

### Step 1: Probe what is live (facts before edits)

```bash
S=kfleet/skills/llm-refresh/scripts
$S/probe-catalogs.sh            # live catalog per provider + CLI/flake versions
$S/inventory.sh                 # every model id the repo currently configures, by file
```

Then smoke-test each candidate id **through the real wrapper** — this is the only test that
proves the alias env, the provider and the CLI version all agree:

```bash
$S/smoke.sh claude-auto-atomi 'claude-opus-5-5[1m]'   # prints served model + context window
$S/smoke.sh claude-auto-glm52a glm-5.3
$S/smoke.sh codex-auto-loai gpt-5.6-terra              # codex: ok / "not supported"
```

Decide, per provider, the new mapping for the four Claude aliases (`opus`/`fable`/`sonnet`/
`haiku`) and the Codex default. Write the decisions down (id, release date, context window,
price, CLI gate) — they go into comments and the pricing registry.

### Step 2: Version gates

If a model needs a newer CLI (`Claude Code X.Y.Z or newer is required`; Codex: "requires a newer
version of Codex" or GPT ids simply missing from the catalog), run `nix flake update` + `hms` for
Claude Code, and `codex update` for the Mac's standalone Codex (the nix `codex-cli` only serves the
Linux boxes). `probe-catalogs.sh` prints installed vs locked versions. A model that the locked CLI cannot use must NOT become a
default — say so in the report instead.

### Step 3: Edit, in this order (full file map + gotchas in reference.md)

1. `kfleet/config.yaml` — the source of truth: the `&anthropic-1m` anchor, every `loge1..6`,
   the `loge` (CLIProxyAPI, real ids) profile, `loge-codex`/`codex` `KTEAM_MODEL`, and each
   provider account's `ANTHROPIC_DEFAULT_*_MODEL`. Date-stamp the comment you touch.
2. `modules/kloge-ts/cliproxy-fork/models.overlay.json` — add any Anthropic id the pinned
   CLIProxyAPI does not know (then `kloge build && kloge up`).
3. `modules/kteam-ts` — the routing catalog **encodes** the kteam skill: `src/core.ts`
   (`MODELS`, `ACCOUNTS`, `ROUTING_DOCTRINE`, `WRAPPER_MODELS`), `src/ui.ts` `WRAPPER_MODELS`,
   `src/fleet-inventory.ts` (`/model` allowlists), `src/model-cost.ts` (APPEND a dated pricing
   row, never mutate old ones), `ui/src/pages/NewSessionPage.tsx` placeholder, plus their tests.
   This is a good piece to hand to a kteam teammate (own `modules/kteam-ts/**` only).
4. Docs that agents read: `kfleet/skills{,-codex}/kteam/SKILL.md` (model table + handoff chain),
   `kfleet/skills{,-codex}/rc-session/SKILL.md`, `kfleet/CLAUDE.md`, `kfleet/CLAUDE.auto.md`,
   `home-template.nix` (`--model` pins), `modules/kfleet-ts/README.md`, `modules/kloge-ts/README.md`.
5. Re-run `inventory.sh` and grep for the OLD ids until nothing stale remains (skills exist as
   twins under `kfleet/skills/` and `kfleet/skills-codex/` — update both).

### Step 4: Verify

```bash
cd modules/kteam-ts && direnv exec . bun test && direnv exec . npx tsc --noEmit
kloge build && kloge up && kloge status          # only if the overlay changed
hms                                              # links kfleet assets, runs `kfleet apply`, installs CLI bumps
$S/smoke.sh <wrapper> <alias-or-id>              # one per changed account/alias, AFTER hms
```

Never restart `kteamd` yourself (it runs kteam-ts from source and picks the catalog up on the
human's restart) — say it needs a restart in the report.

### Step 5: Report

Table of provider → old id → new id → verified how (smoke wrapper, date), the CLI versions,
what could NOT be enabled and why (e.g. "GLM-5.3-FlashX is not in the z.ai plan: error 1311",
"gpt-6-sol not rolled out to loio yet"), and what still needs the human (kteamd restart, `kloge up` on
the box).
