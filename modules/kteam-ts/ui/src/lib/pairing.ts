// Convert the flat normalized chat record stream into render-ready bubble
// groups. Each group is one turn (user message OR assistant message with its
// interleaved thinking + tool cards) and renders as one bubble.
//
// Pairing rules (the bug-fix review):
//   - tool.use[i] is paired with the IMMEDIATELY adjacent tool.result when
//     their toolUseIds match (or when the result is the very next record
//     and has the matching id; we never scan arbitrarily far ahead).
//   - Tool.use without an adjacent-by-id result renders the use standalone,
//     and any trailing tool.result renders standalone too — never dropped.
//   - Thinking interleaves naturally with the assistant text it precedes.
//   - Interaction.question → question form. Interaction.answer → user bubble.
//   - Turn start/finish events render as a tiny separator.

import type { ChatRecord } from '../types';

export interface Bubble {
  isUser: boolean;
  primary: ChatRecord;
  // Subordinate records attached BELOW the body. A `tool.use` here has its
  // matching `tool.result` attached on the `pairedResult` field instead, so
  // MessageBubble can render the use + result as a single ToolCallCard.
  attachments: ChatRecord[];
  pairedResult?: ChatRecord;
}

function idOf(rec: ChatRecord): string | undefined {
  const d = rec.data as Record<string, unknown> | undefined;
  if (!d) return undefined;
  const v = d['toolUseId'];
  return typeof v === 'string' ? v : undefined;
}

export function pairRecordsToBubbles(records: ChatRecord[]): Bubble[] {
  const bubbles: Bubble[] = [];
  const n = records.length;
  let i = 0;

  while (i < n) {
    const r = records[i]!;

    if (r.type === 'chat.user') {
      bubbles.push({ isUser: true, primary: r, attachments: [] });
      i++;
      continue;
    }

    if (r.type === 'chat.assistant.text') {
      const group: ChatRecord[] = [r];
      i++;
      // Attach subsequent records to the same bubble. We do NOT break on a
      // subsequent `chat.assistant.text` — consecutive text blocks within the
      // same turn collapse into one bubble. We DO break on user / interaction
      // / turn-boundary records so the next chunk starts a new bubble.
      while (i < n) {
        const next = records[i]!;
        if (
          next.type === 'chat.user' ||
          next.type === 'interaction.question' ||
          next.type === 'interaction.answer' ||
          next.type === 'turn.started' ||
          next.type === 'turn.completed' ||
          next.type === 'turn.aborted'
        )
          break;
        group.push(next);
        i++;
      }
      // Walk the group: pair adjacent tool.use+tool.result by id while
      // preserving order. Unpaired items remain in `attachments`.
      const attachments: ChatRecord[] = [];
      let pairedResult: ChatRecord | undefined;
      let k = 0;
      while (k < group.length) {
        const cur = group[k]!;
        const next = k + 1 < group.length ? group[k + 1]! : undefined;
        if (cur.type === 'tool.use' && next?.type === 'tool.result') {
          const useId = idOf(cur);
          const resultId = idOf(next);
          const idsMatch = !!useId && !!resultId && useId === resultId;
          if (idsMatch) {
            // Consume both into one card — primary gets the use; carry the
            // result on a dedicated field so the bubble renders a single card.
            attachments.push(cur);
            pairedResult = next;
            k += 2;
            continue;
          }
        }
        attachments.push(cur);
        k += 1;
      }
      bubbles.push({
        isUser: false,
        primary: group[0]!,
        attachments,
        ...(pairedResult ? { pairedResult } : {}),
      });
      continue;
    }

    if (r.type === 'turn.started' || r.type === 'turn.completed' || r.type === 'turn.aborted') {
      bubbles.push({ isUser: false, primary: r, attachments: [] });
      i++;
      continue;
    }

    if (r.type === 'interaction.answer') {
      bubbles.push({
        isUser: true,
        primary: { ...r, type: 'chat.user', data: { text: extractAnswerText(r) } },
        attachments: [],
      });
      i++;
      continue;
    }

    if (r.type === 'interaction.question') {
      i++; // question form is rendered separately, not as a bubble
      continue;
    }

    if (r.type === 'chat.assistant.thinking' || r.type === 'chat.assistant.reasoning') {
      const d = r.data as { thinking?: string; reasoning?: string };
      const text = r.type === 'chat.assistant.thinking' ? d.thinking : d.reasoning;
      bubbles.push({
        isUser: false,
        primary: { ...r, type: 'chat.assistant.text', data: { text: '' } },
        attachments: [{ ...r, data: { ...(r.data as object), text } } as unknown as ChatRecord],
      });
      i++;
      continue;
    }

    if (r.type === 'tool.use') {
      // Stray top-level tool.use (no preceding assistant.text): try to pair
      // with the IMMEDIATELY next record if it is a tool.result and the ids
      // match. Otherwise render standalone — never drop.
      const next = i + 1 < n ? records[i + 1]! : undefined;
      if (next?.type === 'tool.result' && idOf(r) && idOf(r) === idOf(next)) {
        bubbles.push({
          isUser: false,
          primary: r,
          attachments: [],
          pairedResult: next,
        });
        i += 2;
      } else {
        bubbles.push({ isUser: false, primary: r, attachments: [] });
        i += 1;
      }
      continue;
    }

    if (r.type === 'tool.result') {
      bubbles.push({ isUser: false, primary: r, attachments: [] });
      i++;
      continue;
    }

    // Unknown record type — render as a generic system row, never crash.
    bubbles.push({ isUser: false, primary: r, attachments: [] });
    i++;
  }
  return bubbles;
}

function extractAnswerText(r: ChatRecord): string {
  const d = r.data as { labels?: string[]; other?: string; responses?: string[] } | undefined;
  if (!d) return '(answer)';
  if (d.other) return d.other;
  if (d.labels?.length) return d.labels.join(', ');
  if (d.responses?.length) return d.responses.join(' / ');
  return '(answer)';
}

export function latestPendingQuestion(records: ChatRecord[]): ChatRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.type === 'interaction.question') return r;
  }
  return null;
}
