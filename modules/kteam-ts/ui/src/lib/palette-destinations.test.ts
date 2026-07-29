import { describe, expect, test } from 'bun:test';
import {
  SHELL_DESTINATIONS,
  destinationExists,
  destinationPaletteEntries,
  type AppBarDestinationLike,
} from './palette-destinations';

/** Stands in for the top bar's list; the real one is asserted against in
 *  CommandPalette.test.ts, where it is wired. */
const BAR: readonly AppBarDestinationLike[] = [
  { id: 'analytics', label: 'Analytics', title: 'Query all sessions and graph daily usage', route: '/analytics' },
  { id: 'warden', label: 'Warden', title: 'Open fleet supervision and verdicts', route: '/warden' },
  { id: 'learning', label: 'Learning', title: 'Open fleet learning proposals', route: '/learning' },
  { id: 'settings', label: 'Settings', title: 'Open appearance and density settings', route: '/settings' },
];

const hrefs = (entries: { href: string }[]) => entries.map(entry => entry.href);

describe('destinationExists', () => {
  test('accepts every route the router resolves to itself', () => {
    for (const path of ['/', '/new', '/analytics', '/warden', '/learning', '/settings']) {
      expect(destinationExists(path)).toBe(true);
    }
  });

  test('accepts a session leaf and ignores a hash', () => {
    expect(destinationExists('/session/abc123')).toBe(true);
    expect(destinationExists('/warden#config')).toBe(true);
  });

  test('rejects a compatibility redirect — it is not the page it names', () => {
    expect(destinationExists('/tasks')).toBe(false);
  });

  test('rejects anything the router would quietly turn into the dashboard', () => {
    expect(destinationExists('/nope')).toBe(false);
    expect(destinationExists('/settings/extra')).toBe(false);
    expect(destinationExists('')).toBe(false);
    expect(destinationExists('analytics')).toBe(false);
  });
});

describe('destinationPaletteEntries', () => {
  test('an empty query offers every destination, dashboard first and new session last', () => {
    expect(hrefs(destinationPaletteEntries('', BAR))).toEqual([
      '/',
      '/analytics',
      '/warden',
      '/learning',
      '/settings',
      '/new',
    ]);
  });

  test('every top-bar destination is findable by its own label', () => {
    for (const destination of BAR) {
      expect(hrefs(destinationPaletteEntries(destination.label, BAR))).toContain(destination.route);
    }
  });

  test('finds a page by a word that is on neither its label nor its description', () => {
    expect(hrefs(destinationPaletteEntries('spend', BAR))).toEqual(['/analytics']);
    expect(hrefs(destinationPaletteEntries('failover', BAR))).toEqual(['/warden']);
    expect(hrefs(destinationPaletteEntries('spawn', BAR))).toEqual(['/new']);
  });

  test('matching is case- and whitespace-insensitive', () => {
    expect(hrefs(destinationPaletteEntries('  LEARNING ', BAR))).toEqual(['/learning']);
  });

  test('a query nothing answers returns nothing rather than everything', () => {
    expect(destinationPaletteEntries('zzz-not-a-page', BAR)).toEqual([]);
  });

  test('never offers a destination whose route does not resolve', () => {
    const withGhost = [...BAR, { id: 'ghost', label: 'Ghost', title: 'Never shipped', route: '/ghost' }];
    expect(hrefs(destinationPaletteEntries('', withGhost))).not.toContain('/ghost');
    expect(destinationPaletteEntries('ghost', withGhost)).toEqual([]);
  });

  test('a destination another group already offers is not repeated', () => {
    const entries = destinationPaletteEntries('settings', BAR, { taken: ['/settings'] });
    expect(hrefs(entries)).not.toContain('/settings');
  });

  test('a section anchor does not suppress the page itself — they are different places', () => {
    const entries = destinationPaletteEntries('', BAR, { taken: ['/settings#density', '/warden#config'] });
    expect(hrefs(entries)).toContain('/settings');
    expect(hrefs(entries)).toContain('/warden');
  });

  test('entry ids are stable and namespaced, so option ids cannot collide', () => {
    const entries = destinationPaletteEntries('analytics', BAR);
    expect(entries[0]?.id).toBe('destination-analytics');
  });

  test('descriptions are the bar’s own copy, never reworded here', () => {
    const [analytics] = destinationPaletteEntries('analytics', BAR);
    expect(analytics?.description).toBe('Query all sessions and graph daily usage');
  });

  test('the shell routes it adds are real routes', () => {
    for (const destination of SHELL_DESTINATIONS) {
      expect(destinationExists(destination.route)).toBe(true);
    }
  });
});
