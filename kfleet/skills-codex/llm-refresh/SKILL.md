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

Then finish the deploy yourself — do not hand these back to the human:

1. **Commit** your paths only: check `git diff --cached --name-only` for someone else's staged
   files, then `git commit --only <your paths>` (retry once if treefmt reflows a file).
2. **`hms`** via the askpass pattern in `kfleet/CLAUDE.md` (background job; full
   `darwin-rebuild` path). Required after any `kfleet/` change.
3. **Restart `kteamd`** if `modules/kteam-ts` changed (it runs from source, so the new catalog
   only goes live on restart). Sessions live in tmux and are re-adopted, so this is safe:
   save `kteam ps`, run `kteam daemon restart`, confirm every session is back with the same
   status (`daemon.readopted` in `~/.kteam/<id>/events.jsonl`), `kteam resume` any that are not.
4. Smoke the changed aliases again through the real wrappers (above).

Do not push unless the human asked.

### Common problems (check these before you call a model broken)

| Symptom                                                                                     | What is really going on / fix                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.sh` → `OAuth session expired and could not be refreshed` / `Failed to authenticate`  | The test ACCOUNT's login died (atomi, 2026-10-08), not the model. Re-test on `claude-auto-loge1` or `claude-auto-liftoff`; tell the human to re-login the dead one. Never smoke on `claude-auto-kirin` / `codex-auto-personal`.                                                  |
| New model is live but `--model sonnet` / `haiku` still serves the old one                   | Claude Code's built-in alias defaults lag the API (2.1.281 still mapped `sonnet`→Sonnet 5, `haiku`→Haiku 4.5). Set `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` explicitly in the `&anthropic-1m` anchor AND each `loge1..6` (they do not use the anchor). Smoke the bare alias to confirm. |
| Same id serves a different context window than last time                                    | Native window varies per model: Sonnet 5 was 1M bare, Sonnet 5.5 is 200k bare and 1M only with `[1m]`. Smoke the id both with and without `[1m]` and read `ctx`.                                                                                                                 |
| Pricing page has two rows for one model (e.g. Haiku 5.5 ≤100k vs >100k prompts)             | Tiered pricing; the kteam registry is flat. Record the base tier with a comment, and do not give that model `[1m]` unless the 5× long-prompt price is intended.                                                                                                                  |
| Unsure what to put in `models.overlay.json` (`max_completion_tokens`, thinking levels)      | Never guess or copy a sibling. `probe-catalogs.sh` prints `in=`/`out=`; for effort/thinking: `curl …/v1/models` and `jq '.data[] \| {id, capabilities}'`.                                                                                                                        |
| Pricing columns look swapped                                                                | Anthropic's docs table order is: input, 5m cache write, 1h cache write, **cache read**, output. Cache read is the 4th column, not the 2nd.                                                                                                                                       |
| Provider lists a model but calls fail (z.ai error 1311)                                     | Listed ≠ in your plan. Smoke-test; report it instead of configuring it.                                                                                                                                                                                                          |
| Codex id missing, or `gpt-6-sol` says "not supported"                                       | Catalog is filtered by Codex client version and rolled out per account. `codex update` (Mac standalone), then trust only caches whose `fetched_at` is from today — old caches on idle accounts look like missing models.                                                         |
| Wrappers still use old models after editing `config.yaml`                                   | You ran `kfleet apply` without `hms`. Assets are nix-store copies; only `hms` re-links them.                                                                                                                                                                                     |
| `/model` in the loge lane does not show the new id                                          | Needs overlay entry + `models.keep.json` + `kloge build && kloge up` (container restart re-advertises). `build.sh` fails loudly if an overlay entry does not land.                                                                                                               |
| Old model names survive in docs after the id grep is clean                                  | Docs use display names. Also grep `Sonnet 5\b`, `Haiku 4\.5` etc. — e.g. `skills-codex/kautopilot` names its visual-renderer model in prose. Skills exist as twins; fix both.                                                                                                    |
| `date -j …` fails while computing `created` epochs                                          | Inside `direnv exec` you get GNU coreutils: use `date -u -d 2026-09-28T00:00:00Z +%s`.                                                                                                                                                                                           |
| `sed -i` edits come out mangled                                                             | The rtk shell wrapper rewrites `sed -i`; use `perl -pi -e` or the Edit tool.                                                                                                                                                                                                     |
| `hms` → `sudo: a terminal is required` / `darwin-rebuild: command not found` under sudo     | Use the askpass pattern (`kfleet/CLAUDE.md`) and the full path `/nix/var/nix/profiles/system/sw/bin/darwin-rebuild`.                                                                                                                                                             |
| `kteam task create` → `no session id`                                                       | Only works inside a kteam session (or with `--session <id>`); a plain terminal session cannot record a task — say so in the report.                                                                                                                                              |
| `bun test` in kteam-ts shows failures                                                       | Some fail on a clean HEAD for environment reasons (2026-10-08: 10 Codex runtime-model-control tests in `session-manager-control.test.ts`). Compare against the pre-change commit in a temp worktree before blaming the refresh.                                                  |
| First commit fails: `unexpected changes detected, --fail-on-change`                         | treefmt reflowed markdown tables / JSON. Just run the same `git commit --only …` again.                                                                                                                                                                                          |
| `kteam daemon restart` / `install` → `Bootstrap failed: 5: Input/output error`, kteamd down | launchd race (bootout returns before teardown). Fixed in e79f306 with a retry; on an older build run `kteam daemon start`. Sessions survive either way.                                                                                                                          |

### Step 5: Report

Table of provider → old id → new id → verified how (smoke wrapper, date), the CLI versions,
what could NOT be enabled and why (e.g. "GLM-5.3-FlashX is not in the z.ai plan: error 1311",
"gpt-6-sol not rolled out to account X yet"), and what still needs the human (e.g. `kloge push` to the box, an expired account login, or a push).
