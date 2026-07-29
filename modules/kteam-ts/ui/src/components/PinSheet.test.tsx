// PinSheet's DOM-free contract: pure copy helpers plus server-rendered pin
// prose. The stateful sheet remains covered by the browser matrix.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_NOTE_LEN } from '../lib/pins';
import { codeReferenceHref } from '../lib/code-references';
import {
  jumpOutcomeCopy,
  locatingLabel,
  noteCharsRemaining,
  PinNoteContent,
  PinProse,
  pinReferenceDomId,
  pinRequestNotice,
  pinRequestOutcome,
  pinProvenanceLabel,
  pinsTriggerLabel,
  pinsUnreachableCopy,
} from './PinSheet';

const pinRequest = (sessionId = 'ms-pins', pinId = 'pin-one', sequence = 1) => ({
  reference: { sessionId, pinId },
  sequence,
});

describe('pinProvenanceLabel', () => {
  test('human pins carry no tag', () => {
    expect(pinProvenanceLabel({ by: 'human', createdByName: null })).toBeNull();
    expect(pinProvenanceLabel({ by: undefined, createdByName: null })).toBeNull();
  });
  test('agent pins are always tagged, with the callsign when known', () => {
    expect(pinProvenanceLabel({ by: 'agent', createdByName: 'zoe' })).toBe('pinned by zoe');
    expect(pinProvenanceLabel({ by: 'agent', createdByName: null })).toBe('pinned by an agent');
  });
});

test('pinsUnreachableCopy is a plain honest line', () => {
  expect(pinsUnreachableCopy()).toMatch(/can't reach/i);
});

describe('pinsTriggerLabel', () => {
  test('names a count only when there is one, and always carries the word Pins', () => {
    expect(pinsTriggerLabel(0)).toBe('Pins');
    expect(pinsTriggerLabel(3)).toBe('Pins (3)');
  });
});

describe('noteCharsRemaining', () => {
  test('counts down from the cap and goes negative when over', () => {
    expect(noteCharsRemaining('')).toBe(MAX_NOTE_LEN);
    expect(noteCharsRemaining('x'.repeat(MAX_NOTE_LEN))).toBe(0);
    expect(noteCharsRemaining('x'.repeat(MAX_NOTE_LEN + 5))).toBe(-5);
  });
});

describe('jumpOutcomeCopy — honest, never a wrong jump', () => {
  test('a not-found says it is older than the loaded history', () => {
    expect(jumpOutcomeCopy('not-found')).toMatch(/older than the loaded history/i);
  });
  test('a missing transcript points the reader at the Chat tab', () => {
    expect(jumpOutcomeCopy('no-transcript')).toMatch(/chat tab/i);
  });
});

describe('locatingLabel', () => {
  test('is bare before any page loads, then reports progress with the cap', () => {
    expect(locatingLabel(0)).toBe('Locating…');
    expect(locatingLabel(1)).toMatch(/1\/10 older page\b/);
    expect(locatingLabel(3)).toMatch(/3\/10 older pages\b/);
  });
});

describe('exact pin reference delivery', () => {
  test('distinguishes found, pending, missing, unavailable, and wrong-session requests', () => {
    const pins = [{ id: 'pin-one' }];
    expect(pinRequestOutcome(pinRequest(), 'ms-pins', 'ready', pins)).toBe('found');
    expect(pinRequestOutcome(pinRequest('ms-pins', 'pin-two'), 'ms-pins', 'loading', pins)).toBe('pending');
    expect(pinRequestOutcome(pinRequest('ms-pins', 'pin-two'), 'ms-pins', 'ready', pins)).toBe('missing');
    expect(pinRequestOutcome(pinRequest('ms-pins', 'pin-two'), 'ms-pins', 'error', pins)).toBe('unavailable');
    expect(pinRequestOutcome(pinRequest('ms-other'), 'ms-pins', 'ready', pins)).toBe('wrong-session');
  });

  test('uses addressable rows and honest negative-state copy', () => {
    expect(pinReferenceDomId('ms-pins', 'pin-one')).toBe('pin-reference-ms-pins-pin-one');
    expect(pinRequestNotice('missing')).toMatch(/no longer/i);
    expect(pinRequestNotice('unavailable')).toMatch(/unavailable/i);
    expect(pinRequestNotice('wrong-session')).toMatch(/another session/i);
  });

  test('lands inside only the pin-owned scroller and clears after the animation-frame scroll', async () => {
    const source = await Bun.file(new URL('./PinSheet.tsx', import.meta.url)).text();
    const frame = source.indexOf('window.requestAnimationFrame(() => {');
    const scroll = source.indexOf('scroller.scrollTo({', frame);
    const handled = source.indexOf('onRequestedPinHandled?.(requestedPin.sequence);', scroll);
    expect(source).toContain('data-pin-scroller');
    expect(source).toContain("scroller.querySelectorAll<HTMLElement>('[data-pin-id]')");
    expect(source).toContain('row.dataset.pinId === requestedPin.reference.pinId');
    expect(source).toContain('data-reference-target={targeted || undefined}');
    expect(frame).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(frame);
    expect(handled).toBeGreaterThan(scroll);
  });
});

describe('displayed pin prose', () => {
  test('reuses Markdown for note/message prose and keeps unproved in-app hrefs inert', () => {
    const forged = codeReferenceHref({ path: 'missing.ts', line: 2 });
    const html = renderToStaticMarkup(
      <PinProse
        text={`**Ready.** See #F64 and [missing](${forged}).\n\nhttps://example.com/status`}
        sessionId="ms-pins"
        onTaskOpen={() => undefined}
        onCodeReferenceOpen={() => undefined}
      />,
    );
    expect(html).toContain('<strong>Ready.</strong>');
    expect(html).toContain('See #F64');
    expect(html).not.toContain('data-task-reference');
    expect(html).toContain('href="https://example.com/status"');
    expect(html).toContain('missing');
    expect(html).not.toContain('data-code-reference');
    expect(html).not.toContain('#kteam-code-reference');
  });

  test('a hostless legacy sheet leaves task delivery hrefs inert', () => {
    const html = renderToStaticMarkup(<PinProse text="Review #F64." sessionId="ms-pins" />);
    expect(html).toContain('Review #F64.');
    expect(html).not.toContain('data-task-reference');
    expect(html).not.toContain('href="/tasks/F64"');
  });

  test('preserves the GitHub PR chip special case', () => {
    const html = renderToStaticMarkup(
      <PinNoteContent text="https://github.com/acme/widget/pull/42" sessionId="ms-pins" />,
    );
    expect(html).toContain('widget#42');
    expect(html).toContain('aria-label="acme/widget pull request 42"');
    expect(html).toContain('target="_blank"');
  });

  test('keeps the note edit input and routes both displayed pin kinds through shared prose', async () => {
    const source = await Bun.file(new URL('./PinSheet.tsx', import.meta.url)).text();
    expect(source).toContain('value={editText}');
    expect(source).toContain('<PinNoteContent');
    expect(source.match(/<PinProse/g)).toHaveLength(2);
    expect(source).not.toContain('function NoteText');
  });
});
