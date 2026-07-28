// Candidate providers for the single composer trigger engine.
//
// `/` merges harness-valid built-in commands with the exact session account's
// discovered skills. `@` reuses the Files tab's existing cwd-contained,
// secrets-filtered listing endpoint and lazily navigates one path segment at a
// time. `&` and `?` project already-live task and attention stores through
// synchronous getters, so typing a reference never launches another request.

import { ApiError, HAS_TOKEN, TOKEN } from '../lib/api';
import { attentionReference, type AttentionItem } from '../lib/attention';
import { taskReference, TASK_STATUS_META, type TaskSummary } from '../lib/tasks';
import { fsApi, type FsListing } from './files-api';
import { isOpenableName, joinRel, normalizeRel, UNOPENABLE_NAME_REASON } from './files-model';
import type {
  ComposerAutocompleteCandidate,
  ComposerAutocompleteProvider,
  ComposerProviderResult,
} from './composer-autocomplete-engine';

export type ComposerHarness = 'claude' | 'codex';

export interface ComposerBuiltinCommand {
  name: string;
  description: string;
  harnesses: readonly ComposerHarness[];
}

/** Harness-native commands that exist independently of installed skills.
 * Keeping support on each row means a harness-specific addition is one line
 * and can never leak into the other harness's picker by accident. */
export const COMPOSER_BUILTIN_COMMANDS: readonly ComposerBuiltinCommand[] = [
  {
    name: 'compact',
    description: 'Summarise the conversation so far and free up context',
    harnesses: ['claude', 'codex'],
  },
  {
    name: 'clear',
    description: "Clear the model's conversation context",
    harnesses: ['claude', 'codex'],
  },
];

export type ComposerTaskSummary = Pick<TaskSummary, 'id' | 'title' | 'status'>;
export type ComposerAttentionItem = Pick<AttentionItem, 'id' | 'subject' | 'source'>;

/** Exactly what `listSkills()` in `modules/kteam-ts/src/skills.ts` produces —
 *  no more. An earlier draft of this client expected `scope`, `invocation` and
 *  a per-skill `insertText` from the daemon; nothing produced them, so `/`
 *  would have shipped inserting `undefined`. The rule now is that the route
 *  reports FACTS it actually knows (which account it read, and what was in the
 *  manifests) and this module derives presentation from them. */
export interface ComposerSkillSummary {
  name: string;
  description: string;
}

export interface ComposerSkillsResponse {
  /** Which harness owns the session's account, so insertion can match it. */
  harness: ComposerHarness;
  /** Whether the daemon could resolve the persisted account home used for
   *  discovery. Optional only for compatibility with daemons predating the
   *  skills surface; an absent value must never be presented as "no skills". */
  harnessHomeResolved?: boolean;
  skills: ComposerSkillSummary[];
}

/** Normalized catalog shared by autocomplete and the side-pane surface. */
export interface ComposerSkillsCatalog {
  harness: ComposerHarness;
  harnessHomeResolved?: boolean;
  skills: ComposerSkillSummary[];
}

/** THE INSERTION CONTRACT, and it is not the same on both harnesses.
 *
 *  Claude invokes a skill as `/name`. Codex uses `/skills` to BROWSE and
 *  `$name` to actually invoke one, so inserting `/name` there would type a
 *  command Codex does not have. The human trigger is `/` either way — the
 *  reader presses `/`, and what lands in the draft is whatever that harness
 *  understands. Verified against the current Codex manual by carson. */
export function skillInsertText(harness: ComposerHarness, name: string): string {
  return harness === 'codex' ? `$${name}` : `/${name}`;
}

export function skillHarnessLabel(harness: ComposerHarness): string {
  return harness === 'codex' ? 'Codex · inserts $name' : 'Claude · inserts /name';
}

const COMPOSER_HARNESSES: readonly ComposerHarness[] = ['claude', 'codex'];

/** With no harness fact yet, expose only the safe intersection. Once the live
 * session or skills response identifies the harness, its complete supported
 * set is used. A future harness-specific command can therefore never leak into
 * an unknown or different session. */
export function builtinCommandsForHarness(harness?: ComposerHarness): readonly ComposerBuiltinCommand[] {
  return COMPOSER_BUILTIN_COMMANDS.filter(command =>
    harness ? command.harnesses.includes(harness) : COMPOSER_HARNESSES.every(item => command.harnesses.includes(item)),
  );
}

function fallbackMessage(status: number): string {
  if (status === 401)
    return HAS_TOKEN
      ? 'unauthorized — the daemon rejected this page’s credentials'
      : 'skill suggestions require an authenticated daemon page';
  if (status === 403) return 'this token may not enumerate session skills';
  if (status === 404) return 'skill suggestions are unavailable on this daemon';
  return `HTTP ${status}`;
}

async function skillsRequest(sessionId: string, signal: AbortSignal): Promise<ComposerSkillsResponse> {
  const headers = new Headers();
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  const response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/skills`, { headers, signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(response.status, body.error ?? fallbackMessage(response.status), body.code);
  }
  return (await response.json()) as ComposerSkillsResponse;
}

/** Fetch and normalize the one session-scoped catalog. Keeping this here makes
 *  the autocomplete and the full surface share endpoint, sorting, harness
 *  fallback, and (most importantly) invocation semantics. */
export async function loadSkillsCatalog(sessionId: string, signal: AbortSignal): Promise<ComposerSkillsCatalog> {
  const response = await skillsRequest(sessionId, signal);
  const harness: ComposerHarness = response.harness === 'codex' ? 'codex' : 'claude';
  return {
    harness,
    harnessHomeResolved: typeof response.harnessHomeResolved === 'boolean' ? response.harnessHomeResolved : undefined,
    skills: [...(response.skills ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    ),
  };
}

/** A path query is a lazy directory request plus a fuzzy final segment. */
export function splitFileQuery(query: string): { directory: string; leaf: string } {
  const slash = query.lastIndexOf('/');
  if (slash < 0) return { directory: '', leaf: query };
  return { directory: normalizeRel(query.slice(0, slash)), leaf: query.slice(slash + 1) };
}

function fileRefusal(entry: FsListing['entries'][number]): string | undefined {
  if (!isOpenableName(entry.name)) return UNOPENABLE_NAME_REASON;
  if (entry.denied) return 'blocked by the repository secrets policy';
  if (entry.ignored) return 'gitignored content is not served';
  if (entry.escapes) return 'symlink leaves the session folder';
  return undefined;
}

function commandCandidates(harness?: ComposerHarness): ComposerAutocompleteCandidate[] {
  return builtinCommandsForHarness(harness).map(command => ({
    id: `command:${command.name}`,
    kind: 'command',
    label: command.name,
    detail: command.description,
    group: 'Commands',
    replacement: `/${command.name}`,
    append: 'space',
  }));
}

function commandsResult(harness?: ComposerHarness, notice?: string): ComposerProviderResult {
  return {
    candidates: commandCandidates(harness),
    contextLabel: harness ? `${harness === 'codex' ? 'Codex' : 'Claude'} · commands use /name` : 'Built-in commands',
    notice,
  };
}

function slashCatalogResult(catalog: ComposerSkillsCatalog): ComposerProviderResult {
  return {
    candidates: [
      ...commandCandidates(catalog.harness),
      ...catalog.skills.map(
        (skill): ComposerAutocompleteCandidate => ({
          id: `skill:${skill.name}`,
          kind: 'skill',
          label: skill.name,
          detail: skill.description,
          group: 'Skills',
          replacement: skillInsertText(catalog.harness, skill.name),
          append: 'space',
        }),
      ),
    ],
    contextLabel: skillHarnessLabel(catalog.harness),
  };
}

export function createSkillsProvider(sessionId: string, harness?: ComposerHarness): ComposerAutocompleteProvider {
  let cached: ComposerSkillsCatalog | undefined;
  return {
    id: `slash:${sessionId}`,
    trigger: '/',
    label: 'Commands & skills',
    initialCandidates: () =>
      cached ? slashCatalogResult(cached) : commandsResult(harness, 'Loading installed skills…'),
    async candidates({ signal }): Promise<ComposerProviderResult> {
      try {
        const catalog = cached ?? (await loadSkillsCatalog(sessionId, signal));
        // Only cache a response we actually completed. An aborted request never
        // reaches here, but a rejected one must not poison the next keystroke.
        cached = catalog;
        return slashCatalogResult(catalog);
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') throw error;
        const message = error instanceof Error ? error.message : String(error);
        return commandsResult(harness, `Installed skills unavailable: ${message}. Built-in commands still work.`);
      }
    },
  };
}

/** Project the current store snapshot on every query. Provider identity stays
 * stable while the getter sees live data, so there is no request, stale clone,
 * or cache to invalidate. */
export function createTasksProvider(
  getTasks: () => readonly ComposerTaskSummary[],
  sessionId = 'live',
  waitForSnapshot?: () => Promise<void> | undefined,
): ComposerAutocompleteProvider {
  const result = (): ComposerProviderResult => ({
    candidates: getTasks().map(task => {
      const reference = taskReference(task.id);
      return {
        id: `task:${task.id}`,
        kind: 'task',
        label: reference,
        detail: task.title,
        keywords: `${task.id} ${task.title} ${task.status}`,
        group: 'Tasks',
        badge: TASK_STATUS_META[task.status].label,
        replacement: reference,
        append: 'space',
      } satisfies ComposerAutocompleteCandidate;
    }),
  });
  return {
    id: `tasks:${sessionId}`,
    trigger: '&',
    label: 'Tasks',
    get snapshotKey() {
      return getTasks();
    },
    candidates: () => {
      const pending = waitForSnapshot?.();
      return pending ? pending.then(result) : result();
    },
  };
}

export function createAttentionProvider(
  getAttentionItems: () => readonly ComposerAttentionItem[],
  sessionId = 'live',
  waitForSnapshot?: () => Promise<void> | undefined,
): ComposerAutocompleteProvider {
  const result = (): ComposerProviderResult => ({
    // The attention store separates unresolved `items` from `resolved`; this
    // provider deliberately reads only the unresolved side. Resolved history
    // is useful in the panel, but noise while composing a new reference.
    candidates: getAttentionItems().map(item => {
      const reference = attentionReference(item.id);
      return {
        id: `attention:${item.id}`,
        kind: 'attention',
        label: reference,
        detail: item.subject,
        keywords: `${item.id} ${item.subject} ${item.source}`,
        group: 'Attention',
        badge: item.source,
        replacement: reference,
        append: 'space',
      } satisfies ComposerAutocompleteCandidate;
    }),
  });
  return {
    id: `attention:${sessionId}`,
    trigger: '?',
    label: 'Attention',
    get snapshotKey() {
      return getAttentionItems();
    },
    candidates: () => {
      const pending = waitForSnapshot?.();
      return pending ? pending.then(result) : result();
    },
  };
}

export function createFilesProvider(sessionId: string): ComposerAutocompleteProvider {
  // Page-lifetime, per-session directory cache. Aborted requests are never
  // cached; a stale token cannot populate or overwrite the current list.
  const cache = new Map<string, FsListing>();
  return {
    id: `files:${sessionId}`,
    trigger: '@',
    label: 'Files',
    // The agent is writing files WHILE the reader types. A page-lifetime cache
    // means a file created this turn is invisible under `@` until a reload, so
    // the composer drops the cache each time it sends.
    reset: () => cache.clear(),
    async candidates({ query, signal }): Promise<ComposerProviderResult> {
      const { directory, leaf } = splitFileQuery(query);
      let listing = cache.get(directory);
      if (!listing) {
        listing = await fsApi.list(sessionId, directory, signal);
        if (!signal.aborted) cache.set(directory, listing);
      }
      const candidates = listing.entries.map((entry): ComposerAutocompleteCandidate => {
        const path = joinRel(directory, entry.name);
        const refusal = fileRefusal(entry);
        const directoryEntry = entry.type === 'dir';
        return {
          id: `file:${path}`,
          kind: directoryEntry ? 'directory' : 'file',
          label: entry.name,
          detail: refusal ?? (directoryEntry ? 'Folder' : entry.type === 'symlink' ? 'Symlink' : path),
          keywords: path,
          replacement: `@${path}${directoryEntry ? '/' : ''}`,
          append: directoryEntry ? 'none' : 'space',
          disabled: !!refusal,
          disabledReason: refusal,
        };
      });
      return {
        candidates,
        filterQuery: leaf,
        contextLabel: directory ? `@${directory}/` : '@ session root',
        notice: listing.truncated ? '2,000 entries shown — enter a directory or refine this segment.' : undefined,
      };
    },
  };
}

export function createComposerAutocompleteProviders({
  sessionId,
  harness,
  getTasks = () => [],
  getAttentionItems = () => [],
  waitForTasks,
  waitForAttentionItems,
}: {
  sessionId: string;
  harness?: ComposerHarness;
  getTasks?: () => readonly ComposerTaskSummary[];
  getAttentionItems?: () => readonly ComposerAttentionItem[];
  waitForTasks?: () => Promise<void> | undefined;
  waitForAttentionItems?: () => Promise<void> | undefined;
}): ComposerAutocompleteProvider[] {
  return [
    createSkillsProvider(sessionId, harness),
    createFilesProvider(sessionId),
    createTasksProvider(getTasks, sessionId, waitForTasks),
    createAttentionProvider(getAttentionItems, sessionId, waitForAttentionItems),
  ];
}
