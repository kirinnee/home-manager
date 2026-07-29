# One reference standard — implementation plan

## Architecture decision

The single parser/resolver will live at
`modules/kteam-ts/ui/src/lib/references.ts`.

Reference parsing, proof resolution, reserved-link envelopes, and Markdown
transformation are all browser concerns. The daemon does not parse or render
message references; it only formats human-facing task and attention identifiers.
Putting the core in `src/` would make the UI reach outside its TypeScript/Vite
project and would couple the daemon package to mdast/browser contracts it never
uses. The daemon-side `taskReference` and `attentionReference` helpers will emit
the same canonical sigils, while the UI module is the one implementation that
parses, resolves, and linkifies all four kinds.

The module will expose one discriminated `Reference` union, one
`parseReferenceToken`/`findReferences` grammar, one `resolveReference` proof
gate, one reserved href codec, and one `remarkReferences` transform. A single
React link branch in `components/Markdown.tsx` will re-prove transformed links
and dispatch all reference clicks.

## Checkpoint 1 — inventory

### Current implementations

- `ui/src/lib/agent-mentions.ts`
  - Parses bare `@name`, formats canonical Markdown links, resolves live fleet
    names/ids, and has its own remark tree walk.
  - Consumers: `agent-mention-context.tsx`, `Markdown.tsx`, autocomplete
    providers, and agent/Markdown tests.
- `ui/src/lib/code-references.ts`
  - Parses implicit path-shaped text plus optional `@`, compiler columns, and
    hosted `#L` locations; owns hrefs, proof transform, and a tree walk.
  - Consumers: `Markdown.tsx`, `FilesTab.tsx`, `SidePane.tsx`, tests.
- `ui/src/lib/remark-task-references.ts`
  - Parses `#F12`-style task references; owns hrefs, proof transform, and a tree
    walk.
  - Consumers: `Markdown.tsx`, `task-reference-context.tsx`, tests.
- `ui/src/lib/remark-session-references.ts`
  - Parses `?A3` attention references and also implements pin Markdown/hrefs,
    proof, rewriting, and a separate tree walk.
  - Consumers: `Markdown.tsx`, pin context, autocomplete providers, SidePane,
    task/attention/file/pin surfaces, tests.
- `ui/src/components/Markdown.tsx`
  - Composes four remark plugins in order, independently parses four href
    formats, independently verifies origin/proof, and has separate click
    branches. It is already the renderer used by transcript messages/notices,
    task descriptions, attention items, warden reports, file Markdown, pin
    copy, and composer preview.
- `ui/src/components/ComposerHighlight.tsx`
  - Uses only the Markdown tokenizer; references are not identified by the same
    grammar.
- `ui/src/components/files-api.ts`
  - `resolveFsFilePaths` is the authoritative session-filesystem proof gate for
    file references. The unified parser supplies only explicit `@path`
    candidates; this API remains the existence/canonicalisation check.
- `ui/src/lib/pin-reference-context.tsx`, `ui/src/lib/pin-bridge.ts`, and pin
  consumers
  - Pin identity/proof and Markdown-link formatting crossed the old reference
    layer. Pin UI/state remains, while this formatter/proof channel is removed.
- `ui/src/lib/task-reference-context.tsx` and
  `ui/src/lib/agent-mention-context.tsx`
  - Existing live proof contexts are migration dependencies of the unified
    resolver rather than independent grammars.
- `ui/src/components/composer-autocomplete-{engine,providers}.ts` and
  `ui/src/components/ComposerAutocomplete.tsx`
  - Repeated `@` selects reference tiers. Providers currently insert agent
    Markdown, `#` task, `?` attention, `@` file, and pin Markdown.
  - These files are explicitly excluded from this task. Their imported formatter
    helpers can be changed safely so agent/task/attention candidates insert the
    new sigils without editing the owned files. Removing the pin candidate
    itself requires a lead-owned integration in the provider.
- `src/tasks-types.ts`, `src/attention-types.ts`,
  `ui/src/lib/tasks.ts`, and `ui/src/lib/attention.ts`
  - Format old `#`/`?` human-facing references. CLI and generated task/attention
    prose consume these helpers.
- `src/attention-sources.ts`
  - Contains hard-coded `#F…` task prose rather than using the formatter and
    must be canonicalised.
- `ui/src/components/TaskPresentation.tsx` and `TaskDagGraph.tsx`
  - Generated board labels/status metadata also emit task/file identifiers.
    Canonical formatter output applies there; authored descriptions continue
    through the shared Markdown renderer.
- `src/tasks-store.ts`, `src/attention-types.ts`, `src/attention-cli.ts`, and
  `src/attention-api.ts`
  - Accept old sigils on command input. They will accept the new canonical
    sigils; compatibility with sigil-free ids is retained.

### Surface map

| Surface                                   | Current renderer                  | Current delivery                     |
| ----------------------------------------- | --------------------------------- | ------------------------------------ |
| Assistant/human/peer messages             | `Markdown` in `TranscriptRow`     | SidePane callbacks                   |
| Notices                                   | `Markdown` in `TranscriptRow`     | SidePane callbacks                   |
| Task descriptions/activity                | `Markdown` via `TaskPresentation` | SidePane callbacks                   |
| Attention subjects/why/context/resolution | `Markdown` in `AttentionPanel`    | SidePane callbacks                   |
| Warden reports                            | `Markdown` in `WardenVerdicts`    | SidePane callbacks when hosted there |
| Warden attention cards                    | `Markdown` in `WardenAttention`   | No reference host today              |
| File Markdown                             | `Markdown` in `FilesTab`          | SidePane callbacks                   |
| Composer preview                          | `Markdown` in `Composer`          | SidePane callbacks                   |
| Composer paint layer                      | `ComposerHighlight`               | Paint only                           |

The excluded `SidePane.tsx` owns the actual task/file/attention delivery host.
No changes will be made there. Any new adapter it needs will be implemented in
an owned file and listed for the lead as a one-line integration.

## Checkpoint 2 — core

1. Add `ui/src/lib/references.ts` with:
   - `:agent`, `@file[:line[-end]]`, `&task`, and `!attention` only.
   - Exact boundaries, safe identifiers/paths, positive safe line numbers, and
     exhaustive non-match handling.
   - One resolver object and one `resolveReference` function that returns null
     on absence, mismatch, invalid canonical results, or thrown resolvers.
   - One href codec and one remark transformer.
2. Add exhaustive `references.test.ts` coverage for all sigils, line suffixes,
   boundaries/non-matches, proof-before-link, skipped Markdown nodes, and forged
   reserved links.
3. Update exported formatter helpers and daemon input normalisers to `&`/`!`.
4. Run the three required gates.

## Checkpoint 3 — render

1. Replace all four remark plugins in `Markdown.tsx` with `remarkReferences`.
2. Replace per-kind trusted-origin functions/branches with one reference-origin
   check and one shared anchor/click handler.
3. Keep existing host callbacks as compatibility adapters into the unified
   dispatch contract. Pins are not parsed or rendered as references.
4. Update all affected tests/imports and delete replaced task/code/session
   implementations where ownership permits. `agent-mentions.ts` remains only
   for fleet proof/navigation helpers.
5. Verify every Markdown consumer continues through `Markdown`; wire any raw
   prose consumer found during implementation.
6. Run the three required gates.

## Checkpoint 4 — composer

1. Feed `findReferences` into `ComposerHighlight` and paint reference tokens
   without changing textarea metrics or text bytes.
2. Change the formatter helpers imported by the excluded autocomplete provider
   so picks insert `:agent`, `&task`, `!attention`, and existing file `@path`
   text. Repeated `@` remains picker-only syntax.
3. Move pin label/identity helpers out of the reference core. Keep only the
   narrowest temporary compatibility export needed by excluded files and flag
   removal of the pin provider candidate for the lead.
4. Verify composer preview uses the same Markdown parser/resolver and run all
   gates.

## Checkpoint 5 — cleanup

1. Delete replaced implementation/test files and eliminate old sigil prose.
2. Remove pin proof/provider use from the renderer and root reference layer;
   preserve pinning UI/state itself.
3. Search for old reference imports/sigils and document the excluded one-line
   autocomplete/SidePane integrations, if still required.
4. Run all gates.

## Checkpoint 6 — handoff

Write the coordination summary with:

- Outcome and design rationale.
- Every modified/new/deleted file, one per line.
- Tail of each required gate.
- Surface-by-surface verification: surface → sigil → resolves → clickable.
- Honest excluded-file integration notes.

Then run `kteam signal done`; completion is not claimed before the marker.

## Execution record

- Checkpoint 1: complete. The inventory above includes parser/renderer,
  proof-context, formatter, file-proof, pin, composer, and generated-label
  consumers.
- Checkpoint 2: complete. `ui/src/lib/references.ts` is the sole parser,
  resolver, href codec, proof gate, and remark transform, with exhaustive
  canonical/non-match/proof tests.
- Checkpoint 3: complete in owned files. `Markdown.tsx` has one transform and
  one click dispatcher; Warden attention/report prose now uses it and fleet
  surfaces deliver proven references by navigating to their session.
- Checkpoint 4: complete in owned files. Highlighting uses `findReferences`;
  formatter helpers make owned/excluded provider consumers insert canonical
  agent/task/attention/file text. The excluded provider still needs its Pin
  tier removed.
- Checkpoint 5: complete in owned files. Replaced task tests/implementation
  were deleted, code/session modules are compatibility shims only for excluded
  owners, and root/Markdown pin proof/rendering is gone.
- Checkpoint 6: gate results and exact excluded-owner integrations are recorded
  in the coordination summary.
