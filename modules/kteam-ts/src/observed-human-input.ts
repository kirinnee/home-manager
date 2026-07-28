/**
 * Normalized, harness-agnostic evidence that a HUMAN's input entered a
 * session's live conversation.
 *
 * This is deliberately SEPARATE from the `chat.user` normalized event. A
 * `chat.user` row exists for rendering and history; an `ObservedHumanInput` is
 * *delivery proof*. Conflating the two is the structural reason a message that
 * merely QUOTED a pending send once became "proof" of that send (see the B4
 * corpus audit, session ms4167e1-b8673ee1): the matcher was consuming the
 * generic chat stream. Downstream reconciliation (SessionManager) consumes only
 * this candidate type and never re-parses raw harness records, so a harness
 * format change breaks exactly one adapter file — loudly — rather than silently
 * mis-reporting delivery everywhere.
 *
 * Each harness carries its own shape version, echoed on every candidate, so a
 * shape drift is attributable to the adapter that emitted it.
 */

export const CLAUDE_INPUT_SHAPE_VERSION = 1;
export const CODEX_INPUT_SHAPE_VERSION = 1;

/**
 * How the harness recorded the input entering the conversation.
 * - `normal-user-record`: a plain user turn record (Claude idle submit;
 *   Codex canonical `response_item` user message).
 * - `native-queue-drain`: a prompt accepted from the harness's busy-input queue
 *   (Claude `attachment/queued_command`). Only Claude has this shape.
 */
export type ObservedHumanInputProof = 'normal-user-record' | 'native-queue-drain';

export interface ObservedHumanInput {
  harness: 'claude' | 'codex';
  /** Verbatim text the harness recorded as entering the conversation. */
  text: string;
  proof: ObservedHumanInputProof;
  /**
   * ISO time the input ENTERED the conversation (i.e. was consumed).
   *
   * For a Claude busy drain this is the matching `queue-operation/remove` op
   * time — NEVER `attachment.timestamp`, which is the ENQUEUE time and would
   * silently back-date every proof (verified skew up to 2m43s in the corpus).
   * For a normal user record it is the record's own timestamp. When neither is
   * available the adapter falls back conservatively to the watcher's read
   * wall-clock, supplied by the caller.
   */
  observedAt: string;
  /**
   * ISO time the human SUPPLIED the input, when the harness records it
   * separately from consumption (Claude `attachment.timestamp` = enqueue time).
   */
  originatedAt?: string;
  /**
   * Stable identity across replay so a re-read after a cursor reset cannot
   * re-prove the same delivery: the harness record UUID / item id where one
   * exists, otherwise a cursor-derived `${file}#${startOffset}#${endOffset}`
   * key that is stable across replays of the same transcript file.
   */
  proofKey: string;
  shapeVersion: number;
}
