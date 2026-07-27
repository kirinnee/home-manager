// Deterministic extraction — stage (B) of the pipeline. Cheap, free, no LLM.
// Given a session's already-read normalized records + turn briefs + inbox sends
// + interrupt count, it decides whether the session carries any HUMAN SIGNAL and,
// if so, builds two things:
//
//   • `corpus` — every user-side text concatenated. This is the verification
//     ground truth: a miner's quote is only trusted if it substring-matches
//     here (learning-store.verifyQuote). Assistant/thinking text is deliberately
//     EXCLUDED so a fabricated "user said" quote cannot match model prose.
//   • `digest` — a capped, readable transcript of the human signal, handed to
//     the miner session inline.
//
// The signal filter is what stops the miner drowning in the 1176 auto chores:
// a completed auto session with one brief and no follow-up, no interrupt, no
// tool failure has zero human signal and is skipped for free (design §4).

export interface NormalizedRecordLike {
  type?: string;
  timestamp?: string;
  source?: string;
  data?: Record<string, unknown>;
}

export interface InboxSendLike {
  text: string;
  /** Set ⇒ a teammate/lead sent it; absent ⇒ a human did (design §12.1). */
  from?: string;
  fromName?: string;
  at?: string;
}

export interface RawSessionInput {
  sessionId: string;
  teammate?: string;
  mode: 'interactive' | 'auto';
  cwd: string;
  /** git-toplevel of cwd (or cwd) — resolved by the scanner. */
  repo: string;
  harness: 'claude' | 'codex' | string;
  status: string;
  finishedAt?: string;
  records: NormalizedRecordLike[];
  turnTexts: string[];
  inbox: InboxSendLike[];
  interrupts: number;
}

export interface SessionDigest {
  sessionId: string;
  teammate?: string;
  mode: 'interactive' | 'auto';
  cwd: string;
  repo: string;
  harness: string;
  at: string;
  hasSignal: boolean;
  signalReasons: string[];
  corpus: string;
  digest: string;
  humanMessages: number;
  teammateSteers: number;
  interrupts: number;
  toolFailures: number;
}

/** Miner digest cap — user text averages ~850 tok/session, so 8k chars leaves
 *  headroom without letting one runaway session dominate a batch (design §9). */
const DIGEST_CHAR_CAP = 8000;

function textField(rec: NormalizedRecordLike, key: string): string | undefined {
  const v = rec.data?.[key];
  return typeof v === 'string' && v.length ? v : undefined;
}

export function extractSession(input: RawSessionInput): SessionDigest {
  const userTexts: string[] = [];
  let toolFailures = 0;
  for (const rec of input.records) {
    if (rec.type === 'chat.user') {
      const t = textField(rec, 'text');
      if (t) userTexts.push(t);
    } else if (rec.type === 'tool.result') {
      if (rec.data?.isError === true) toolFailures += 1;
    }
  }

  // Inbox distinguishes human (no `from`) from teammate/lead steer (`from` set).
  const humanInbox = input.inbox.filter(s => !s.from && s.text.trim());
  const teammateInbox = input.inbox.filter(s => s.from && s.text.trim());

  // Human-message count: for interactive sessions the human drives the pane, so
  // every chat.user beyond the opening brief is a human turn; inbox human sends
  // add to it. We do not try to over-attribute — the miner sees `source` labels.
  const followupUserMsgs = Math.max(0, userTexts.length - 1);
  const humanMessages = input.mode === 'interactive' ? followupUserMsgs + humanInbox.length : humanInbox.length;
  const teammateSteers = teammateInbox.length;

  const signalReasons: string[] = [];
  if (input.mode === 'interactive') signalReasons.push('interactive session (human at the wheel)');
  if (followupUserMsgs >= 1) signalReasons.push(`${followupUserMsgs} follow-up user message(s)`);
  if (teammateSteers >= 1) signalReasons.push(`${teammateSteers} lead/peer steer(s)`);
  if (humanInbox.length >= 1) signalReasons.push(`${humanInbox.length} human send(s)`);
  if (input.interrupts >= 1) signalReasons.push(`${input.interrupts} interrupt(s)`);
  if (toolFailures >= 2) signalReasons.push(`${toolFailures} tool failures`);
  if (input.status === 'failed' || input.status === 'stalled') signalReasons.push(`terminal status ${input.status}`);

  // Interactive sessions are the richest source (real corrections) and always
  // pass; auto sessions pass only when something beyond the initial brief
  // happened (a steer, an interrupt, repeated tool failure, a bad ending).
  const hasSignal = input.mode === 'interactive' || signalReasons.length > 0;

  // Corpus = ALL user-side text (verification ground truth). Order does not
  // matter for substring checks; dedupe is unnecessary.
  const corpusParts = [...userTexts, ...input.turnTexts, ...input.inbox.map(s => s.text)];
  const corpus = corpusParts.filter(Boolean).join('\n');

  // Digest: a labelled, capped rendering for the miner. Turn briefs first (pure
  // intent), then the user/steer stream.
  const lines: string[] = [];
  input.turnTexts.forEach((t, i) => lines.push(`[brief ${i + 1}]\n${t.trim()}`));
  for (const send of input.inbox) {
    const who = send.from ? `steer(${send.fromName ?? send.from})` : 'human';
    lines.push(`[${who}] ${send.text.trim()}`);
  }
  // Chat.user beyond the first brief-ish message (the first is usually the
  // brief, already covered by turnTexts); include them all — redundancy is
  // harmless and the miner needs the real phrasing to quote.
  userTexts.forEach(t => lines.push(`[user] ${t.trim()}`));
  let digest = lines.join('\n\n');
  if (digest.length > DIGEST_CHAR_CAP) digest = digest.slice(0, DIGEST_CHAR_CAP) + '\n… [truncated]';

  return {
    sessionId: input.sessionId,
    teammate: input.teammate,
    mode: input.mode,
    cwd: input.cwd,
    repo: input.repo,
    harness: input.harness,
    at: input.finishedAt ?? input.records.at(-1)?.timestamp ?? '',
    hasSignal,
    signalReasons,
    corpus,
    digest,
    humanMessages,
    teammateSteers,
    interrupts: input.interrupts,
    toolFailures,
  };
}
