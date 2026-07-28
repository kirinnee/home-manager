// Candidate providers for the single composer trigger engine.
//
// `/` merges harness-valid built-in commands with the exact session account's
// discovered skills. `@` is the one reference browser: agents, tasks and
// attention come from already-live stores, while Files reuses the existing
// cwd-contained, secrets-filtered listing endpoint and lazily navigates one
// path segment at a time.

import { ApiError, HAS_TOKEN, TOKEN } from '../lib/api';
import { agentMentionReference } from '../lib/agent-mentions';
import { attentionReference, type AttentionItem } from '../lib/attention';
import { rankSessions, recentSessions, type SessionEntry } from '../lib/fuzzy';
import { taskReference, TASK_STATUS_META, type TaskSummary } from '../lib/tasks';
import { TERMINAL_STATUSES } from '../lib/utils';
import type { SessionView } from '../types';
import { fsApi, type FsListing } from './files-api';
import { isOpenableName, joinRel, normalizeRel, UNOPENABLE_NAME_REASON } from './files-model';
import {
  MAX_AUTOCOMPLETE_RESULTS,
  type ComposerAutocompleteCandidate,
  type ComposerAutocompleteProvider,
  type ComposerProviderResult,
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

const EMPTY_SESSIONS: readonly SessionView[] = [];
const EMPTY_TASKS: readonly ComposerTaskSummary[] = [];
const EMPTY_ATTENTION: readonly ComposerAttentionItem[] = [];
const noSessions = () => EMPTY_SESSIONS;
const noTasks = () => EMPTY_TASKS;
const noAttention = () => EMPTY_ATTENTION;

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

export interface ComposerFileSelector {
  /** Canonical suffix, including its leading colon. Empty means plain @path. */
  suffix: string;
  complete: boolean;
  valid: boolean;
}

export interface ComposerFileReferenceQuery {
  directory: string;
  leaf: string;
  selector: ComposerFileSelector;
}

const EMPTY_FILE_SELECTOR: ComposerFileSelector = { suffix: '', complete: true, valid: true };
const COLON_FILE_SELECTOR = /^(.*?):([0-9]*)(?:(:)([0-9]*)|(-)([0-9]*))?$/u;
const HASH_FILE_SELECTOR = /^(.*?)#L([0-9]*)(?:-L?([0-9]*))?$/iu;

const selectorNumber = (value: string): number | null => {
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

/** Strip an optional line/range selector before the ordinary lazy directory
 * lookup. This keeps `@src/app.ts:42` searching for `app.ts`, not for a literal
 * filename ending in `:42`. GitHub input is recognised but the replacement is
 * always the canonical compiler-style colon form. */
export function splitFileReferenceQuery(query: string): ComposerFileReferenceQuery {
  const hash = HASH_FILE_SELECTOR.exec(query);
  const colon = hash ? null : COLON_FILE_SELECTOR.exec(query);
  const match = hash ?? colon;
  if (!match || !(match[1] ?? '')) return { ...splitFileQuery(query), selector: EMPTY_FILE_SELECTOR };

  const pathQuery = match[1] ?? '';
  const lineText = match[2] ?? '';
  const separator = hash ? (match[3] === undefined ? '' : '-') : (match[3] ?? match[5] ?? '');
  const tailText = hash ? (match[3] ?? '') : (match[4] ?? match[6] ?? '');
  const line = selectorNumber(lineText);
  const tail = tailText ? selectorNumber(tailText) : null;
  const complete = lineText.length > 0 && (!separator || tailText.length > 0);
  const valid =
    (!lineText || line !== null) &&
    (!tailText || tail !== null) &&
    (separator !== '-' || line === null || tail === null || tail >= line);
  const canonicalSeparator = separator === ':' ? ':' : separator ? '-' : '';
  return {
    ...splitFileQuery(pathQuery),
    selector: {
      suffix: `:${lineText}${canonicalSeparator}${tailText}`,
      complete,
      valid,
    },
  };
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
const NAMED_REFERENCE_PRIORITY = 1;
const MAX_AGENT_RESULTS = 8;
const BARE_FILE_RESULT_RESERVE = 4;
const BARE_NAMED_RESULT_BUDGET = MAX_AUTOCOMPLETE_RESULTS - BARE_FILE_RESULT_RESERVE;
const TEAMMATE_NAME = /^[a-z][a-z0-9-]{0,31}$/iu;

interface RankedAgentSession extends SessionEntry {
  view: SessionView;
}

function activityAt(view: SessionView): number {
  const raw =
    view.state.lastActivityAt ??
    view.state.finishedAt ??
    view.state.startedAt ??
    view.config.updatedAt ??
    view.config.createdAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function agentEntries(sessions: readonly SessionView[]): RankedAgentSession[] {
  return sessions.flatMap(view => {
    const teammate = view.config.teammate?.trim().toLowerCase() ?? '';
    if (!TEAMMATE_NAME.test(teammate)) return [];
    const finished = TERMINAL_STATUSES.has(view.state.status);
    return [
      {
        id: view.config.id,
        teammate,
        task: view.config.name,
        label: view.config.label?.trim() ?? '',
        folder: view.config.cwd,
        activityAt: activityAt(view),
        active: !finished,
        finished,
        view,
      },
    ];
  });
}

function rankedAgents(sessions: readonly SessionView[], query: string): RankedAgentSession[] {
  const entries = agentEntries(sessions);
  if (!query) return recentSessions(entries, MAX_AGENT_RESULTS);
  // A completed exact-name duplicate must not jump above the live holder. Rank
  // well within each family, then keep the live family first.
  const live = rankSessions(
    entries.filter(entry => !entry.finished),
    query,
    { limit: MAX_AGENT_RESULTS },
  );
  const finished = rankSessions(
    entries.filter(entry => entry.finished),
    query,
    { limit: MAX_AGENT_RESULTS },
  );
  return [...live, ...finished].slice(0, MAX_AGENT_RESULTS);
}

function agentCandidates(sessions: readonly SessionView[], query: string): ComposerAutocompleteCandidate[] {
  return rankedAgents(sessions, query).map(({ view, teammate }) => {
    const label = view.config.label?.trim() || 'no label';
    const task = view.config.name.trim() || 'No task title';
    const model = view.state.observedModel || view.config.model || view.config.modelHint;
    const account = view.config.binary;
    return {
      id: `agent:${view.config.id}`,
      kind: 'agent',
      label: teammate,
      detail: [label, task, [model, account].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
      keywords: [teammate, label, task, view.state.status, model, account, view.state.activity]
        .filter(Boolean)
        .join(' '),
      group: 'Agents',
      badge: view.state.status.replaceAll('_', ' '),
      rankPriority: NAMED_REFERENCE_PRIORITY,
      replacement: agentMentionReference(teammate, view.config.id),
      append: 'space',
    } satisfies ComposerAutocompleteCandidate;
  });
}

function taskCandidates(tasks: readonly ComposerTaskSummary[]): ComposerAutocompleteCandidate[] {
  return tasks.map(task => {
    const reference = taskReference(task.id);
    return {
      id: `task:${task.id}`,
      kind: 'task',
      label: reference,
      detail: task.title,
      keywords: `${task.id} ${task.title} ${task.status}`,
      group: 'Tasks',
      badge: TASK_STATUS_META[task.status].label,
      rankPriority: NAMED_REFERENCE_PRIORITY,
      replacement: reference,
      append: 'space',
    } satisfies ComposerAutocompleteCandidate;
  });
}

function attentionCandidates(items: readonly ComposerAttentionItem[]): ComposerAutocompleteCandidate[] {
  // The attention store separates unresolved `items` from `resolved`; callers
  // deliberately pass only the unresolved side. Resolved history is useful in
  // its panel, but noise while composing a new reference.
  return items.map(item => {
    const reference = attentionReference(item.id);
    return {
      id: `attention:${item.id}`,
      kind: 'attention',
      label: reference,
      detail: item.subject,
      keywords: `${item.id} ${item.subject} ${item.source}`,
      group: 'Attention',
      badge: item.source,
      rankPriority: NAMED_REFERENCE_PRIORITY,
      replacement: reference,
      append: 'space',
    } satisfies ComposerAutocompleteCandidate;
  });
}

/** Keep every available named group discoverable within the bounded bare-`@`
 * list. Taking one round from each group at a time gives small groups all their
 * rows and shares the remainder between large groups; flattening afterward
 * preserves the required Agents -> Tasks -> Attention order. */
function balancedNamedCandidates(
  groups: readonly (readonly ComposerAutocompleteCandidate[])[],
  limit: number,
): ComposerAutocompleteCandidate[] {
  const counts = groups.map(() => 0);
  let remaining = Math.max(0, Math.trunc(limit));
  while (remaining > 0) {
    let progressed = false;
    for (const [index, group] of groups.entries()) {
      if (counts[index]! >= group.length) continue;
      counts[index] += 1;
      remaining -= 1;
      progressed = true;
      if (remaining === 0) break;
    }
    if (!progressed) break;
  }
  return groups.flatMap((group, index) => group.slice(0, counts[index]));
}

/** Name/id-shaped input can refer to any small named set. A slash, dot, line
 * selector, or other path punctuation is definitive Files grammar. Leading
 * `#`/`?` remain accepted as optional narrowing hints even though `@` is the
 * only trigger. */
export function isNamedReferenceQuery(query: string): boolean {
  return /^(?:[A-Za-z0-9-]*|[#?][A-Za-z0-9-]*)$/u.test(query);
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
      const { directory, leaf, selector } = splitFileReferenceQuery(query);
      let listing = cache.get(directory);
      if (!listing) {
        listing = await fsApi.list(sessionId, directory, signal);
        if (!signal.aborted) cache.set(directory, listing);
      }
      const candidates = listing.entries.map((entry): ComposerAutocompleteCandidate => {
        const path = joinRel(directory, entry.name);
        const refusal = fileRefusal(entry);
        const directoryEntry = entry.type === 'dir';
        const selectorRefusal = !selector.valid
          ? 'line selection must use positive lines and an end at or after its start'
          : directoryEntry && selector.suffix
            ? 'line selection applies to files, not folders'
            : undefined;
        const disabledReason = refusal ?? selectorRefusal;
        return {
          id: `file:${path}${directoryEntry ? '' : selector.suffix}`,
          kind: directoryEntry ? 'directory' : 'file',
          label: `${entry.name}${directoryEntry ? '' : selector.suffix}`,
          detail:
            disabledReason ??
            (directoryEntry ? 'Folder' : entry.type === 'symlink' ? 'Symlink' : `${path}${selector.suffix}`),
          keywords: path,
          group: 'Files',
          replacement: `@${path}${directoryEntry ? '/' : selector.suffix}`,
          append: directoryEntry || (selector.suffix && !selector.complete) ? 'none' : 'space',
          disabled: !!disabledReason,
          disabledReason,
        };
      });
      const lineHelp = selector.suffix
        ? selector.complete
          ? undefined
          : 'Finish the optional line selection (:LINE, :START-END, or :LINE:COL).'
        : 'Optional: add :LINE or :START-END before accepting the file.';
      const bounded = listing.truncated ? '2,000 entries shown — enter a directory or refine this segment.' : undefined;
      const notice = [bounded, lineHelp].filter(Boolean).join(' ');
      return {
        candidates,
        filterQuery: leaf,
        contextLabel: directory ? `@${directory}/` : '@ session root',
        notice: notice || undefined,
      };
    },
  };
}

export function createReferencesProvider({
  sessionId,
  getSessions = noSessions,
  getTasks = noTasks,
  getAttentionItems = noAttention,
  waitForTasks,
  waitForAttentionItems,
}: {
  sessionId: string;
  getSessions?: () => readonly SessionView[];
  getTasks?: () => readonly ComposerTaskSummary[];
  getAttentionItems?: () => readonly ComposerAttentionItem[];
  waitForTasks?: () => Promise<void> | undefined;
  waitForAttentionItems?: () => Promise<void> | undefined;
}): ComposerAutocompleteProvider {
  const files = createFilesProvider(sessionId);
  let previousSessions: readonly SessionView[] | undefined;
  let previousTasks: readonly ComposerTaskSummary[] | undefined;
  let previousAttention: readonly ComposerAttentionItem[] | undefined;
  let snapshotToken = {};

  const named = (query: string, limit?: number): ComposerAutocompleteCandidate[] => {
    if (!isNamedReferenceQuery(query)) return [];
    const groups = [
      agentCandidates(getSessions(), query),
      taskCandidates(getTasks()),
      attentionCandidates(getAttentionItems()),
    ];
    return limit === undefined ? groups.flat() : balancedNamedCandidates(groups, limit);
  };

  return {
    id: `references:${sessionId}`,
    trigger: '@',
    label: 'References',
    get snapshotKey() {
      const sessions = getSessions();
      const tasks = getTasks();
      const attention = getAttentionItems();
      if (sessions !== previousSessions || tasks !== previousTasks || attention !== previousAttention) {
        previousSessions = sessions;
        previousTasks = tasks;
        previousAttention = attention;
        snapshotToken = {};
      }
      return snapshotToken;
    },
    reset: files.reset,
    initialCandidates: context =>
      isNamedReferenceQuery(context.query)
        ? {
            candidates: named(context.query, context.query === '' ? BARE_NAMED_RESULT_BUDGET : undefined),
            filterQuery: context.query,
            contextLabel: 'Fleet references · files loading',
          }
        : undefined,
    async candidates(context): Promise<ComposerProviderResult> {
      const namedQuery = isNamedReferenceQuery(context.query);
      const warmups = namedQuery
        ? [waitForTasks?.(), waitForAttentionItems?.()].filter(
            (pending): pending is Promise<void> => pending !== undefined,
          )
        : [];
      const warmed = Promise.all(warmups.map(pending => pending.catch(() => undefined)));
      let fileResult: ComposerProviderResult;
      try {
        fileResult = await files.candidates(context);
      } catch (error) {
        await warmed;
        if ((error as { name?: string })?.name === 'AbortError') throw error;
        const candidates = named(context.query, context.query === '' ? MAX_AUTOCOMPLETE_RESULTS : undefined);
        if (candidates.length === 0) throw error;
        return {
          candidates,
          filterQuery: context.query,
          contextLabel: 'Fleet references',
          notice: `Files unavailable: ${error instanceof Error ? error.message : String(error)}.`,
        };
      }
      await warmed;
      const namedLimit =
        context.query === ''
          ? MAX_AUTOCOMPLETE_RESULTS - Math.min(BARE_FILE_RESULT_RESERVE, fileResult.candidates.length)
          : undefined;
      const candidates = named(context.query, namedLimit);
      return {
        ...fileResult,
        candidates: [...candidates, ...fileResult.candidates],
        contextLabel: candidates.length > 0 ? `Fleet · ${fileResult.contextLabel ?? 'files'}` : fileResult.contextLabel,
      };
    },
  };
}

export function createComposerAutocompleteProviders({
  sessionId,
  harness,
  getSessions = noSessions,
  getTasks = noTasks,
  getAttentionItems = noAttention,
  waitForTasks,
  waitForAttentionItems,
}: {
  sessionId: string;
  harness?: ComposerHarness;
  getSessions?: () => readonly SessionView[];
  getTasks?: () => readonly ComposerTaskSummary[];
  getAttentionItems?: () => readonly ComposerAttentionItem[];
  waitForTasks?: () => Promise<void> | undefined;
  waitForAttentionItems?: () => Promise<void> | undefined;
}): ComposerAutocompleteProvider[] {
  return [
    createSkillsProvider(sessionId, harness),
    createReferencesProvider({
      sessionId,
      getSessions,
      getTasks,
      getAttentionItems,
      waitForTasks,
      waitForAttentionItems,
    }),
  ];
}
