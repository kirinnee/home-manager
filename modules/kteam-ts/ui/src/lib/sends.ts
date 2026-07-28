// THE SEND LEDGER, BROWSER SIDE.
//
// One job: turn `GET /v1/sessions/:id/sends` plus the live `control.send_*`
// events into the rows a reader sees for messages that are not (yet) visible as
// transcript records — and do it without ever inventing a delivery.
//
// ---------------------------------------------------------------------------
// WHY THE OLD MODEL WAS WRONG, AND WHAT REPLACED IT
// ---------------------------------------------------------------------------
//
// The page used to decide delivery in the browser, from the TURN COUNTER: an
// inline queued send was treated as delivered once `currentTurn > queued.turn`,
// and a user block was synthesized for it. A corpus audit of 1,826 Claude
// transcripts (1,003 carrying queue records) killed that inference outright:
//
//   - The harness drains a queued message MID-TURN in the majority of cases.
//     Measured: `tool_result` → three `queued_command` attachments → the same
//     assistant turn resumes six seconds later. The turn boundary the UI was
//     keying on is not where delivery happens.
//   - Drains are BATCHED. Two and three messages routinely drain into ONE turn.
//     A rule that reads one turn advance as one delivery therefore mis-attributes
//     the whole batch, and the daemon-side counterpart inflated the turn counter
//     once PER matched message.
//   - So a turn advance is not evidence about any particular send, and a send
//     that never advanced a turn is not evidence of loss either.
//
// The replacement: the backend ledger owns fate, and it sets `delivered` only
// when it matched a real harness record (normalized EQUALITY, inside a time
// window, assigned one-to-one, with replay-proof evidence keys). This module
// renders that decision. It performs no content matching of its own to establish
// fate — the one bug this whole change exists to prevent was a message being
// proved by a LATER message that merely quoted it, 22 hours after the fact.
//
// Content matching survives in exactly one place, `reconcileLocalSends`, where
// it joins a browser's own optimistic row to the durable row that same browser
// caused moments earlier. That is a UI bookkeeping question ("is my chip now
// represented by a durable row?"), not an evidence question, and it is bounded by
// attachment-set equality plus a forward-only time window so an older identical
// row can never claim a newer send.

import type { KTeamEvent, SendFate, SendPath, SendRecord, SendUnaccountedReason } from '../types';
import { sameAttachmentIds } from './attachments';

/** Slack when joining a durable row to the optimistic row that caused it. The
 *  daemon stamps `acceptedAt` from its own clock, which can sit slightly behind
 *  the browser's. Same constant and same rationale as the transcript reaper. */
export const RECORD_CLOCK_SLACK_MS = 5_000;

/** Journal events that mean "the ledger changed, re-read it".
 *
 *  Refresh is triggered by these rather than the row being REBUILT from them, so
 *  the durable state a reader sees is always something the daemon confirmed on
 *  disk. `send_withdrawn` is included because a synchronous injection failure
 *  tombstones the record: the row must RETRACT, and a refresh is what retracts
 *  it. The legacy `send_queued`/`send_consumed` pair is deliberately absent —
 *  those are the compat emissions the transcript index still reads, and treating
 *  them as ledger signals would reintroduce a second, disagreeing source. */
const SEND_LEDGER_EVENTS = new Set([
  'control.send_accepted',
  'control.send_delivered',
  'control.send_unaccounted',
  'control.send_withdrawn',
]);

export function isSendLedgerEvent(event: KTeamEvent): boolean {
  return SEND_LEDGER_EVENTS.has(event.type);
}

const FATES = new Set<SendFate>(['accepted', 'delivered', 'unaccounted']);
const PATHS = new Set<SendPath>(['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue']);
const REASONS = new Set<SendUnaccountedReason>(['timeout', 'session_ended', 'composer_discarded']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && /^att_[a-f0-9]{64}$/i.test(id));
}

/** Parse one wire row.
 *
 *  Returns null only when the row has no usable IDENTITY (`sendId`/`acceptedAt`)
 *  — a row we cannot key or place is worse than absent, because it would merge
 *  unpredictably. Everything else degrades: an unknown `path` becomes undefined
 *  (so it is simply not used as a replacement index entry) and an unknown `fate`
 *  becomes `accepted`.
 *
 *  THE FATE DEFAULT IS THE LOAD-BEARING LINE. A daemon newer than this bundle
 *  may report a state this build has never heard of. Reading it as `accepted`
 *  keeps the message VISIBLE and claims nothing; reading it as `delivered` would
 *  silently assert that an unverified message reached the agent. Widening a
 *  union upward is a routine daemon change, so this has to be safe by default
 *  rather than safe by review. */
export function parseSendRecord(raw: unknown): SendRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const sendId = str(row['sendId']);
  const acceptedAt = str(row['acceptedAt']);
  if (!sendId || !acceptedAt) return null;
  const fate = row['fate'];
  const path = row['path'];
  const reason = row['unaccountedReason'];
  const evidence = row['evidence'];
  const evidenceKey =
    evidence && typeof evidence === 'object' ? str((evidence as Record<string, unknown>)['key']) : undefined;
  const record: SendRecord = {
    sendId,
    acceptedAt,
    message: typeof row['message'] === 'string' ? row['message'] : '',
    attachmentIds: ids(row['attachmentIds']),
    fate: typeof fate === 'string' && FATES.has(fate as SendFate) ? (fate as SendFate) : 'accepted',
    ...(num(row['v']) === undefined ? {} : { v: num(row['v'])! }),
    ...(num(row['acceptedTurn']) === undefined ? {} : { acceptedTurn: num(row['acceptedTurn'])! }),
    ...(typeof path === 'string' && PATHS.has(path as SendPath) ? { path: path as SendPath } : {}),
    ...(str(row['matchText']) === undefined ? {} : { matchText: str(row['matchText'])! }),
    ...(num(row['turn']) === undefined ? {} : { turn: num(row['turn'])! }),
    ...(str(row['from']) === undefined ? {} : { from: str(row['from'])! }),
    ...(str(row['fromName']) === undefined ? {} : { fromName: str(row['fromName'])! }),
    ...(row['replyExpected'] === true ? { replyExpected: true } : {}),
    ...(str(row['payloadFile']) === undefined ? {} : { payloadFile: str(row['payloadFile'])! }),
    ...(row['held'] === true ? { held: true } : {}),
    ...(row['withdrawn'] === true ? { withdrawn: true } : {}),
    ...(str(row['fateAt']) === undefined ? {} : { fateAt: str(row['fateAt'])! }),
    ...(typeof reason === 'string' && REASONS.has(reason as SendUnaccountedReason)
      ? { unaccountedReason: reason as SendUnaccountedReason }
      : {}),
    ...(str(row['opportunityAt']) === undefined ? {} : { opportunityAt: str(row['opportunityAt'])! }),
    ...(str(row['unaccountedDeadline']) === undefined ? {} : { unaccountedDeadline: str(row['unaccountedDeadline'])! }),
    ...(str(row['hardDeadline']) === undefined ? {} : { hardDeadline: str(row['hardDeadline'])! }),
    ...(str(row['timeoutFrozenAt']) === undefined ? {} : { timeoutFrozenAt: str(row['timeoutFrozenAt'])! }),
  };
  // Evidence without a key cannot be deduped or trusted as an anchor, so it is
  // dropped rather than half-kept. The fate stays whatever the daemon said —
  // this module does not second-guess the backend's decision, it only refuses to
  // carry an unusable citation for it.
  if (evidenceKey) {
    const src = evidence as Record<string, unknown>;
    // Each literal field is narrowed on its own and simply omitted when the
    // daemon reports a value this build does not know. An unrecognised tier or
    // proof shape must not make the citation unusable — the fate already came
    // from the backend, and dropping the whole record over an unknown enum would
    // turn a forward-compatible daemon change into a blank UI.
    const kind = str(src['kind']);
    const tier = str(src['tier']);
    const harness = str(src['harness']);
    const proof = str(src['proof']);
    const observedAt = str(src['observedAt']);
    const originatedAt = str(src['originatedAt']);
    const matchedTurn = num(src['matchedTurn']);
    const shapeVersion = num(src['shapeVersion']);
    record.evidence = {
      key: evidenceKey,
      ...(kind === 'chat.user' || kind === 'queued_command' || kind === 'response_item' ? { kind } : {}),
      ...(tier === 'queue-file-id' || tier === 'turn-instruction' || tier === 'exact-text' ? { tier } : {}),
      ...(harness === 'claude' || harness === 'codex' ? { harness } : {}),
      ...(proof === 'normal-user-record' || proof === 'native-queue-drain' ? { proof } : {}),
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(originatedAt === undefined ? {} : { originatedAt }),
      ...(matchedTurn === undefined ? {} : { matchedTurn }),
      ...(shapeVersion === undefined ? {} : { shapeVersion }),
    };
  }
  return record;
}

/** Parse the endpoint envelope. Tolerates a bare array (an older or hand-rolled
 *  daemon) and drops unusable rows individually, so one malformed row cannot
 *  blank the whole ledger — the same tolerance the journal reader has. */
export function parseSendsResponse(raw: unknown): SendRecord[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { sends?: unknown }).sends)
      ? (raw as { sends: unknown[] }).sends
      : [];
  const out: SendRecord[] = [];
  for (const row of rows) {
    const parsed = parseSendRecord(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Fate ordering. Within ONE delivery attempt a send only ever moves up this
 *  ladder: accepted → unaccounted (we gave up looking) → delivered (proof
 *  arrived). Nothing legitimately moves down. */
const FATE_RANK: Record<SendFate, number> = { accepted: 0, unaccounted: 1, delivered: 2 };

/** Should `incoming` replace `existing` for the same sendId?
 *
 *  A RETRY IS A NEW ATTEMPT, NOT A REGRESSION. Retrying reuses the original
 *  request id — that is the whole point of the idempotency key — so a retried send
 *  arrives under the SAME sendId with a NEWER `acceptedAt`. That is the signal
 *  which separates "the daemon accepted this message again" from "a stale HTTP
 *  response is trying to un-say what we already know", and it is why the attempt
 *  clock is checked before the fate ladder. A newer attempt wins outright, which
 *  is what lets a tombstoned send legitimately come back after a successful retry.
 *
 *  Within one attempt the ladder is enforced, so an out-of-order older fetch can
 *  neither flip a confirmed message back to "unconfirmed" NOR restore "queued" over
 *  an honest "unconfirmed". Equal rank still replaces, so a fresher snapshot of the
 *  same fate delivers its updated bookkeeping (`opportunityAt`, deadlines). */
function supersedes(incoming: SendRecord, existing: SendRecord): boolean {
  const incomingAt = Date.parse(incoming.acceptedAt);
  const existingAt = Date.parse(existing.acceptedAt);
  if (Number.isFinite(incomingAt) && Number.isFinite(existingAt) && incomingAt !== existingAt)
    return incomingAt > existingAt;
  // Same attempt. A tombstone is sticky here: the caller was told synchronously and
  // still holds the message, so only a genuinely newer attempt may undo it.
  if (existing.withdrawn === true && incoming.withdrawn !== true) return false;
  return FATE_RANK[incoming.fate] >= FATE_RANK[existing.fate];
}

/** Fold snapshots by sendId and return them newest-first.
 *
 *  The ledger is a log of full-row snapshots, so folding is the whole merge. It is
 *  NOT plain last-wins: the page folds the initial `GET /sends` together with
 *  live-event refreshes, and those are separate HTTP responses that can land out of
 *  order. Last-wins would let a snapshot taken before a transition overwrite the
 *  transition — flipping a confirmed message back to "unconfirmed", or an honest
 *  "unconfirmed" back to "queued for next turn". `supersedes` makes the fold
 *  order-independent instead, which is the property the caller actually needs, and
 *  encodes the model's "reversible upward only" invariant in the one place that
 *  could otherwise violate it.
 *
 *  Withdrawn rows are dropped from the RESULT rather than hidden downstream: a
 *  tombstone means the caller holds the message, so the durable row disappears and
 *  the local `failed to send` affordance stays in charge of it.
 *
 *  TOMBSTONES MUST REACH THIS FUNCTION — DO NOT FILTER THEM AT PARSE TIME.
 *
 *  The endpoint's DEFAULT response deliberately includes a bounded set of
 *  withdrawn rows (all still-open rows, plus the newest 200 where
 *  `fate === 'delivered'` or `withdrawn === true`). That is not an audit
 *  nicety — it is the RETRACTION MECHANISM. After `control.send_withdrawn` the
 *  refresh re-reads the endpoint, the tombstone arrives, and folding it over the
 *  previously fetched ACCEPTED row is the only thing that removes that row from
 *  the UI. Strip tombstones in `parseSendsResponse` (or anywhere upstream) as a
 *  "cleanup" and a withdrawn send silently keeps its "accepted" chip forever,
 *  because nothing else ever contradicts it.
 *
 *  So the drop happens HERE, on the folded output, after the tombstone has had its
 *  chance to supersede. `all=1` returns the same rows unbounded (capped 2,000); an
 *  audit surface that wants to SHOW attempted-and-refused sends must therefore read
 *  `parseSendsResponse` output directly rather than folding through here, since this
 *  removes exactly the rows it exists to display. */
export function foldSendRecords(...groups: readonly (readonly SendRecord[])[]): SendRecord[] {
  const byId = new Map<string, SendRecord>();
  for (const group of groups) {
    for (const record of group) {
      const existing = byId.get(record.sendId);
      if (existing && !supersedes(record, existing)) continue;
      byId.set(record.sendId, record);
    }
  }
  return [...byId.values()]
    .filter(record => record.withdrawn !== true)
    .sort((a, b) => (Date.parse(b.acceptedAt) || 0) - (Date.parse(a.acceptedAt) || 0));
}

/** Normalize for the local↔durable join only. Collapses whitespace runs rather
 *  than stripping whitespace entirely, and never lowercases: the composer
 *  soft-wraps, but "OK" and "ok" are different messages and a full strip makes
 *  "ab c" and "a bc" identical. */
function norm(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** An optimistic row this browser is holding, awaiting its durable twin. */
export interface LocalSend {
  key: string;
  /** The idempotency key this browser minted for the LOGICAL message. The daemon
   *  reuses it as the `sendId` where it can, which makes the join exact. */
  requestId: string;
  text: string;
  attachmentIds: readonly string[];
  /** Browser clock, milliseconds. */
  at: number;
}

export interface SendReconciliation<T extends LocalSend> {
  /** Local rows now represented by a durable row — the caller drops these chips. */
  claimed: Map<string, SendRecord>;
  /** Local rows with no durable twin yet: still the local chip's job. */
  unclaimedLocal: T[];
  /** Durable rows not claimed by any local row — the rows to RENDER, newest
   *  first. Includes durable rows from other clients and from earlier sessions
   *  of this one, which is exactly what survives a refresh. */
  durable: SendRecord[];
}

/** Join this browser's optimistic rows to the durable ledger, ONE-TO-ONE.
 *
 *  Two tiers, and no third:
 *
 *    1. `sendId === requestId`. The daemon reuses the client's own idempotency
 *       key as the send id where the path allows, so this is an exact identity
 *       join with nothing inferred. Always preferred.
 *    2. Normalized message equality + identical attachment set + the durable row
 *       was accepted no earlier than `at - RECORD_CLOCK_SLACK_MS`.
 *
 *  The forward-only window is what stops an OLDER identical row from reaping a
 *  NEWER send: re-sending "continue" for the fifth time must join to the fifth
 *  durable row, not to the first. Where several candidates remain legal, the
 *  closest `acceptedAt` wins and ties break FIFO by local `at` — the order the
 *  reader actually pressed Enter in — and every match consumes both sides, so N
 *  identical local rows can never all collapse onto one durable row (nor one
 *  local row onto several).
 *
 *  Equality, not prefix or containment. Two drafts where one is a prefix of the
 *  other are DIFFERENT messages and must not cross-claim; that is the same rule
 *  the backend matcher now enforces, for the same reason. */
export function reconcileLocalSends<T extends LocalSend>(
  local: readonly T[],
  ledger: readonly SendRecord[],
): SendReconciliation<T> {
  const claimed = new Map<string, SendRecord>();
  const takenLocal = new Set<string>();
  const takenDurable = new Set<string>();

  // Tier 1: exact identity. Done first and unconditionally, so a content
  // coincidence can never outrank a real id.
  const byId = new Map<string, SendRecord>();
  for (const record of ledger) byId.set(record.sendId, record);
  for (const entry of local) {
    const hit = byId.get(entry.requestId);
    if (!hit || takenDurable.has(hit.sendId)) continue;
    claimed.set(entry.key, hit);
    takenLocal.add(entry.key);
    takenDurable.add(hit.sendId);
  }

  // Tier 2: content + attachments + forward window, assigned by closest time.
  const pairs: { localKey: string; sendId: string; distance: number; at: number }[] = [];
  for (const entry of local) {
    if (takenLocal.has(entry.key)) continue;
    const text = norm(entry.text);
    for (const record of ledger) {
      if (takenDurable.has(record.sendId)) continue;
      if (norm(record.message) !== text) continue;
      if (!sameAttachmentIds(record.attachmentIds, entry.attachmentIds)) continue;
      const acceptedAt = Date.parse(record.acceptedAt);
      if (!Number.isFinite(acceptedAt) || acceptedAt < entry.at - RECORD_CLOCK_SLACK_MS) continue;
      pairs.push({
        localKey: entry.key,
        sendId: record.sendId,
        distance: Math.abs(acceptedAt - entry.at),
        at: entry.at,
      });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || a.at - b.at);
  for (const pair of pairs) {
    if (takenLocal.has(pair.localKey) || takenDurable.has(pair.sendId)) continue;
    const record = byId.get(pair.sendId);
    if (!record) continue;
    claimed.set(pair.localKey, record);
    takenLocal.add(pair.localKey);
    takenDurable.add(pair.sendId);
  }

  return {
    claimed,
    unclaimedLocal: local.filter(entry => !takenLocal.has(entry.key)),
    durable: ledger.filter(record => !takenDurable.has(record.sendId)),
  };
}

/** Which durable rows still need a chip of their own, given what is ON SCREEN.
 *
 *  ACCEPTED and UNACCOUNTED always do: the reader is owed the knowledge that a
 *  message is in flight, and an unconfirmed message is a standing fact about the
 *  session rather than a transient.
 *
 *  DELIVERED is the interesting case, and "delivered ⇒ no chip" is WRONG.
 *
 *  The transcript is paginated — 200 records, tail-first — so the harness record
 *  that proved a send can easily sit outside what is currently loaded. Dropping
 *  the chip on fate alone would render such a send as NOTHING AT ALL: no row, no
 *  badge, no trace. That is the vanishing-message bug this whole change exists to
 *  remove, reintroduced from the other direction. The local ledger owns
 *  EXISTENCE; only the presence of the proof-backed row on screen can retire its
 *  chip, because only then is the message actually visible to the reader.
 *
 *  RETIREMENT REQUIRES EXACT PROOF IDENTITY. A delivered chip is suppressed only
 *  when a loaded row IS the row the daemon cited — `row.proofKeys` contains
 *  `record.evidence.key` — and never because a row merely looks like it.
 *
 *  Content equality is not identity, and treating it as identity was a real bug.
 *  Two sends of the same text are indistinguishable by text; so is a later message
 *  that quotes an earlier one. Under pagination that is not a cosmetic problem: the
 *  actual proof row can sit outside the loaded 200-record page while a LATER
 *  identical row is on screen, and matching on text would retire the chip against
 *  the wrong row — so the delivered send would show neither its own row nor a
 *  badge, and its existence would vanish exactly as it did before this whole
 *  change. Identity is the only thing that distinguishes "the reader can see this
 *  message" from "the reader can see a message that resembles it".
 *
 *  Text, attachments, peer identity and the time window are KEPT, but strictly as
 *  defensive consistency checks on top of an identity hit: if the daemon names a
 *  row whose content disagrees with the record, something is wrong upstream and the
 *  safe response is to keep the chip rather than to trust either side. They can
 *  only ever veto a retirement, never authorise one.
 *
 *  Consequences that are deliberate, not gaps:
 *    - `evidence` absent, or `evidence.key` absent ⇒ chip stays.
 *    - a row with no `proofKeys` (no `recordUuid`/`itemId`) ⇒ cannot retire
 *      anything. This is the case for the daemon's cursor-fallback evidence keys,
 *      whose components the browser never receives, so those sends keep a chip
 *      beside their visible row. A redundant badge is a cosmetic cost; a missing
 *      one loses the message.
 *    - assignment stays ONE-TO-ONE, so two delivered sends cannot both be retired
 *      by one row even if that row's key somehow matched both. */
export function selectLedgerChips(
  durable: readonly SendRecord[],
  blocks: readonly VisibleUserRow[] = [],
): SendRecord[] {
  const delivered = durable.filter(record => record.withdrawn !== true && record.fate === 'delivered');
  const open = durable.filter(record => record.withdrawn !== true && record.fate !== 'delivered');
  if (delivered.length === 0) return sortNewestFirst(open);

  const takenRow = new Set<number>();
  const proven = new Set<string>();
  for (const record of delivered) {
    const key = record.evidence?.key;
    // No citation ⇒ nothing to match against ⇒ keep the chip.
    if (!key) continue;
    const rowIndex = blocks.findIndex((row, index) => !takenRow.has(index) && row.proofKeys?.includes(key) === true);
    if (rowIndex === -1) continue;
    const row = blocks[rowIndex]!;
    // Consistency checks. The daemon has named this exact row, so a disagreement
    // here means the ledger and the transcript describe different things — keep
    // the chip and let the reader see both rather than silently trusting one.
    //
    // A peer send's stored `message` carries the attribution banner the daemon
    // prepends (the harness only reads text), while the rendered row has had that
    // banner lifted into a sender chip, so bodies are compared.
    if (!samePeerIdentity(row, record)) continue;
    if (norm(row.text) !== norm(peerBody(record.message))) continue;
    if (!sameAttachmentIds(row.attachmentIds, record.attachmentIds)) continue;
    const acceptedAt = Date.parse(record.acceptedAt);
    if (Number.isFinite(acceptedAt) && Number.isFinite(row.at) && row.at < acceptedAt - RECORD_CLOCK_SLACK_MS) continue;
    proven.add(record.sendId);
    takenRow.add(rowIndex);
  }
  return sortNewestFirst([...open, ...delivered.filter(record => !proven.has(record.sendId))]);
}

/** The minimum a transcript user block has to expose for `selectLedgerChips` to
 *  reason about it. Deliberately a plain shape rather than a `TranscriptBlock`,
 *  so this module stays independent of the render model. */
export interface VisibleUserRow {
  /** The harness record identities this row was built from — the ONLY thing that
   *  can retire a delivered chip. Matched verbatim against `SendEvidence.key`.
   *  Absent ⇒ this row cannot stand in for any send. */
  proofKeys?: readonly string[];
  text: string;
  attachmentIds: readonly string[];
  /** Milliseconds. */
  at: number;
  /** The teammate this row is attributed to, absent for a human/self row. It must
   *  AGREE with the record's own `fromName`/`from` for the row to stand in for it. */
  peerName?: string;
}

/** Does this row and this record come from the same author?
 *
 *  Both unattributed (the human's own send) or both attributed to the same
 *  teammate. The record stores `from` (session id) and `fromName` (callsign); the
 *  rendered row shows whichever the daemon supplied, so either is accepted. */
function samePeerIdentity(row: VisibleUserRow, record: SendRecord): boolean {
  const rowPeer = row.peerName;
  const recordPeer = record.fromName ?? record.from;
  if (rowPeer === undefined) return recordPeer === undefined;
  if (recordPeer === undefined) return false;
  return rowPeer === record.fromName || rowPeer === record.from;
}

/** Strip the daemon's peer attribution banner, matching lib/transcript's parser.
 *  A message with no banner (the normal human send) is returned untouched. */
function peerBody(message: string): string {
  const match = /^\[peer message from teammate [^\]]*\]\n(?:.*?)\n\n/s.exec(message);
  return match ? message.slice(match[0].length) : message;
}

function sortNewestFirst(records: SendRecord[]): SendRecord[] {
  return records.sort((a, b) => (Date.parse(b.acceptedAt) || 0) - (Date.parse(a.acceptedAt) || 0));
}

/** Project the built transcript down to the user rows `selectLedgerChips` needs.
 *  Structurally typed rather than importing `TranscriptBlock`, so the ledger stays
 *  independent of the render model and this file has no dependency on the block
 *  union's shape beyond the four fields it actually reads. */
export function visibleUserRows(
  blocks: readonly {
    kind: string;
    text?: string;
    ts?: string;
    from?: { name: string } | undefined;
    attachments?: readonly { attachmentId: string }[] | undefined;
    proofKeys?: readonly string[] | undefined;
  }[],
): VisibleUserRow[] {
  const rows: VisibleUserRow[] = [];
  for (const block of blocks) {
    if (block.kind !== 'user') continue;
    rows.push({
      text: block.text ?? '',
      attachmentIds: (block.attachments ?? []).map(image => image.attachmentId),
      at: Date.parse(block.ts ?? '') || 0,
      ...(block.from === undefined ? {} : { peerName: block.from.name }),
      // Carried through verbatim. A block with none stays unable to retire a chip.
      ...(block.proofKeys === undefined ? {} : { proofKeys: block.proofKeys }),
    });
  }
  return rows;
}

export interface SendBadge {
  label: string;
  /** Tailwind classes. Never error-red for `unaccounted` — see below. */
  tone: string;
  /** Long-form explanation for `title`, and what a screen reader is given. */
  detail: string;
}

const ACCEPTED_TONE = 'border-warn-border bg-warn-bg text-warn';
// UNCONFIRMED IS NOT AN ERROR, AND MUST NOT LOOK LIKE ONE.
//
// A red "failed" badge tells the reader the message did not arrive. That is a
// claim kteam cannot make: the measured harness dwell between accepting a
// message and the transcript proving it has a p99 of 4.3 minutes and a maximum
// of 19.2 minutes, and the timeout is set generously above that — so a row that
// times out has very often STILL LANDED and kteam merely lost sight of it. The
// muted tone plus "may still have landed" wording is the honest rendering, and it
// is also the actionable one: red invites a resend, which on a message that did
// arrive means the agent is told twice.
const UNACCOUNTED_TONE = 'border-border bg-surface-2 text-muted';

const UNACCOUNTED_COPY: Record<SendUnaccountedReason | 'unknown', string> = {
  timeout: 'unconfirmed — kteam can’t prove this reached the agent; it may still have landed',
  session_ended: 'unconfirmed — the session ended before this was confirmed (kept durably; resend with kteam send)',
  composer_discarded:
    'unconfirmed — the session was interrupted before this was confirmed; it may or may not have been read',
  unknown: 'unconfirmed — kteam can’t prove this reached the agent; it may still have landed',
};

/** The chip for a durable row. Labels stay short (they sit inside a row of
 *  metadata); the sentence lives in `detail`, which the page hangs off `title`
 *  and off the screen-reader text, so the tone is never carried by colour alone. */
export function sendBadge(record: SendRecord): SendBadge {
  if (record.fate === 'unaccounted') {
    const detail = UNACCOUNTED_COPY[record.unaccountedReason ?? 'unknown'];
    return { label: 'unconfirmed', tone: UNACCOUNTED_TONE, detail };
  }
  if (record.fate === 'delivered') {
    return {
      label: 'delivered',
      tone: 'border-ok-border bg-ok-bg text-ok',
      detail: 'the harness transcript confirms this message entered the conversation',
    };
  }
  // ACCEPTED — AND ACCEPTED MEANS ONLY ONE THING: kteam wrote a durable record.
  // That record is appended BEFORE any keystroke reaches the pane, so at this
  // point nothing is known about injection either. Wording like "sent" or
  // "delivered to the pane" overclaims during exactly the window where the
  // uncertainty lives, which is the same mistake as a green "delivered" on an HTTP
  // 200 — so every branch below stays on the kteam side of the boundary.

  // Held rows are waiting on a human action, not on the harness.
  if (record.held === true)
    return {
      label: 'held for revive',
      tone: ACCEPTED_TONE,
      detail: 'kept durably; it will be delivered when this session is explicitly revived',
    };
  // "queued for next turn" is a claim about the HARNESS's input queue, so it is
  // only true on the native queue paths. A direct/turn-file/revive send was never
  // queued in that sense, and saying so would describe a mechanism that did not
  // happen — hence the path-neutral wording for everything else.
  const nativeQueue = record.path === 'native-inline' || record.path === 'native-file';
  // Once a consumption OPPORTUNITY has passed (the daemon stamps `opportunityAt`),
  // even "queued for next turn" is stale: the next turn came and went. A badge that
  // ages truthfully is the difference between one a reader trusts and one they learn
  // to ignore.
  if (nativeQueue && !record.opportunityAt)
    return {
      label: 'queued for next turn',
      tone: ACCEPTED_TONE,
      detail: 'accepted and stored durably; it delivers at the next prompt-ready boundary',
    };
  return {
    label: 'accepted — awaiting confirmation',
    tone: ACCEPTED_TONE,
    detail: 'stored durably; kteam is waiting for harness transcript proof',
  };
}
