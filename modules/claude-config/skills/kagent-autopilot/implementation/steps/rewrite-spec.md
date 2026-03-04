# Implementation Step: Rewrite Spec — Team Agent (Opus)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- Conflict context: {conflictContext} (from user interaction)
- User guidance: {userGuidance} (from AskUserQuestion)
- Original spec: `.kagent/spec.md`
- Spec dir: {specDir}

## Agent Report Format

```
RESULT: <rewritten|error>
SPEC_FILE: .kagent/spec.md
CHANGES_SUMMARY: <brief description of what changed>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Rewrite `.kagent/spec.md` to resolve the conflict or incorporate feedback from failed iterations. This is a **critical blocker** — the spec must be clear and unambiguous for dev-loop to succeed.

## For Spec Conflict (Exit 2)

1. Read `.kagent/conflict.md` for the conflict checker's analysis
2. Read relevant reviews from `.kagent/reviews/{lastRunId}/`
3. Read the original task spec from `{specDir}/task-spec.md` for full context
4. Read user's conflict resolution choice from {conflictContext}
5. Rewrite `.kagent/spec.md`:
   - Remove the ambiguity identified by the conflict checker
   - Incorporate the user's chosen resolution
   - Ensure no new ambiguities are introduced
   - Keep the spec focused and actionable

## For Max Iterations (Exit 0, status: max_iterations)

1. Read reviewer feedback:
   - `.kagent/reviews/{lastRunId}/review-{iter}-{idx}-{binary}.md`
   - `.kagent/reviews/{lastRunId}/verdict-{iter}-{idx}-{binary}.json`
2. Read the original task spec from `{specDir}/task-spec.md`
3. Read user's guidance from {userGuidance}
4. Rewrite `.kagent/spec.md`:
   - Address the specific reviewer concerns that prevented consensus
   - Incorporate user's guidance on how to proceed
   - Add clarifications where reviewers disagreed
   - Tighten acceptance criteria if too vague

## Spec Rewrite Rules

- Keep the fix-spec format (use `templates/fix-spec-template.md` as reference)
- Be specific about what needs to change — don't leave room for interpretation
- Reference the original spec for unchanged requirements
- Include the conflict resolution or user guidance explicitly

## Cleanup

After rewriting:

```bash
rm -f .kagent/conflict.md
```

## Important

- Do NOT run dev-loop
- Do NOT update state files
- Do NOT commit anything
- Only rewrite `.kagent/spec.md` with the resolved spec
- This is a critical thinking task — take time to reason through the conflict
