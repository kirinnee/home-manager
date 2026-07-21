// Inline structured question form (interaction.question). Mirrors the CLI
// contract the daemon enforces: single question → labels (+ other), multiple
// questions → responses (one per question).

import { useState } from 'react';
import { Button } from './Primitives';
import type { ChatRecord } from '../types';
import { api, ApiError } from '../lib/api';

interface Props {
  sessionId: string;
  question: ChatRecord;
  onSubmit(): void;
}

export function QuestionForm({ sessionId, question, onSubmit }: Props) {
  const data = question.data as
    | {
        questions?: Array<{
          question: string;
          header?: string;
          options?: { label: string; description?: string }[];
          multiSelect?: boolean;
        }>;
      }
    | undefined;
  const questions = data?.questions ?? [];
  const isMulti = questions.length > 1;
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []));
  const [others, setOthers] = useState<string[]>(() => questions.map(() => ''));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(qIdx: number, label: string, multiple: boolean) {
    setPicks(p => {
      const next = p.slice();
      const cur = next[qIdx] ?? [];
      const has = cur.includes(label);
      next[qIdx] = multiple ? (has ? cur.filter(x => x !== label) : [...cur, label]) : [label];
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      let payload: { labels?: string[]; other?: string; responses?: string[] };
      if (!isMulti) {
        payload = { labels: picks[0] ?? [], other: (others[0] ?? '').trim() || undefined };
        if ((picks[0]?.length ?? 0) === 0 && !payload.other) {
          setError('Pick an option or write a response first');
          setSubmitting(false);
          return;
        }
      } else {
        const responses = questions.map((_, i) => (others[i] ?? '').trim() || (picks[i]?.[0] ?? ''));
        if (responses.some(r => !r)) {
          setError('Answer every question (option or text)');
          setSubmitting(false);
          return;
        }
        payload = { responses };
      }
      await api.answer(sessionId, payload);
      onSubmit();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="my-2 rounded-md border border-accent-border bg-accent-soft p-3">
      <div className="mb-2 text-[10.5px] uppercase tracking-wider text-muted font-semibold">Structured question</div>
      {questions.map((q, i) => (
        <div key={i} className="mb-2 last:mb-0">
          <div className="text-[13px] font-semibold">
            {q.header || `Question ${i + 1}`}: {q.question}
          </div>
          <div className="mt-1 space-y-0.5">
            {(q.options ?? []).map(opt => {
              const selected = (picks[i] ?? []).includes(opt.label);
              return (
                <label
                  key={opt.label}
                  className="flex items-start gap-2 px-1 py-1 rounded hover:bg-surface cursor-pointer text-[13px]"
                >
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`q${i}`}
                    checked={selected}
                    onChange={() => toggle(i, opt.label, !!q.multiSelect || isMulti)}
                    className="mt-0.5"
                  />
                  <span>
                    {opt.label}
                    {opt.description && <span className="text-muted"> — {opt.description}</span>}
                  </span>
                </label>
              );
            })}
            <textarea
              className="mt-1 w-full min-h-[44px] resize-y rounded border border-border bg-surface p-2 text-[13px]"
              placeholder="Other response (optional)"
              value={others[i] ?? ''}
              onChange={e =>
                setOthers(o => {
                  const next = o.slice();
                  next[i] = e.target.value;
                  return next;
                })
              }
            />
          </div>
        </div>
      ))}
      {error && (
        <div className="mt-2 rounded border border-err-border bg-err-bg px-2 py-1 text-[12px] text-err">{error}</div>
      )}
      <div className="mt-2">
        <Button variant="primary" size="sm" disabled={submitting} onClick={submit}>
          Submit answer
        </Button>
      </div>
    </div>
  );
}
