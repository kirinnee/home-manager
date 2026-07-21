# Deferred-Writer Reviewers as kteam teammates (Phase B / v2)

Status: **DESIGN — not implemented.** Phase A (the harness migration to kteamd,
`specs/deferred-writer-relay.md` Rev 4) has landed and is tested + smoke-verified.
This doc specifies the v2 unlock the migration makes possible: running the writer's
reviewer fan-out as **short-lived kteam sessions on different accounts** instead of
as subagents inside the writer's own session.

This was deferred out of Phase A on purpose: it changes the config schema, the
turn engine's message assembly, and the writer contract, and needs its own unit
tests + manual soak before it can safely drive real work. Phase A must soak first
(it ships `writer.reviewers: []` → today's in-session behavior, zero change).

## Why (the v1→v2 motivation)

v1 (spec §Non-goals) ran reviewers as **subagents inside the writer session** —
same account, a different *model* via `writer.reviewerModel`. That means:
- All reviewer tokens burn on the **writer's** account (the whole point of
  deferred mode was to move load OFF a single account).
- No cross-family review: the kteam skill doctrine wants a *different family*
  (e.g. a Codex terra wrapper) reviewing a Claude-written artifact, to catch
  what same-family self-review misses.

v2 runs reviewers as their **own kteam sessions on their own wrappers**, so review
load spreads across the fleet and can be cross-family. The binary — never the
writer — orchestrates them (consistent with "the binary owns everything except
editing the handed-out files").

## Config

`writerConfigSchema` (in `src/core/types.ts`) gains:

```ts
reviewers: z.array(z.string()).default([]),
// e.g. ["codex-auto-terra"] — one cross-family wrapper is the recommended default.
```

- Empty (the default) ⇒ **v1 behavior unchanged**: the writer runs the reviewer
  fan-out as its own subagents (existing `reviewBlock` in `composeMessage`). This
  keeps the rollout safe and the migration a no-op for existing configs.
- Non-empty ⇒ the binary runs external reviewer sessions (below) and the writer
  prompt is told NOT to run its own reviewers.
- `DEFAULT_CONFIG.writer.reviewers = []`; `serializeConfigWithComments` emits the
  key with a comment pointing here. `reviewerModel` stays (it still models the
  in-session subagent path when `reviewers` is empty).

Validation like kloop's `validateAgentsOrThrow`: reject a configured reviewer
wrapper that isn't installed in `~/.kfleet/bin` (skip the check when that dir is
absent — dev/test).

## Which turns fan out

Only steps whose `prepare()` yields a `review` payload (today: `write_spec`,
`write_plans`) and only on a **revising** turn (the writer produced/updated the
artifact this turn). A pure Q&A or approval turn never triggers reviewers.

The relay already knows a turn revised the artifact only *after* the envelope
comes back (`envelope.artifact.revised`). So the review round is a **post-turn
step**, inserted between "envelope validated" and "accept":

```
writer turn N (revising) → reply.json validated (artifact + visual on disk)
  → IF config.writer.reviewers non-empty AND the step has a review payload
     AND envelope.artifact.revised:
       run external reviewer sessions on the just-produced version
       collect reports
       IF any reviewer is unsatisfied:
         compose a corrective message (the reports) and `kteam send` it to the
         writer as turn N's continuation — NOT a new turn (same version, the
         writer fixes in place), then re-wait on reply.json and re-review
       loop until clean or `writer.maxReviewRounds` (new config, default 2)
  → accept + enrich + markPresented
```

This keeps the envelope's `reviews: {clean, rounds, unresolved}` meaningful: the
binary fills it from the external round outcome (it currently trusts the writer
to self-report). Cross-check: if the writer claimed `reviews.clean:true` but an
external reviewer rejected, the binary's result wins.

## Reviewer session mechanics (binary-owned)

A new `src/core/writer/reviewers.ts`, using the same `WriterKteam`/`KteamExec`
seam so it is unit-testable with a fake:

```ts
runReviewRound(params: {
  sessionId; phaseKey; turn; kind; version; repo;
  artifactPath;            // absolute path to the vN.md (or plan dir) to review
  reviewers: string[];     // config.writer.reviewers
  reviewPayload;           // the prepared review reviewers[] + synthesize spec
  scratchDir;              // scratch/<phaseKey>/turn-N/reviews/
  harness;                 // WriterKteam (injectable)
}): Promise<ReviewRoundResult>
```

For each reviewer wrapper (in parallel, bounded — mirror kloop's `parallel`):
- `kteam start -a <wrapper> --mode auto --name review-<kind> --label
  kauto-<sessionId> --cwd <hubFolder> --prompt-file <reviewerPrompt> --timeout
  <writer.turnTimeoutMins*60>`.
- The reviewer prompt is **report-only**: "Read the artifact at <artifactPath>.
  You are a REVIEWER — do NOT edit any file except your report. Write your verdict
  + findings to `<scratchDir>/reviewer-<i>.json` (`{verdict:"approved"|"rejected",
  findings:[...]}`) as your last action. Never run kautopilot/kteam commands."
- `kteam wait <id> --until-marker <scratchDir>/reviewer-<i>.json --timeout <n>`.
- Reuse the exact retry/verdict-file semantics from kloop's `runReviewer`
  (no-verdict ⇒ transport-failure retry; a real verdict is never retried).
- Reviewers are **short-lived**: `kteam stop <id>` after collecting (or rely on
  the label cleanup). One session per reviewer per round (they don't persist —
  each round re-reads the current version fresh).

`ReviewRoundResult = { clean: boolean; rounds: number; unresolved: string[];
reports: Array<{reviewer, verdict, findingsPath}> }`.

## Writer contract change (prompt-helpers.ts WRITER_SESSION_GATE)

When `config.writer.reviewers` is non-empty, point 2 of the gate flips from
"run every reviewer as a parallel subagent…" to:

> External reviewers (separate kteam sessions on other accounts) review your
> artifact AFTER each revising turn — you do NOT run reviewer subagents. When a
> turn is sent back to you with reviewer findings, fix them in the SAME working
> version (do not bump the version) and re-emit reply.json.

`composeMessage` drops the `reviewBlock` when external reviewers are configured
(the payload is consumed by the binary, not the writer). The corrective
continuation message carries the findings verbatim + the working-version path.

## Disk layout

```
scratch/<phaseKey>/turn-N/
  reviews/
    reviewer-0.json   # {verdict, findings}
    reviewer-1.json
    round-2/…         # subsequent rounds if the writer had to fix
```

`discussion` surfaces the review round (reviewer count, verdicts, rounds) under
each turn; `reviews.clean/unresolved` in the envelope is the binary's, not the
writer's.

## New config knobs

- `writer.reviewers: string[]` (above).
- `writer.maxReviewRounds: number` (default 2) — writer-fix ↔ re-review loops
  before accepting with `reviews.clean:false` + `unresolved[]` surfaced to the user.

## Testing (before enabling)

- Unit (fake kteam): a review round with 2 reviewers — all approve → clean; one
  rejects → a corrective `send` to the writer + re-review; `maxReviewRounds`
  exhaustion → accept with `unresolved`. Reviewer no-verdict ⇒ retry (kloop
  parity). Config-empty ⇒ no external round (v1 path untouched).
- Smoke: `write_spec` turn with `reviewers: ["codex-auto-terra"]` on a scratch
  session — the reviewer session appears in `kteam ps` with the `kauto-` label,
  writes its report, and the writer receives the findings.
- Manual soak: one real spec phase with a cross-family reviewer, ≥1 reject→fix
  round, validating latency and that review load lands on the reviewer account.

## Rollout

1. Land with `writer.reviewers: []` (no behavior change; the in-session subagent
   path stays the default).
2. Soak Phase A (kteam harness) first on `write_spec`.
3. Enable `reviewers: ["codex-auto-terra"]` for `write_spec` only; widen after a
   clean soak.

## Open questions

- Parallel reviewer sessions multiply concurrent kteam sessions — respect a
  fleet-wide cap (kteam already bounds concurrency; confirm the writer + N
  reviewers don't starve other kautopilot/kloop work).
- Reviewer `--cwd`: the hub folder (so it can read repos for context), same
  blast-radius reasoning as the writer's cwd.
- Should a reviewer round run on the FIRST revising turn only, or every revising
  turn? Default: every revising turn (cheap wrappers; keeps the artifact honest),
  configurable later if cost warrants.
