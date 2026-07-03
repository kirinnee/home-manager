# kautopilot links table — exact spec

End EVERY message that presents artifacts with one SIMPLE, FLAT summary table of
ALL the session's shareable links — so every live artifact, plan, and run is in
one place, one click away, easy to scan and keep track of. The audience is **ADHD +
dyslexic**, so this table must be **minimal and uniform**: ONE row per thing, never a
two-column **Read | Visual** layout. (Keep the inline per-artifact **Read**/**Visual**
guidance from SKILL.md — that's for presenting the artifact in the message body; this
end-of-message table is a single flat index of links, the one source of truth for the
summary.)

## Exact layout — ONE column

Each row is the label, hyperlinked to its URL. Do NOT use a
separate "Link" column and do NOT paste raw URLs — the visible text IS the link
(`[Label](url)`), one row per thing:

| Links              |
| ------------------ |
| [Spec](url)        |
| [Plans — api](url) |

## URL sources

Read **`viewerBaseUrl`** / **`kloopBaseUrl`** from `kautopilot config --field viewerBaseUrl` /
`--field kloopBaseUrl` — **never hardcode a domain** (the host is the user's public domain, not a
guess). Build the hand-made links from that; **never hand-construct version URLs** — use the exact
`url`/`diffUrl` `revise` handed back (already full URLs) for the current versioned artifacts.

## Rows to include

Only the ones that apply, one row each, label hyperlinked:

- **Each current versioned artifact** — spec, triage, brainstorm, **master plan**, feedback —
  using the latest `revise` `url` (or `diffUrl` once a prior version exists, so they see what changed).
- **Ticket** → `<viewerBaseUrl>/sessions/<id>/ticket` (or `…/ticket-draft` for an ad-hoc
  draft after brainstorm).
- **One row PER REPO that has plans** → `<viewerBaseUrl>/sessions/<id>/plans/<repo>`. The
  plans link is **per-repo, not per-plan** — that one page tabs between all of that repo's
  plans, and there is **no per-plan URL**. So give each _repo's_ plans a row (label it, e.g.
  `Plans — api`); do NOT emit one row per plan with the same repo link (duplicate hrefs).
- **One row PER kloop run** → **`<kloopBaseUrl>/kloop/<runId>`** — the kloop "plink"/permalink
  on the **kloop** dashboard (NOT the kautopilot viewer). One row per run.
- **PR(s)** — each repo's/PR's URL, **only once it exists** (one row per PR, labelled by
  repo — and by PR when a repo has several); omit the row when there's no PR yet.

## Concrete example

Sample rows — yours reflect the actual session state; labels are the links, no
second column:

| Links                                                         |
| ------------------------------------------------------------- |
| [Spec](<viewerBaseUrl>/sessions/abc123/spec/v3)               |
| [Master plan](<viewerBaseUrl>/sessions/abc123/master_plan/v2) |
| [Triage](<viewerBaseUrl>/sessions/abc123/triage/v2)           |
| [Plans — api](<viewerBaseUrl>/sessions/abc123/plans/api)      |
| [Plans — web](<viewerBaseUrl>/sessions/abc123/plans/web)      |
| [kloop run — api](<kloopBaseUrl>/kloop/run-9f2c)              |
| [PR — api](https://github.com/org/api/pull/42)                |

(The `spec/v3` / `master_plan/v2` hrefs are illustrative — use the exact `url`/`diffUrl` from
`revise`, don't build version paths by hand.)

If there is genuinely nothing to link yet (e.g. the very first turn, before any
artifact/ticket exists), say so in one line instead of an empty table.
