import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  STALE_HEADLINE,
  WardenAttentionSection,
  attentionAgentCount,
  attentionErrorReason,
  attentionHeadline,
  attentionOutcome,
  attentionNote,
  judgedByCopy,
  judgementChip,
  judgementSummary,
  nextStateOnFailure,
  orderedAttentionItems,
  staleNote,
  verdictCoverageNote,
  type WardenAttentionState,
} from './WardenAttention';
import { ApiError } from '../lib/api';
import type { FleetAttentionItem, WardenAttentionView, WardenJudgementState } from '../types';

const item = (over: Partial<FleetAttentionItem> = {}): FleetAttentionItem => ({
  sessionId: 'ms4z-abc',
  teammate: 'auto-loge',
  id: 'A3',
  source: 'question',
  subject: 'Needs a decision on the migration',
  why: 'Asked which database to target and stopped.',
  waitingSince: '2026-07-28T10:00:00Z',
  howToResolve: 'REPLY-WITH-THE-DATABASE-NAME',
  judgement: {
    state: 'judged',
    verdict: 'needs_human',
    reason: 'blocked on a product call',
    judgedBy: { wrapper: 'claude-auto-b', model: 'opus-4.8', harness: 'claude' },
    at: '2026-07-28T10:30:00Z',
    reportPath: '/home/k/.kteam/daemon/warden/reports/2026-07-28.md',
  },
  ...over,
});

const view = (over: Partial<WardenAttentionView> = {}): WardenAttentionView => ({
  generatedAt: '2026-07-28T11:00:00Z',
  lastSweepAt: '2026-07-28T10:55:00Z',
  items: [item()],
  ...over,
});

const render = (state: WardenAttentionState): string =>
  renderToStaticMarkup(<WardenAttentionSection state={state} onOpenReport={() => {}} />);

describe('attentionHeadline', () => {
  test('leads with the count when agents are waiting', () => {
    expect(attentionHeadline(view())).toBe('1 agent needs you');
    expect(attentionHeadline(view({ items: [item(), item({ sessionId: 'b' })] }))).toBe('2 agents need you');
  });

  test('counts distinct agents, not attention records', () => {
    // One agent with three open requests is ONE agent who needs the human.
    const three = [item({ id: 'A1' }), item({ id: 'A2' }), item({ id: 'A3' })];
    expect(attentionAgentCount(three)).toBe(1);
    expect(attentionHeadline(view({ items: three }))).toBe('1 agent needs you');
    // …and the row count is still visible in the supporting line.
    expect(attentionNote(view({ items: three }))).toContain('3 requests');
  });

  test('says nobody needs you only when a sweep actually ran', () => {
    expect(attentionHeadline(view({ items: [] }))).toBe('No agents need you');
  });

  test('never calls an unswept fleet clear', () => {
    const unswept = attentionHeadline(view({ items: [], lastSweepAt: undefined }));
    expect(unswept).toBe('No warden judgement yet');
    expect(unswept).not.toContain('No agents need you');
  });

  test('trusts the daemon outcome over an inference from the sweep stamp', () => {
    // A sweep stamp is present, but the daemon says nothing was judged. The
    // stamp must not be allowed to talk the UI into "all clear".
    const stamped = view({ items: [], outcome: 'no-sweep' });
    expect(attentionHeadline(stamped)).toBe('No warden judgement yet');
    expect(attentionNote(stamped)).toContain('No warden judgement yet');
    expect(attentionHeadline(view({ items: [], outcome: 'clean-sweep' }))).toBe('No agents need you');
  });
});

describe('attentionOutcome', () => {
  test('reports what the daemon said when it says anything', () => {
    expect(attentionOutcome(view({ items: [], outcome: 'clean-sweep' }))).toBe('clean-sweep');
    expect(attentionOutcome(view({ items: [], outcome: 'no-sweep' }))).toBe('no-sweep');
    expect(attentionOutcome(view({ items: [], outcome: 'degraded' }))).toBe('degraded');
  });

  test('infers conservatively for a daemon that omits it', () => {
    expect(attentionOutcome(view({ outcome: undefined }))).toBe('items');
    expect(attentionOutcome(view({ items: [], outcome: undefined }))).toBe('clean-sweep');
    expect(attentionOutcome(view({ items: [], lastSweepAt: undefined, outcome: undefined }))).toBe('no-sweep');
  });

  test('treats an unknown future outcome as degraded, never clean', () => {
    const future = view({ items: [], outcome: 'future-outcome' as never });
    expect(attentionOutcome(future)).toBe('degraded');
    expect(attentionHeadline(future)).toBe('Can’t say who needs you');
    expect(attentionNote(future)).toContain('does not understand the warden result');
    const html = render({ status: 'ready', view: future });
    expect(html).toContain('This is not an all-clear');
    expect(html).not.toContain('A board could not be read');
  });

  test('an older daemon reporting unreadable boards is degraded, not clean', () => {
    // No `outcome` field, a sweep stamp, no rows — but a board it could not
    // open. Inferring "clean-sweep" here would vouch for what it never read.
    expect(
      attentionOutcome(view({ items: [], outcome: undefined, boardsWithParseErrors: [{ sessionId: 'ms4a' }] })),
    ).toBe('degraded');
  });
});

describe('degraded outcome', () => {
  // An unreadable board can HIDE a waiting agent. Saying "no agents need you"
  // over one is the precise failure this surface exists to prevent.
  const degradedView = view({
    items: [],
    outcome: 'degraded',
    boardsWithParseErrors: [{ sessionId: 'ms4a', parseErrors: 2 }],
    wardenDegraded: { reason: 'Some Attention boards could not be read — a waiting agent may be hidden.' },
  });

  test('never renders an all-clear', () => {
    expect(attentionHeadline(degradedView)).not.toContain('No agents need you');
    const html = render({ status: 'ready', view: degradedView });
    expect(html).not.toContain('No agents need you');
    expect(html).not.toContain('Nothing is waiting on you right now.');
  });

  test('says it cannot tell, rather than claiming nothing was judged', () => {
    expect(attentionHeadline(degradedView)).toBe('Can’t say who needs you');
    expect(attentionNote(degradedView)).toContain('A board could not be read');
    expect(attentionNote(degradedView)).toContain('Last sweep');
  });

  test('names the hidden-agent risk in the body and keeps the parse-error count', () => {
    const html = render({ status: 'ready', view: degradedView });
    expect(html).toContain('An unreadable board could be hiding someone. This is not an all-clear.');
    expect(html).toContain('1 attention board could not be read');
    expect(html).toContain('Warden degraded: Some Attention boards could not be read');
  });

  test('holds even with no sweep stamp at all', () => {
    const unswept = view({ items: [], outcome: 'degraded', lastSweepAt: undefined });
    expect(attentionHeadline(unswept)).toBe('Can’t say who needs you');
    expect(attentionNote(unswept)).toBe('The warden could not complete a trustworthy check.');
  });

  test('still leads with the count when a degraded sweep found rows anyway', () => {
    const withRows = view({ outcome: 'degraded', boardsWithParseErrors: [{ sessionId: 'ms4a', parseErrors: 1 }] });
    expect(attentionHeadline(withRows)).toBe('1 agent needs you');
    expect(render({ status: 'ready', view: withRows })).toContain('1 attention board could not be read');
  });

  test('an overdue empty sweep stays degraded without inventing a board failure', () => {
    const overdue = view({
      items: [],
      outcome: 'degraded',
      boardsWithParseErrors: [],
      wardenDegraded: { reason: 'Warden sweeps are overdue — judgements may be out of date.' },
    });
    const html = render({ status: 'ready', view: overdue });
    expect(attentionHeadline(overdue)).toBe('Can’t say who needs you');
    expect(attentionNote(overdue)).toContain('sweeps are overdue');
    expect(html).toContain('The warden check is incomplete. This is not an all-clear.');
    expect(html).not.toContain('Nothing is waiting on you right now.');
  });
});

describe('attentionNote', () => {
  test('carries sweep age behind a clean result', () => {
    expect(attentionNote(view({ items: [] }))).toContain('Last sweep');
  });

  test('spells out that no sweep is not a clean bill of health', () => {
    expect(attentionNote(view({ items: [], lastSweepAt: undefined }))).toBe(
      'No sweep has run. This is not a clean bill of health.',
    );
  });

  test('marks the ordering when items are listed', () => {
    expect(attentionNote(view())).toContain('Oldest first');
  });
});

describe('attentionErrorReason', () => {
  test('names the actual failure instead of a generic apology', () => {
    expect(attentionErrorReason(new ApiError(404, 'unknown route'))).toBe(
      'This daemon has no warden attention route yet.',
    );
    expect(attentionErrorReason(new ApiError(401, 'unauthorized'))).toBe('This page is not signed in as an admin.');
    expect(attentionErrorReason(new ApiError(403, 'forbidden'))).toBe('This page is not signed in as an admin.');
    expect(attentionErrorReason(new ApiError(500, 'boom'))).toBe('The daemon answered HTTP 500.');
    expect(attentionErrorReason(new TypeError('offline'))).toBe('Could not reach the daemon.');
  });
});

describe('orderedAttentionItems', () => {
  test('sorts oldest waiting first and sinks undated items', () => {
    const ordered = orderedAttentionItems([
      item({ sessionId: 'new', waitingSince: '2026-07-28T10:00:00Z' }),
      item({ sessionId: 'undated', waitingSince: undefined }),
      item({ sessionId: 'old', waitingSince: '2026-07-28T08:00:00Z' }),
    ]);
    expect(ordered.map(entry => entry.sessionId)).toEqual(['old', 'new', 'undated']);
  });

  test('handles a missing list without throwing', () => {
    expect(orderedAttentionItems(undefined)).toEqual([]);
  });
});

describe('judgementSummary', () => {
  test('states the verdict and the reason', () => {
    expect(judgementSummary({ state: 'judged', verdict: 'needs_human', reason: 'blocked on a product call' })).toBe(
      'Warden: needs a human — blocked on a product call',
    );
  });

  test('covers every non-judged state explicitly', () => {
    expect(judgementSummary({ state: 'pending' })).toBe('Warden is checking this now.');
    expect(judgementSummary({ state: 'queued' })).toBe('Waiting for a warden to pick this up.');
    expect(judgementSummary({ state: 'failed', reason: 'report could not be parsed' })).toBe(
      'Warden could not judge — report could not be parsed',
    );
    expect(judgementSummary({ state: 'failed' })).toBe('Warden could not judge — reason unknown');
    // Bounded, and only used when the daemon supplied no sentence of its own.
    expect(judgementSummary({ state: 'none' })).toBe('No matching warden judgement for this one.');
  });

  test('a none judgement prints the daemon reason verbatim, never an absolute claim', () => {
    // The exact sentence the backend emits for a matched incident with no
    // verdict inside a truncated window. It must survive to the screen intact.
    const bounded = 'No matching judgement was found in the recent 100-verdict window.';
    expect(judgementSummary({ state: 'none', reason: bounded })).toBe(bounded);
    expect(
      judgementSummary({ state: 'none', reason: 'No matching warden judgement applies to this attention item.' }),
    ).toBe('No matching warden judgement applies to this attention item.');
    expect(judgementSummary({ state: 'none', reason: 'No matching warden judgement yet.' })).toBe(
      'No matching warden judgement yet.',
    );
    // The old absolute copy is gone from every none path.
    for (const reason of [bounded, undefined]) {
      expect(judgementSummary({ state: 'none', ...(reason ? { reason } : {}) })).not.toBe(
        'No warden judgement for this one.',
      );
    }
  });
});

describe('judgedByCopy', () => {
  test('names the account and the age of the judgement', () => {
    const copy = judgedByCopy({
      state: 'judged',
      judgedBy: { wrapper: 'claude-auto-b', model: 'opus-4.8', wardenSessionId: 'ward-9' },
      at: '2026-07-28T10:30:00Z',
    });
    expect(copy).toContain('Judged by claude-auto-b');
    expect(copy).toContain('(opus-4.8)');
    expect(copy).toContain('ward-9');
    expect(copy).toContain('ago');
  });

  test('is explicit when nobody judged it, and when the judge is missing', () => {
    // `none` is a failed MATCH against a bounded window, not proof that nobody
    // judged — the attribution stays bounded too.
    expect(judgedByCopy({ state: 'none' })).toBe('No matching judge');
    expect(judgedByCopy({ state: 'none', at: '2026-07-28T10:30:00Z' })).toMatch(/No matching judge · .* ago/);
    expect(judgedByCopy({ state: 'none' })).not.toContain('Not judged yet');
    // pending/queued genuinely have not been judged, and keep that wording.
    expect(judgedByCopy({ state: 'pending' })).toBe('Not judged yet');
    expect(judgedByCopy({ state: 'queued' })).toBe('Not judged yet');
    expect(judgedByCopy({ state: 'judged' })).toBe('Judge unknown · time unknown');
    expect(judgedByCopy({ state: 'judged', at: '2026-07-28T10:30:00Z' })).toMatch(/Judge unknown · .* ago/);
    expect(judgedByCopy({ state: 'failed', at: '2026-07-28T10:30:00Z' })).toMatch(/Not judged · .* ago/);
    expect(judgedByCopy({ state: 'judged', judgedBy: { wrapper: 'claude-auto-b' } })).toContain('time unknown');
  });
});

describe('judgementChip', () => {
  const states: WardenJudgementState[] = ['judged', 'pending', 'queued', 'failed', 'none'];

  test('has a chip for every judgement state', () => {
    for (const state of states) expect(judgementChip(state).label.length).toBeGreaterThan(0);
  });

  test('an unknown or missing state falls back to the bounded no-match chip', () => {
    expect(judgementChip('something-new').label).toBe('No matching judgement');
    expect(judgementChip(undefined).label).toBe('No matching judgement');
  });
});

describe('WardenAttentionSection', () => {
  test('loading is explicit, never blank', () => {
    const html = render({ status: 'loading' });
    expect(html).toContain('Checking which agents need you');
    expect(html).toContain('role="status"');
  });

  test('failure says no judgement available with a reason, and does not self-hide', () => {
    const html = render({ status: 'error', reason: attentionErrorReason(new ApiError(404, 'unknown route')) });
    expect(html).toContain('No judgement available');
    expect(html).toContain('This daemon has no warden attention route yet.');
    expect(html).toContain('Treat this as unknown, not as all clear.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Who needs you');
  });

  test('a clean, freshly swept fleet says so with the sweep age', () => {
    const html = render({ status: 'ready', view: view({ items: [] }) });
    expect(html).toContain('No agents need you');
    expect(html).toContain('Last sweep');
    expect(html).toContain('Nothing is waiting on you right now.');
  });

  test('an unswept fleet is never rendered as clear', () => {
    const html = render({ status: 'ready', view: view({ items: [], lastSweepAt: undefined }) });
    expect(html).toContain('No warden judgement yet');
    expect(html).toContain('Nobody has been checked yet.');
    expect(html).not.toContain('No agents need you');
  });

  test('leads with the count, then the agent, the reason and the judge', () => {
    const html = render({ status: 'ready', view: view() });
    expect(html).toContain('1 agent needs you');
    expect(html).toContain('Auto-Loge');
    expect(html).toContain('Asked which database to target and stopped.');
    expect(html).toContain('Warden: needs a human — blocked on a product call');
    expect(html).toContain('Judged by claude-auto-b');
  });

  test('the whole agent row links to its session', () => {
    const html = render({ status: 'ready', view: view() });
    expect(html).toContain('href="/session/ms4z-abc"');
  });

  test('prose renders outside the session link so item markdown can carry links', () => {
    const html = render({
      status: 'ready',
      view: view({ items: [item({ context: 'A **warden** is the fleet supervisor; it flagged this session.' })] }),
    });
    // Context is shown, labelled, for the reader who has not followed the
    // session. Depending on test order the lazy markdown renderer may already
    // be loaded (bold renders as <strong>) or still pending (raw fallback
    // text) — the words must be there either way.
    expect(html).toMatch(/A (\*\*|<strong>)warden/);
    expect(html).toContain('it flagged this session.');
    expect(html).toContain('Context');
    // The header anchor must close before the why/context body starts: markdown
    // prose may contain links, and an anchor inside an anchor is unreachable.
    const anchorEnd = html.indexOf('</a>');
    expect(anchorEnd).toBeGreaterThan(-1);
    expect(html.indexOf('Asked which database to target and stopped.')).toBeGreaterThan(anchorEnd);
    // The subject is authored prose too, so it stays outside the session link
    // and can contain a reference link without creating nested anchors.
    expect(html.indexOf('Needs a decision on the migration')).toBeGreaterThan(anchorEnd);
  });

  test('never renders howToResolve — the per-session panel owns resolution', () => {
    const html = render({ status: 'ready', view: view() });
    expect(html).not.toContain('REPLY-WITH-THE-DATABASE-NAME');
    expect(html).not.toContain('Mark done');
  });

  test('leads every item with a named recommendation and a direct 44px control', () => {
    const html = render({
      status: 'ready',
      view: view({
        items: [
          item({
            recommendation: {
              action: 'restart',
              reason: 'The session is interrupted and can continue from saved context.',
            },
          }),
        ],
      }),
    });
    expect(html).toContain('Suggested next step');
    expect(html).toContain('Restart session');
    expect(html).toContain('The session is interrupted and can continue from saved context.');
    expect(html).toContain('min-h-[44px] w-full');
  });

  test('prints the live session status beside the judgement', () => {
    const html = render({ status: 'ready', view: view({ items: [item({ sessionStatus: 'awaiting_user' })] }) });
    expect(html).toContain('awaiting user');
  });

  test('renders LEAVE as an explicit no-action answer', () => {
    const html = render({
      status: 'ready',
      view: view({ items: [item({ recommendation: { action: 'leave', reason: 'The warden already handled it.' } })] }),
    });
    expect(html).toContain('No action needed — The warden already handled it.');
  });

  test('renders each judgement chip, and none reads as "No matching judgement"', () => {
    const states: WardenJudgementState[] = ['judged', 'pending', 'queued', 'failed', 'none'];
    for (const state of states) {
      const html = render({
        status: 'ready',
        view: view({ items: [item({ judgement: { state } })] }),
      });
      expect(html).toContain(judgementChip(state).label);
    }
    const noneHtml = render({ status: 'ready', view: view({ items: [item({ judgement: { state: 'none' } })] }) });
    expect(noneHtml).toContain('No matching judgement');
    expect(noneHtml).not.toContain('No warden judgement for this one.');
  });

  test('marks a stale judgement and the oldest waiter', () => {
    const html = render({
      status: 'ready',
      view: view({ items: [item({ judgement: { state: 'judged', verdict: 'cleared', stale: true } })] }),
    });
    expect(html).toContain('>stale<');
    expect(html).toContain('>oldest<');
  });

  test('offers the report only when a report path exists', () => {
    const withReport = render({ status: 'ready', view: view() });
    expect(withReport).toContain('Open warden report');
    const withoutReport = render({
      status: 'ready',
      view: view({ items: [item({ judgement: { state: 'none' } })] }),
    });
    expect(withoutReport).not.toContain('Open warden report');
  });

  test('surfaces warden degradation and unreadable boards instead of hiding them', () => {
    const html = render({
      status: 'ready',
      view: view({
        wardenDegraded: { reason: 'every warden account is at its usage limit', since: '2026-07-28T09:00:00Z' },
        boardsWithParseErrors: [{ sessionId: 'ms4a', parseErrors: 2 }],
      }),
    });
    expect(html).toContain('Warden degraded: every warden account is at its usage limit');
    expect(html).toContain('1 attention board could not be read');
  });

  test('every interactive target clears the 44px touch floor', () => {
    const html = render({ status: 'ready', view: view() });
    const targets = html.match(/<(?:a|button)\b[^>]*>/g) ?? [];
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toContain('min-h-[44px]');
  });

  test('survives a daemon that omits the optional halves of an item', () => {
    const html = render({
      status: 'ready',
      view: view({ items: [{ sessionId: 'bare-id', judgement: { state: 'none' } }] }),
    });
    expect(html).toContain('bare-id');
    expect(html).toContain('No reason recorded.');
    expect(html).toContain('No matching judgement');
  });
});

// Judgement matching runs against a FINITE recent-verdict window. When older
// verdicts sit outside it, "no matching judgement" is a statement about the
// window — and the page has to say which window it means.
describe('bounded verdict coverage', () => {
  const BOUNDED_REASON = 'No matching judgement was found in the recent 100-verdict window.';
  const truncated = view({
    items: [item({ judgement: { state: 'none', reason: BOUNDED_REASON } })],
    verdictCoverage: { limit: 100, truncated: true },
  });

  test('notes the window only when something was actually cut off', () => {
    expect(verdictCoverageNote(truncated)).toBe(
      'Showing the recent 100 verdicts. Older judgements may be outside this window.',
    );
    expect(verdictCoverageNote(view({ verdictCoverage: { limit: 100, truncated: false } }))).toBeNull();
    // An older daemon never reports coverage — do not announce a bound we were
    // not told about.
    expect(verdictCoverageNote(view({ verdictCoverage: undefined }))).toBeNull();
  });

  test('degrades to a limitless sentence when the daemon omits the limit', () => {
    expect(verdictCoverageNote(view({ verdictCoverage: { truncated: true } }))).toBe(
      'Showing a recent slice of verdicts. Older judgements may be outside this window.',
    );
    expect(verdictCoverageNote(view({ verdictCoverage: { truncated: true, limit: 0 } }))).toBe(
      'Showing a recent slice of verdicts. Older judgements may be outside this window.',
    );
  });

  test('renders the fleet note and the exact backend reason, without the absolute claim', () => {
    const html = render({ status: 'ready', view: truncated });
    expect(html).toContain('Showing the recent 100 verdicts. Older judgements may be outside this window.');
    expect(html).toContain(BOUNDED_REASON);
    expect(html).toContain('No matching judgement');
    expect(html).not.toContain('No warden judgement for this one.');
    // The attribution stays bounded too.
    expect(html).toContain('No matching judge');
    expect(html).not.toContain('Not judged yet');
  });

  test('an untruncated view carries no window note', () => {
    const html = render({
      status: 'ready',
      view: view({ verdictCoverage: { limit: 100, truncated: false } }),
    });
    expect(html).not.toContain('Older judgements may be outside this window.');
  });

  test('the note and the bounded reason survive the stale state', () => {
    const html = render({ status: 'stale', view: truncated, reason: 'Could not reach the daemon.' });
    expect(html).toContain(STALE_HEADLINE);
    expect(html).toContain('Showing the recent 100 verdicts. Older judgements may be outside this window.');
    expect(html).toContain(BOUNDED_REASON);
    expect(html).not.toContain('No warden judgement for this one.');
    const targets = html.match(/<(?:a|button)\b[^>]*>/g) ?? [];
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toContain('min-h-[44px]');
  });
});

// A view that loaded once and then stopped being refreshable. The rows are
// still worth reading; the claim that they are CURRENT is what expires.
describe('stale-ready state', () => {
  const clean = view({ items: [], outcome: 'clean-sweep' });

  test('a failure after a good load keeps the rows and marks them stale', () => {
    const next = nextStateOnFailure({ status: 'ready', view: view() }, new ApiError(401, 'unauthorized'));
    expect(next.status).toBe('stale');
    expect(next.status === 'stale' && next.view.items).toHaveLength(1);
    expect(next.status === 'stale' && next.reason).toBe('This page is not signed in as an admin.');
  });

  test('401, 403 and a network drop all become stale, each with its own reason', () => {
    const ready: WardenAttentionState = { status: 'ready', view: clean };
    for (const [error, reason] of [
      [new ApiError(401, 'unauthorized'), 'This page is not signed in as an admin.'],
      [new ApiError(403, 'forbidden'), 'This page is not signed in as an admin.'],
      [new TypeError('Failed to fetch'), 'Could not reach the daemon.'],
    ] as const) {
      const next = nextStateOnFailure(ready, error);
      expect(next.status).toBe('stale');
      expect(next.status === 'stale' && next.reason).toBe(reason);
    }
  });

  test('a later failure updates the reason without losing the view', () => {
    const first = nextStateOnFailure({ status: 'ready', view: view() }, new TypeError('offline'));
    const second = nextStateOnFailure(first, new ApiError(403, 'forbidden'));
    expect(second.status).toBe('stale');
    expect(second.status === 'stale' && second.reason).toBe('This page is not signed in as an admin.');
    expect(second.status === 'stale' && second.view.items).toHaveLength(1);
  });

  test('a failure with nothing loaded yet is still a plain error', () => {
    expect(nextStateOnFailure({ status: 'loading' }, new ApiError(404, 'unknown route')).status).toBe('error');
    expect(nextStateOnFailure({ status: 'error', reason: 'x' }, new TypeError('offline')).status).toBe('error');
  });

  test('the headline says it cannot refresh — never a count, never an all-clear', () => {
    const html = render({ status: 'stale', view: clean, reason: 'This page is not signed in as an admin.' });
    expect(html).toContain(STALE_HEADLINE);
    expect(html).not.toContain('No agents need you');
    expect(html).not.toContain('agents need you');
  });

  test('says in point form that the result is stale and not an all-clear', () => {
    const html = render({ status: 'stale', view: clean, reason: 'Could not reach the daemon.' });
    expect(html).toContain('<li>Last result is stale — Could not reach the daemon.</li>');
    expect(html).toContain('<li>Not an all-clear: someone may need you since.</li>');
    expect(html).toContain('role="alert"');
  });

  test('a previously CLEAN view loses the green tick and its clean copy', () => {
    const html = render({ status: 'stale', view: clean, reason: 'This page is not signed in as an admin.' });
    expect(html).not.toContain('Nothing is waiting on you right now.');
    expect(html).not.toContain('text-ok');
    expect(html).toContain('Nobody was waiting at the last check. That check is stale — not an all-clear.');
  });

  test('useful existing rows stay visible, linked and readable while stale', () => {
    const html = render({ status: 'stale', view: view(), reason: 'Could not reach the daemon.' });
    expect(html).toContain('Auto-Loge');
    expect(html).toContain('Asked which database to target and stopped.');
    expect(html).toContain('Warden: needs a human — blocked on a product call');
    expect(html).toContain('href="/session/ms4z-abc"');
    // …and the stale banner is there beside them, not instead of them.
    expect(html).toContain('Last result is stale');
  });

  test('the as-of line dates the last good answer, and degrades when undated', () => {
    expect(staleNote(view())).toContain('Last good answer');
    expect(staleNote(view())).toContain('not refreshed since');
    expect(staleNote(view({ generatedAt: undefined, lastSweepAt: undefined }))).toBe('Showing the last known answer.');
  });

  test('stale keeps the phone-first 44px floor on every target', () => {
    const html = render({ status: 'stale', view: view(), reason: 'Could not reach the daemon.' });
    const targets = html.match(/<(?:a|button)\b[^>]*>/g) ?? [];
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toContain('min-h-[44px]');
  });
});
