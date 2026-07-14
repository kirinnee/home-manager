---
name: summary
description: Give the user a fast, ADHD/dyslexia-friendly recap of the current
  work or conversation — the outcome first, then what (if anything) you need from
  them. Use when running /summary, or when asked to "summarize", "recap", "where
  are we", "catch me up", or "what do you need from me".
---

# Summary — Fast, Readable Recap

Produce a recap the user can read in **under 15 seconds**. The reader has ADHD and dyslexia: lead with the answer, keep it short, make any action they must take impossible to miss.

This is a **communication skill** — it changes how you write the recap, not the underlying work. Do not start new tasks, edit code, or run long commands. Gather just enough state to be accurate, then write.

## When to Use

- Running `/summary`
- "Summarize / recap / TL;DR this"
- "Where are we?" / "Catch me up" / "What's the status?"
- "What do you need from me?"
- After finishing a chunk of work, before handing back to the user

## What to Summarize

Recap the **current session/work**: what was done, where things stand now, and what's blocked or pending. If the user gives a focus argument, narrow to that.

If you genuinely lack context (fresh session, nothing done yet), say so in one line and ask what they want summarized — don't invent a recap.

## Output Format

Keep it tight. Target **under ~120 words**. Use this shape:

```
**<one-line outcome — the single most important thing>**

What's done:
- <short point>
- <short point>

Need from you:
- <action 1 — concrete and obvious>   (or: "Nothing — all good ✅")
```

Rules for the writing:

- **Lead with the outcome.** First line = the answer/state, bolded. Details after.
- **One idea per bullet.** Short lines. No walls of text, no nested sub-bullets.
- **Plain words.** Avoid jargon; if a term is unavoidable, give a 3-word gloss.
- **Make the ask loud.** The "Need from you" block always comes last and is always present — even if it's just "Nothing needed."
- **Bold sparingly.** Only the outcome line (and maybe one key word). If everything is bold, nothing stands out.
- **Cut filler.** No preamble like "Here's a summary of…". Just give it.
- Drop the "What's done" section if there's nothing meaningful to list — but never drop "Need from you".

## The "Need from You" Block — Always Include It

This is the point of the skill: the user must instantly see what's on them. For each item, say the **concrete action**, not vague status. Good: "Approve the migration plan", "Pick: rebase or merge?", "Run `hms` to apply". Bad: "There are some pending decisions."

If nothing is needed, say exactly that — a clear "Nothing from you — done ✅" so they can relax.

## Example

```
**Auth refactor is done and tests pass — ready for your review.**

What's done:
- Moved login to the new token flow
- Updated 4 call sites + added tests (all green)

Need from you:
- Review the PR, then merge it yourself when happy
- One open question: keep the old `/login` route as a redirect? (y/n)
```

## Notes

- Accuracy first: a fast recap that's wrong is worse than a slightly longer one that's right. Check real state (`git status`, what you actually changed) before claiming "done".
- This format applies to the recap only — it does not change commit messages, code, or file contents.
