// EVERY DESTINATION, SEARCHABLE — the catalog behind the palette's "Go to" group.
//
// The top bar and this module must never disagree about where you can go, so the
// bar's own `APP_BAR_DESTINATIONS` is the INPUT here rather than a second list
// copied next to it (CommandPalette passes it in; this module stays free of any
// component import, which is what keeps it testable without a DOM).
//
// Two rules this file exists to keep:
//
//   ROUTE GUARD  — a row is only offered when `parseRoute` actually resolves its
//                  path to itself. A palette that lists a destination the router
//                  would silently turn into the dashboard is a palette that
//                  lies; `destinationExists` is the check, and it is run over
//                  every entry rather than trusted per author.
//   NO DOUBLES   — the Settings group already owns rows that navigate somewhere
//                  (`Open settings`, the `/warden#config` link row). Whatever it
//                  is already offering is passed in as `taken` and suppressed
//                  here, so a search for "settings" yields one row and not two
//                  that go to the same place.

import { parseRoute } from './router';

/** The shape the palette needs from a top-bar destination. Structural on
 *  purpose: `APP_BAR_DESTINATIONS` (which also carries an icon component)
 *  satisfies it without this module knowing anything about React. */
export interface AppBarDestinationLike {
  readonly id: string;
  readonly label: string;
  /** The bar's own tooltip copy, reused verbatim as the palette description so
   *  the two surfaces cannot describe the same page differently. */
  readonly title: string;
  readonly route: string;
}

export interface DestinationPaletteEntry {
  id: string;
  label: string;
  description: string;
  href: string;
}

/** Routes the shell owns that the top bar deliberately does not carry: the
 *  dashboard is what the breadcrumb goes back to, and "New session" lives at the
 *  foot of the fleet sidebar — which a phone reader has to open a drawer to
 *  reach. Both are real routes (`/`, `/new`), and both are things people type
 *  into a palette first. */
export const SHELL_DESTINATIONS = [
  {
    id: 'sessions',
    label: 'Sessions',
    title: 'The fleet dashboard — every session, grouped by project',
    route: '/',
  },
  {
    id: 'new-session',
    label: 'New session',
    title: 'Start a teammate in a working directory',
    route: '/new',
  },
] as const satisfies readonly AppBarDestinationLike[];

/** Search terms that are NOT in the label or the description — the words a
 *  reader reaches for when they do not remember what the page is called
 *  ("spend" for analytics, "spawn" for a new session). Missing ids simply match
 *  on their own text, so a new top-bar destination is searchable the moment it
 *  is added, with or without an entry here. */
const DESTINATION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  sessions: ['sessions', 'fleet', 'dashboard', 'home', 'teammates', 'list'],
  'new-session': ['new', 'start', 'spawn', 'launch', 'create', 'teammate', 'agent'],
  analytics: ['analytics', 'usage', 'cost', 'spend', 'tokens', 'graph', 'chart', 'query', 'daily'],
  warden: ['warden', 'supervision', 'verdicts', 'accounts', 'failover', 'quota'],
  learning: ['learning', 'proposals', 'rules', 'lessons', 'scan'],
  settings: ['settings', 'preferences', 'appearance', 'theme', 'density', 'options', 'configure'],
};

/** Does the router resolve this href to the page it advertises? `/tasks` (a
 *  compatibility redirect) and anything unknown answer no — the router turns
 *  both into the dashboard, and offering them would render a 404 as a
 *  destination. A hash is the page's own business and is ignored here. */
export function destinationExists(href: string): boolean {
  const pathname = (href.split('#')[0] ?? '').split('?')[0] ?? '';
  if (!pathname.startsWith('/')) return false;
  const route = parseRoute(pathname);
  if (route.redirectTo) return false;
  return route.path === pathname || Boolean(route.sessionId);
}

/** Dashboard first (it is where Back goes), then the bar's own order, then the
 *  new-session action. */
function ordered(destinations: readonly AppBarDestinationLike[]): AppBarDestinationLike[] {
  const [sessions, newSession] = SHELL_DESTINATIONS;
  return [sessions, ...destinations, newSession];
}

/**
 * The destinations that match `query`, in navigation order. An empty query
 * returns all of them: on a phone the palette IS the navigation surface (the
 * pull-down opens it), so opening it cold has to show where you can go rather
 * than an empty frame that only answers typing.
 *
 * `taken` is the set of hrefs another palette group is already offering.
 */
export function destinationPaletteEntries(
  query: string,
  destinations: readonly AppBarDestinationLike[],
  options: { taken?: readonly string[] } = {},
): DestinationPaletteEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const taken = new Set(options.taken ?? []);
  const entries: DestinationPaletteEntry[] = [];
  for (const destination of ordered(destinations)) {
    if (!destinationExists(destination.route)) continue;
    if (taken.has(destination.route)) continue;
    const keywords = DESTINATION_KEYWORDS[destination.id] ?? [];
    const haystack = [destination.label, destination.title, ...keywords].join(' ').toLocaleLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    entries.push({
      id: `destination-${destination.id}`,
      label: destination.label,
      description: destination.title,
      href: destination.route,
    });
  }
  return entries;
}
