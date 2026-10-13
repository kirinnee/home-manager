---
name: kloge-refresh
description: Refresh the loge credential pool on every machine — read the loge-credentials Secret in the LLM cluster (key names only), decide how many loge slots exist, make the fleet match (add/remove claude-auto-logeN accounts if the count changed), then pull + push the pool to the Mac, pebox and kirin-box and prove every loge account answers. Use when the user says "update kloge", "refresh loge", "sync the loge tokens", "push loge to the boxes", when a loge account says "Not logged in"/401 after a token rotation, or when slots were added/removed in the cluster.
---

# kloge refresh

Run from the home-manager repo (`~/.config/home-manager`). The loge pool lives ONLY in the
Kubernetes Secret `loge/loge-credentials` on `eks-llm-us-east-1`. Only the Mac can read it (the LLM
cluster authorizes the DevOps role; the boxes have no cluster access), so the pool travels
Mac → boxes. Never print secret VALUES — key names and counts only.

How the pieces fit:

- `CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_<N>` → `kloge pull` → `~/.kloge/auth/claude-<N>.json` (gateway
  `claude-auto-loge`, CLIProxyAPI) AND `LOGE_CLAUDE_<N>_TOKEN` in `~/.secrets` (direct
  `claude-auto-loge<N>` wrappers: `CLAUDE_CODE_OAUTH_TOKEN="$LOGE_CLAUDE_<N>_TOKEN"`).
- `CODEX_OAUTH_TOKEN_PE_LLM_<N>` → `~/.kloge/auth/codex-<N>.json` (gateway only; there are no
  direct codex-loge wrappers any more).
- `kloge-deploy <host>…` = `kloge pull` → local `kloge up` → per host: `kloge build`, `kloge push`,
  `docker compose up -d`, `hms` (re-projects `~/.secrets`), verify.

## Step 1: Preflight

```bash
AWS_PROFILE=vungle2-DevOpsRole aws sts get-caller-identity --query Arn --output text
```

`ExpiredToken` → stop and ask the human to run `gimme-aws-creds` (Okta, interactive). Both the
cluster read AND reaching pebox (SSM) need it. Do not try to log in for them.

## Step 2: Read the slot count from the cluster

```bash
loctl ops kubectl --context eks-llm-us-east-1 -n loge get secret loge-credentials -o json \
  | jq -r '.data | keys[]' | sort -V
```

Count `CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_<N>` (→ direct loge accounts) and
`CODEX_OAUTH_TOKEN_PE_LLM_<N>` (gateway only). Compare with the fleet:

```bash
rg -n '^  - name: loge[0-9]+$' kfleet/config.yaml        # direct loge accounts configured
rg -n 'DIRECT_LOGE_AGENT_RE|DIRECT_CLAUDE_SECRET_RE' modules/kloge-ts/src/tokens.ts
```

Also check the slot numbers are contiguous from 1; a gap (e.g. 1,2,4) changes the mapping —
report it rather than guessing.

## Step 3: Make the fleet match (ONLY if the count changed)

Same count → skip to Step 4.

Different count → this is a code change across ~20 files. The worked example is #7
(`git show aa9280a`, "remove loge4-6"): kfleet `config.yaml` agents + credential keys, kloge `tokens.ts`
(its regexes accept any N today — only touch it if that changed; + tests), kteam-ts `core.ts` / `fleet-inventory.ts` /
`model-availability.ts` (+ tests), kfleet-ts `usage.ts` / `cli/fleet.ts` (+ tests), docs
(`kfleet/CLAUDE*.md`, `kfleet/skills{,-codex}/kteam`, `kloge-ts/README.md`, `home-template.nix`
comments). Mirror it for the new N. Run each touched module's `bun test` + `tsc --noEmit`.
Work on a branch in a fresh worktree and open a PR (repo rule); hand the merge to the human.
For removed slots, after the merge also delete the dead homes on every machine:
`~/.claude-auto-loge<N>` and `~/.claude-loge<N>` (transcripts are symlinks into
`~/.kfleet/shared/claude`, so `rm -rf` only drops the links) and, on the Mac, the Keychain item
`Claude Code-credentials-<first 8 hex of sha256(home path)>`.

## Step 4: Pull + push to all machines

1. Make sure nothing is mid-flight on the Mac gateway (`kloge-deploy` restarts it):
   `kteam ps | rg 'claude-auto-loge '` — wait or warn if something is running there.
2. Deploy (pulls the pool, refreshes the Mac container, builds + pushes + hms on each box):

   ```bash
   AWS_PROFILE=vungle2-DevOpsRole kloge-deploy box pebox
   ```

   It must end with `✓ box`, `✓ pebox` and `~/.secrets: <N> loge token(s) | sops: 0` per host.
   The boxes must already be on current `main` (their `kloge build` uses the box's checkout):
   if not, fast-forward them first (box: `git checkout --detach origin/main`; pebox:
   `git merge --ff-only origin/main`) — never rsync/replicate.

3. Refresh the Mac's own `~/.secrets`: `hms` via the askpass pattern in `kfleet/CLAUDE.md`
   (full path `/nix/var/nix/profiles/system/sw/bin/darwin-rebuild`, background job).

## Step 5: Verify every account on every machine

Bare `ssh host '<cmd>'` does NOT load `~/.secrets`, so direct loge wrappers say "Not logged in"
even when the token is there. Load it first:

```bash
for h in box pebox; do
  AWS_PROFILE=vungle2-DevOpsRole ssh "$h" 'export PATH=~/.nix-profile/bin:$PATH; set -a; . ~/.secrets >/dev/null 2>&1; set +a
    for a in claude-auto-loge claude-auto-loge1 claude-auto-loge2 claude-auto-loge3; do   # adjust to N
      printf "%s: " $a; timeout 100 $a -p "Reply with only your exact model id." --model sonnet 2>&1 | tail -1
    done'
done
```

On the Mac use `kfleet/skills/llm-refresh/scripts/smoke.sh <wrapper> sonnet`.
`unrecognized_model` on `claude-auto-loge` = that machine's gateway image is stale → re-run
`kloge-deploy <host>`. `docker ps` on the host shows the container age.

## Report

Table: machine × account (gateway + loge1..N) → OK/served model or the error; the cluster slot
count; whether the fleet changed (PR link) or matched; anything left for the human (expired AWS
login, a PR to merge).
