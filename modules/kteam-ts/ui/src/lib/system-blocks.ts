// Classify a `chat.user` record's text as a HARNESS-INJECTED SYSTEM BLOCK
// rather than something a human (or a peer session) actually typed.
//
// WHY THIS EXISTS. Both harnesses smuggle machine text into the user channel —
// it is the only channel the harness reads back. Task-completion notifications,
// the Codex `<environment_context>` turn, kteam's own `Read the file …turn-NNN.md`
// prompt, interrupt notices and post-compaction summaries all arrive as
// `chat.user` records and, until now, rendered as full-width fake HUMAN messages
// (the `>>>`-led prose card). The single biggest offender is the turn prompt:
// ~1,584 records across all sessions, one per turn, each drawn as a paragraph the
// human never wrote.
//
// This module is a PURE, render-time classifier. It never mutates the record;
// `raw` always carries the full original text so the row can reveal it verbatim
// behind a disclosure — nothing is ever dropped. Classification is a UI concern
// today; the rule table is deliberately written to lift-and-shift into the daemon
// later (emit `system.*` record types at ingestion) with this left as the
// legacy fallback for pre-migration history.
//
// DEGRADE DIRECTION IS DELIBERATE. Every rule is anchored/leading and the generic
// fallback additionally requires a matching close tag, so the failure mode is a
// false NEGATIVE — a system text shown as a user message, which is exactly
// today's status quo — never a false POSITIVE that demotes real human words to a
// muted system row.

export interface SystemBlockInfo {
  /** 'task notification' | 'system reminder' | 'turn prompt' | 'interrupted' |
   *  'context compacted' | the raw tag name for the generic fallback. */
  label: string;
  /** The one human-useful line, already trimmed/collapsed for a single-line row. */
  summary?: string;
  /** task-notification `<status>` verbatim (completed | stopped | killed | …). */
  status?: string;
  /** Derived chip tone. Set from status, or directly for interrupt notices. */
  tone?: 'ok' | 'warn' | 'err';
  /** ALWAYS the full original text, untouched — the disclosure body. */
  raw: string;
}

/** ~160 chars is the point past which a one-line summary stops being scannable;
 *  the raw disclosure holds the rest. Newlines collapse to spaces so a multi-line
 *  element (a long `<summary>`) still renders as one row. */
function oneLine(s: string | undefined, max = 160): string | undefined {
  if (s == null) return undefined;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/** Content between the FIRST `<tag>…</tag>` pair, trimmed. */
function tagContent(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1]!.trim() : undefined;
}

function firstLine(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const line = s.split('\n').find(l => l.trim());
  return line?.trim();
}

/** completed→ok, killed/failed→err, anything else non-empty→warn. */
function toneForStatus(status: string | undefined): 'ok' | 'warn' | 'err' | undefined {
  if (!status) return undefined;
  if (status === 'completed') return 'ok';
  if (status === 'killed' || status === 'failed') return 'err';
  return 'warn';
}

// kteam's own turn prompt. Anchored and path-shaped — a human sentence that
// merely mentions a `.md` file cannot match, because the whole prefix INCLUDING
// the fixed instruction clause ("now, then carefully follow every instruction
// inside it.") must be present at the start.
//
// The path is home- and platform-AGNOSTIC: the leading directory varies by OS
// and user (`/home/<user>`, `/Users/<user>`, a Windows `C:\Users\<user>`), so
// only the invariant `…<sep>.kteam<sep><id><sep>turns<sep>turn-NNN.md` tail is
// matched, with `<sep>` accepting `/` or `\`. The fixed instruction clause, not
// the path prefix, is what keeps this off human prose.
const SEP = '[\\\\/]';
const TURN_PROMPT = new RegExp(
  `^Read the file .*${SEP}\\.kteam${SEP}[\\w.-]+${SEP}turns${SEP}(turn-\\d+)\\.md now, then carefully follow every instruction inside it\\.`,
);

// Harness interrupt notices. The raw IS the summary.
const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]/;

// The post-compaction opener (a long system narrative).
const COMPACTED = /^This session is being continued from a previous conversation/;

// Daemon-injected automode/liveness plumbing (see rules 6–10). These are emitted
// by the kteam daemon into the user channel to steer an autonomous session; each
// is anchored on the exact daemon-authored prefix so a human paraphrase cannot
// trip it. `CONTINUE_EXACT` is a WHOLE-STRING match — the most conservative
// possible — because the sentence is short enough that a leading-substring rule
// could plausibly demote a human message.
const LIVENESS = /^Liveness check: no output, pane change, or subprocess activity/;
const AUTOMODE = /^Automode: do not wait for user input\./;
const CONTINUE_EXACT = /^Continue from where you left off\.$/;
// Daemon "declared wait elapsed" notice (session-manager.ts, ~107 records). The
// prefix and suffix are FIXED — only the parenthesized condition varies (the
// daemon substitutes `no condition given` when the wait carried none). Anchored
// on BOTH the fixed prefix and suffix, whole-string, so a human quoting the
// phrase cannot trip it; capture group 1 is the raw condition text.
const WAIT_ELAPSED =
  /^The wait you declared has elapsed \(([\s\S]*)\)\. Re-check the condition and continue the task\.\s*$/;
// Image attachment metadata the harness prepends. Required to be the ENTIRE text
// (0/31 observed records carry trailing prose): if a future record appends the
// human's message after the bracket, it degrades to a user message — the safe
// direction — rather than hiding what the human wrote.
const IMAGE_META = /^\[Image: original (\d+x\d+)[^\]]*\]$/;

// Claude Code's local slash-command markers. These were named in the original
// ask but have ZERO occurrences in kteam transcripts (kteam sessions never take
// the local-command path), so the generic fallback below cannot see them: they
// arrive as INLINE (`<command-name>/foo</command-name>`) or SIBLING pairs, never
// as a lone opening line. They are handled with a narrow, explicit allow-list —
// the tag names are specific enough that a human sentence cannot trip it — while
// the generic fallback stays conservative.
const COMMAND_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
];

// The Codex protocol turn — `# AGENTS.md instructions` followed by the
// `<INSTRUCTIONS>` / `<environment_context>` wrapper. It is genuinely the
// harness's instructions turn, not human prose, yet without this it renders in
// the user voice (the `>>>` marker), misattributing machine plumbing to the
// human. Anchored on the exact header AND gated on the wrapper's presence so an
// ordinary `# …` markdown heading a human typed can never match.
const CODEX_PROTOCOL = /^#\s*AGENTS\.md instructions\b/;

// Generic-fallback opener: the FIRST line is exactly one opening tag (optionally
// with attributes) and nothing else. `<tag>` or `<tag attr="…">`.
const LEADING_TAG = /^<([a-zA-Z][\w:-]*)(\s[^>]*)?>\s*$/;

/** Returns block info when `text` is harness-injected system noise, or `null`
 *  when it should render as an ordinary user message. Rules are ordered;
 *  first match wins. */
export function classifySystemText(text: string): SystemBlockInfo | null {
  if (!text) return null;

  // 1. task-notification — structured, with a status chip and a summary line.
  //    Both `<summary>` and the first `<result>` line are human-actionable, so
  //    both contribute to the compact line (result second, de-duplicated if it
  //    repeats the summary); the collapsed line may truncate, but the raw
  //    disclosure always retains the full text.
  if (/^\s*<task-notification>/.test(text)) {
    const status = tagContent(text, 'status');
    const summaryEl = oneLine(tagContent(text, 'summary'));
    const resultLine = oneLine(firstLine(tagContent(text, 'result')));
    const parts = [summaryEl, resultLine !== summaryEl ? resultLine : undefined].filter(Boolean);
    const summary = oneLine(parts.join(' · '));
    const tone = toneForStatus(status);
    return {
      label: 'task notification',
      raw: text,
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      ...(tone ? { tone } : {}),
    };
  }

  // 2. system-reminder (rare in chat.user; the common ones live inside tool
  //    results and already render there).
  if (/^\s*<system-reminder>/.test(text)) {
    const inner = text
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('<'));
    return { label: 'system reminder', raw: text, ...(oneLine(inner) ? { summary: oneLine(inner) } : {}) };
  }

  // 3. kteam turn prompt.
  const turn = TURN_PROMPT.exec(text);
  if (turn) return { label: 'turn prompt', summary: `${turn[1]}.md`, raw: text };

  // 4. interrupt notice.
  if (INTERRUPTED.test(text)) {
    const summary = oneLine(firstLine(text));
    return { label: 'interrupted', tone: 'warn', raw: text, ...(summary ? { summary } : {}) };
  }

  // 5. compaction summary. Show the first useful line AFTER the `Summary`
  //    header, never the literal header word (and never the boilerplate opener).
  //    Leading list markers are stripped so a `1.`/`-` bullet reads cleanly.
  if (COMPACTED.test(text)) {
    const lines = text.split('\n');
    const header = lines.findIndex(l => /^\s*summary\b/i.test(l));
    let firstUseful: string | undefined;
    if (header >= 0) {
      for (let j = header + 1; j < lines.length; j++) {
        const t = lines[j]!.trim().replace(/^(?:\d+\.|[-*])\s*/, '');
        if (t) {
          firstUseful = t;
          break;
        }
      }
    }
    const summary = oneLine(firstUseful) ?? 'earlier conversation summarised';
    return { label: 'context compacted', summary, raw: text };
  }

  // 6. daemon liveness nudge.
  if (LIVENESS.test(text)) return { label: 'liveness', summary: 'no recent activity — continuing', raw: text };

  // 7. daemon automode notice.
  if (AUTOMODE.test(text)) return { label: 'automode', summary: 'do not wait for input', raw: text };

  // 8. daemon "continue" nudge (whole-string match, see CONTINUE_EXACT).
  if (CONTINUE_EXACT.test(text.trim())) return { label: 'continue', summary: 'resume where left off', raw: text };

  // 9. daemon "declared wait elapsed" notice. Surface the parenthesized
  //    condition as the summary; fixed fallback when it carried none (empty or
  //    the daemon's own `no condition given` placeholder).
  const wait = WAIT_ELAPSED.exec(text.trim());
  if (wait) {
    const cond = oneLine(wait[1]);
    return { label: 'wait elapsed', summary: cond ?? 'no condition given', raw: text };
  }

  // 10. image-attachment metadata.
  const img = IMAGE_META.exec(text.trim());
  if (img) return { label: 'image', summary: `original ${img[1]}`, raw: text };

  // 11. Codex protocol turn (`# AGENTS.md instructions` + the harness wrapper).
  if (CODEX_PROTOCOL.test(text) && /<INSTRUCTIONS>|<environment_context>/.test(text)) {
    return { label: 'agents instructions', summary: 'Codex harness instructions', raw: text };
  }

  // 12. Known local slash-command markers (see COMMAND_TAGS). The leading tag
  //     must be one of the known names AND close somewhere (inline or block) —
  //     the close is the same safety valve as rule 13.
  const firstNonEmpty = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l);
  if (firstNonEmpty) {
    const lead = /^<([a-zA-Z][\w:-]*)\b/.exec(firstNonEmpty);
    const tag = lead?.[1];
    if (tag && COMMAND_TAGS.includes(tag) && new RegExp(`</${tag}>`).test(text)) {
      // The slash-command name is the actionable bit; fall back to the message
      // or any command output when a bare stdout/stderr block arrives alone.
      const summary =
        oneLine(tagContent(text, 'command-name')) ??
        oneLine(tagContent(text, 'command-message')) ??
        oneLine(firstLine(tagContent(text, 'local-command-stdout'))) ??
        oneLine(firstLine(tagContent(text, 'local-command-stderr')));
      return { label: 'command', raw: text, ...(summary ? { summary } : {}) };
    }
  }

  // 13. Generic fallback: a message whose FIRST line is a lone opening tag AND
  //     whose text contains the matching close tag. Both conditions required —
  //     the close tag is the safety valve keeping an unclosed `<…` human message
  //     a user message. Catches `<environment_context>` today and any future
  //     harness wrapper with no release.
  const head = LEADING_TAG.exec(text.split('\n', 1)[0] ?? '');
  if (head) {
    const tag = head[1]!;
    if (new RegExp(`</${tag}>`).test(text)) {
      const inner = text
        .split('\n')
        .slice(1)
        .map(l => l.trim())
        .find(l => l && !l.startsWith('<'));
      return { label: tag, raw: text, ...(oneLine(inner) ? { summary: oneLine(inner) } : {}) };
    }
  }

  return null;
}
