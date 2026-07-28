import path from 'path';
import { run } from './io';

/** A model/effort pair as advertised by the harness that owns the session.
 * These values are opaque ids: callers display the labels but send the values
 * back unchanged. */
export interface RuntimeReasoningChoice {
  value: string;
  description?: string;
}

export interface RuntimeModelChoice {
  value: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  reasoningEfforts: RuntimeReasoningChoice[];
  defaultReasoningEffort?: string;
}

export interface RuntimeModelCatalog {
  harness: 'claude' | 'codex';
  source: 'wrapper-inventory' | 'codex-app-server';
  choices: RuntimeModelChoice[];
}

interface ModelListPage {
  choices: RuntimeModelChoice[];
  nextCursor?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Parse one model/list response without assuming the catalog's model or
 * effort vocabulary. Array order is authoritative and intentionally retained. */
export function parseCodexModelListPage(message: unknown): ModelListPage {
  const envelope = object(message);
  const error = object(envelope?.error);
  if (error) {
    const detail = string(error.message) ?? 'unknown app-server error';
    throw new Error(`Codex model catalog request failed: ${detail}`);
  }
  const result = object(envelope?.result);
  if (!result || !Array.isArray(result.data)) throw new Error('Codex model/list returned an invalid response');

  const choices: RuntimeModelChoice[] = [];
  for (const raw of result.data) {
    const item = object(raw);
    if (!item || item.hidden === true) continue;
    // `model` is the thread/settings/update value. `id` is catalog-internal
    // metadata and must never be promoted into a selectable runtime setting.
    const value = string(item.model);
    if (!value) continue;
    const label = string(item.displayName) ?? value;
    const reasoningEfforts: RuntimeReasoningChoice[] = [];
    if (Array.isArray(item.supportedReasoningEfforts)) {
      for (const rawEffort of item.supportedReasoningEfforts) {
        const effort = object(rawEffort);
        const effortValue = string(effort?.reasoningEffort);
        if (!effortValue || reasoningEfforts.some(candidate => candidate.value === effortValue)) continue;
        reasoningEfforts.push({
          value: effortValue,
          ...(string(effort?.description) ? { description: string(effort?.description) } : {}),
        });
      }
    }
    const defaultReasoningEffort = string(item.defaultReasoningEffort);
    // Protocol v2 always supplies a default. Retaining it as the sole choice
    // is still safer than inventing a scale if an older/custom provider omits
    // supportedReasoningEfforts.
    if (reasoningEfforts.length === 0 && defaultReasoningEffort)
      reasoningEfforts.push({ value: defaultReasoningEffort });
    choices.push({
      value,
      label,
      ...(string(item.description) ? { description: string(item.description) } : {}),
      ...(item.isDefault === true ? { isDefault: true } : {}),
      reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }

  return { choices, ...(string(result.nextCursor) ? { nextCursor: string(result.nextCursor) } : {}) };
}

const PROBE_TIMEOUT_MS = 10_000;

/** Ask the selected wrapper's own Codex app-server for model/list. This is an
 * ephemeral catalog probe, not a second owner for the running TUI thread. It
 * uses the same wrapper, CODEX_HOME, provider config and cwd, so the returned
 * choices are the ones Codex itself would build its picker from. */
export async function probeCodexRuntimeModels(
  binary: string,
  cwd: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<RuntimeModelChoice[]> {
  if (!path.isAbsolute(binary)) throw new Error('Codex model probe requires an absolute wrapper path');
  if (!path.isAbsolute(cwd)) throw new Error('Codex model probe requires an absolute session cwd');

  const child = Bun.spawn([binary, 'app-server', '--stdio'], {
    cwd,
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderrPromise = new Response(child.stderr).text();
  const decoder = new TextDecoder();
  let buffer = '';
  let initialized = false;
  let requestId = 2;
  let waitingFor = requestId;
  let timedOut = false;
  let completed = false;
  const choices: RuntimeModelChoice[] = [];
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  send({
    method: 'initialize',
    id: 1,
    params: { clientInfo: { name: 'kteam', title: 'kteam', version: '0.2.1' } },
  });

  try {
    outer: for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          throw new Error('Codex app-server wrote a non-JSON model catalog response');
        }
        const envelope = object(message);
        const id = typeof envelope?.id === 'number' ? envelope.id : undefined;
        if (id === 1 && !initialized) {
          if (envelope?.error) parseCodexModelListPage(message);
          initialized = true;
          send({ method: 'initialized', params: {} });
          send({ method: 'model/list', id: waitingFor, params: { includeHidden: false, limit: 100 } });
          continue;
        }
        if (id !== waitingFor) continue;
        const page = parseCodexModelListPage(message);
        for (const choice of page.choices)
          if (!choices.some(candidate => candidate.value === choice.value)) choices.push(choice);
        if (page.nextCursor) {
          waitingFor = ++requestId;
          send({
            method: 'model/list',
            id: waitingFor,
            params: { includeHidden: false, limit: 100, cursor: page.nextCursor },
          });
          continue;
        }
        completed = true;
        break outer;
      }
    }
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
    await child.exited.catch(() => undefined);
  }

  const stderr = (await stderrPromise).trim();
  if (timedOut) throw new Error(`Codex model catalog probe timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (!completed) {
    const detail = stderr.split('\n').filter(Boolean).at(-1);
    throw new Error(`Codex model catalog probe exited before model/list completed${detail ? `: ${detail}` : ''}`);
  }
  if (choices.length === 0) throw new Error('Codex did not advertise any selectable runtime models');
  return choices;
}

interface CatalogCacheEntry {
  expiresAt: number;
  value?: RuntimeModelChoice[];
  pending?: Promise<RuntimeModelChoice[]>;
}

/** Codex's own on-disk model cache uses a five-minute TTL. Mirror that bound
 * for the daemon probe and coalesce simultaneous browser opens. */
export class CodexRuntimeModelCatalogCache {
  private readonly entries = new Map<string, CatalogCacheEntry>();

  constructor(
    private readonly load: (binary: string, cwd: string) => Promise<RuntimeModelChoice[]> = probeCodexRuntimeModels,
    private readonly ttlMs = 300_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(binary: string, cwd: string): Promise<RuntimeModelChoice[]> {
    const key = `${binary}\0${cwd}`;
    const cached = this.entries.get(key);
    const at = this.clock();
    if (cached?.value && cached.expiresAt > at) return cached.value;
    if (cached?.pending) return await cached.pending;

    const pending = this.load(binary, cwd);
    this.entries.set(key, { expiresAt: 0, pending });
    try {
      const value = await pending;
      this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
      return value;
    } catch (error) {
      if (this.entries.get(key)?.pending === pending) this.entries.delete(key);
      throw error;
    }
  }
}

export const codexRuntimeModelCatalog = new CodexRuntimeModelCatalogCache();

export type CodexPickerKind =
  | 'quick-models'
  | 'all-models'
  | 'reasoning'
  | 'advanced-reasoning'
  | 'plan-scope'
  | 'none';

export interface CodexPickerRow {
  number: number;
  name: string;
}

export interface CodexPickerScreen {
  kind: CodexPickerKind;
  title?: string;
  rows: CodexPickerRow[];
}

export interface CodexPickerKeyExpectation {
  kind: CodexPickerKind;
  title?: string;
  row: CodexPickerRow;
}

const PICKER_TITLES: Array<{ kind: Exclude<CodexPickerKind, 'none'>; matches: (line: string) => boolean }> = [
  { kind: 'all-models', matches: line => line === 'Select Model and Effort' },
  { kind: 'reasoning', matches: line => line.startsWith('Select Reasoning Level for ') },
  { kind: 'advanced-reasoning', matches: line => line === 'Advanced Reasoning' },
  { kind: 'plan-scope', matches: line => line === 'Apply reasoning change' },
  { kind: 'quick-models', matches: line => line === 'Select Model' },
];

function cleanPickerRowName(value: string): string {
  // SelectionView renders an optional description in a second column. tmux
  // capture-pane flattens both columns onto one line, separated by at least
  // two spaces; only the first column is the selectable row name. If a future
  // renderer wraps/truncates that name, exact matching below fails visibly.
  let cleaned = value
    .trim()
    .split(/\s{2,}/u, 1)[0]!
    .trim();
  for (;;) {
    const next = cleaned.replace(/\s+\((?:current|default)\)\s*$/i, '').trim();
    if (next === cleaned) return cleaned;
    cleaned = next;
  }
}

/** Read only the currently visible picker (the last matching title), so a
 * numbered list in transcript scrollback can never be mistaken for a target. */
export function parseCodexPickerScreen(pane: string): CodexPickerScreen {
  const lines = pane.split('\n');
  let titleIndex = -1;
  let kind: CodexPickerKind = 'none';
  let title: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const match = PICKER_TITLES.find(candidate => candidate.matches(line));
    if (!match) continue;
    titleIndex = index;
    kind = match.kind;
    title = line;
  }
  if (titleIndex < 0) return { kind: 'none', rows: [] };

  // A picker title can remain in scrollback after Codex has returned to its
  // composer. A prompt-looking line below the title proves the old numbered
  // rows are not an actionable current screen.
  if (lines.slice(titleIndex + 1).some(line => /^\s*[│|]?\s*[>›❯»](?!\s*\d+[.)])(?:[\s\u00a0].*)?$/u.test(line)))
    return { kind: 'none', rows: [] };

  const rows: CodexPickerRow[] = [];
  for (const line of lines.slice(titleIndex + 1)) {
    const match = line.match(/^\s*(?:[›>]\s*)?(\d+)\.\s+(.+?)\s*$/u);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    rows.push({ number, name: cleanPickerRowName(match[2]!) });
  }
  return { kind, title, rows };
}

export function codexPickerMatchesExpectation(pane: string, expected: CodexPickerKeyExpectation): boolean {
  const current = parseCodexPickerScreen(pane);
  return (
    current.kind === expected.kind &&
    current.title === expected.title &&
    current.rows.some(row => row.number === expected.row.number && row.name === expected.row.name)
  );
}

export interface CodexPickerPane {
  alive: boolean;
  dead: boolean;
  promptReady: boolean;
  visiblePane: string;
}

export interface CodexPickerTransport {
  openPicker: () => Promise<'handled-local' | 'turn-started'>;
  readPane: () => Promise<CodexPickerPane>;
  sendKey: (key: string, expected: CodexPickerKeyExpectation) => Promise<void>;
}

export interface CodexPickerTarget {
  model: string;
  effort: string;
}

interface DriverOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function effortLabel(effort: string): string {
  const labels: Record<string, string> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
    ultra: 'Ultra',
  };
  return labels[effort] ?? effort;
}

function rowFor(screen: CodexPickerScreen, name: string): CodexPickerRow | undefined {
  const wanted = name.trim().toLocaleLowerCase();
  return screen.rows.find(row => row.name.toLocaleLowerCase() === wanted);
}

async function waitForPicker(
  transport: CodexPickerTransport,
  accept: (screen: CodexPickerScreen, pane: CodexPickerPane) => boolean,
  options: Required<DriverOptions>,
  stage: string,
): Promise<{ screen: CodexPickerScreen; pane: CodexPickerPane }> {
  const deadline = Date.now() + options.timeoutMs;
  let last = 'no picker';
  while (Date.now() < deadline) {
    const pane = await transport.readPane();
    if (!pane.alive || pane.dead) throw new Error(`Codex exited while ${stage}`);
    const screen = parseCodexPickerScreen(pane.visiblePane);
    last = screen.title ?? (pane.promptReady ? 'idle prompt' : 'unknown screen');
    if (accept(screen, pane)) return { screen, pane };
    await options.sleep(options.pollMs);
  }
  throw new Error(
    `Codex picker did not reach ${stage} within ${Math.round(options.timeoutMs / 1000)}s (last: ${last})`,
  );
}

async function chooseVisibleRow(
  transport: CodexPickerTransport,
  screen: CodexPickerScreen,
  name: string,
  stage: string,
): Promise<void> {
  const row = rowFor(screen, name);
  if (!row) throw new Error(`Codex picker did not advertise ${name} on ${stage}`);
  // Codex's native list accepts only single digit direct shortcuts. Do not
  // degrade into an arrow-counting algorithm if a future catalog grows beyond
  // that: failing visibly is safer than selecting the wrong model.
  if (row.number > 9) throw new Error(`Codex picker row ${row.number} for ${name} is not safely addressable`);
  await transport.sendKey(String(row.number), { kind: screen.kind, title: screen.title, row });
}

/** Drive Codex's native picker without arrows, Enter, or assumed ordering.
 * Every digit is derived from an exact row on a positively identified current
 * screen. The caller must still verify the resulting rollout observation. */
export async function driveCodexModelPicker(
  transport: CodexPickerTransport,
  target: CodexPickerTarget,
  options: DriverOptions = {},
): Promise<void> {
  const resolved: Required<DriverOptions> = {
    timeoutMs: options.timeoutMs ?? 4_000,
    pollMs: options.pollMs ?? 50,
    sleep: options.sleep ?? Bun.sleep,
  };
  const opened = await transport.openPicker();
  if (opened !== 'handled-local')
    throw new Error('Codex consumed /model as a model turn instead of opening its native picker');
  let { screen } = await waitForPicker(
    transport,
    (candidate, pane) => !pane.promptReady && (candidate.kind === 'quick-models' || candidate.kind === 'all-models'),
    resolved,
    'a model list',
  );

  if (screen.kind === 'quick-models' && !rowFor(screen, target.model)) {
    await chooseVisibleRow(transport, screen, 'All models', 'the quick model list');
    ({ screen } = await waitForPicker(
      transport,
      candidate => candidate.kind === 'all-models',
      resolved,
      'the full model list',
    ));
  }
  await chooseVisibleRow(transport, screen, target.model, 'the model list');

  let next = await waitForPicker(
    transport,
    (candidate, pane) =>
      candidate.kind === 'reasoning' ||
      candidate.kind === 'plan-scope' ||
      (candidate.kind === 'none' && pane.promptReady),
    resolved,
    `reasoning choices for ${target.model}`,
  );
  if (next.screen.kind === 'reasoning') {
    const label = effortLabel(target.effort);
    if (target.effort === 'max' || target.effort === 'ultra') {
      await chooseVisibleRow(transport, next.screen, 'More reasoning…', `reasoning choices for ${target.model}`);
      next = await waitForPicker(
        transport,
        candidate => candidate.kind === 'advanced-reasoning',
        resolved,
        'advanced reasoning choices',
      );
    }
    await chooseVisibleRow(transport, next.screen, label, `reasoning choices for ${target.model}`);
    next = await waitForPicker(
      transport,
      (candidate, pane) => candidate.kind === 'plan-scope' || candidate.kind === 'none' || pane.promptReady,
      resolved,
      'the applied setting',
    );
  }
  if (next.screen.kind === 'plan-scope') {
    await chooseVisibleRow(
      transport,
      next.screen,
      'Apply to global default and Plan mode override',
      'the Plan-mode scope prompt',
    );
  }
}

/** A single literal picker shortcut through argv-safe tmux invocation. */
export async function sendTmuxPickerKey(
  tmuxSession: string,
  key: string,
  expected: CodexPickerKeyExpectation,
): Promise<void> {
  if (!/^[1-9]$/.test(key)) throw new Error(`refusing unsafe Codex picker key: ${key}`);
  if (expected.row.number !== Number(key)) throw new Error('Codex picker shortcut no longer matches the verified row');
  const resolved = await run(['tmux', 'display-message', '-p', '-t', tmuxSession, '#{pane_id}']);
  const paneId = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^%\d+$/.test(paneId))
    throw new Error(resolved.stderr.trim() || 'failed to resolve the Codex picker pane');
  const captured = await run(['tmux', 'capture-pane', '-p', '-t', paneId]);
  if (captured.code !== 0 || !codexPickerMatchesExpectation(captured.stdout, expected))
    throw new Error('Codex picker changed before the verified shortcut could be sent');
  // Target the exact pane we just re-read, not whichever pane later becomes
  // active in the tmux session.
  const sent = await run(['tmux', 'send-keys', '-t', paneId, key]);
  if (sent.code !== 0) throw new Error(sent.stderr.trim() || 'failed to drive the Codex picker');
}

export interface RuntimeObservation {
  observedModel?: string;
  observedReasoningEffort?: string;
  observedModelAt?: string;
  transcriptOffset?: number;
  status?: string;
}

export interface CodexThreadSettingsApplied {
  model: string;
  effort: string;
}

/** Parse only the picker acknowledgement, not turn_context recovery records.
 * The raw rollout boundary lets the controller attribute success to bytes that
 * Codex appended after this exact picker gesture. */
export function parseCodexThreadSettingsAppliedLine(line: string): CodexThreadSettingsApplied | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const root = object(parsed);
  const payload = object(root?.payload);
  const settings = object(payload?.thread_settings);
  if (root?.type !== 'event_msg' || payload?.type !== 'thread_settings_applied' || !settings) return undefined;
  const model = string(settings.model);
  const effort = string(settings.reasoning_effort);
  return model && effort ? { model, effort } : undefined;
}

interface AppliedObservationOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Wait on bytes after the caller's pre-input rollout size. A conflicting
 * applied event is a named failure immediately; it is never allowed to age
 * into a generic timeout or be superseded by a later record. */
export async function waitForCodexThreadSettingsApplied(
  readAppended: () => Promise<string>,
  target: CodexPickerTarget,
  options: AppliedObservationOptions = {},
): Promise<CodexThreadSettingsApplied> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const appended = await readAppended();
    for (const line of appended.split('\n')) {
      const applied = parseCodexThreadSettingsAppliedLine(line);
      if (!applied) continue;
      if (applied.model === target.model && applied.effort === target.effort) return applied;
      throw new Error(
        `Codex reported ${applied.model} · ${applied.effort} instead of ${target.model} · ${target.effort}`,
      );
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Codex did not write thread_settings_applied for ${target.model} · ${target.effort} within ${Math.round(timeoutMs / 1000)}s`,
  );
}

interface ObservationOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Byte size of the rollout captured immediately before opening /model.
   * Confirmation must come from a record appended beyond this baseline. */
  afterTranscriptOffset?: number;
}

/** Require a post-baseline exact model+effort observation. A matching old value
 * is not confirmation; same-value switches are proven by observedModelAt. */
export async function waitForCodexRuntimeObservation(
  read: () => Promise<RuntimeObservation>,
  beforeObservedAt: string | undefined,
  target: CodexPickerTarget,
  options: ObservationOptions = {},
): Promise<RuntimeObservation> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + timeoutMs;
  let last: RuntimeObservation = {};
  while (Date.now() < deadline) {
    last = await read();
    const freshTimestamp = Boolean(last.observedModelAt && last.observedModelAt !== beforeObservedAt);
    const freshTranscript =
      options.afterTranscriptOffset === undefined ||
      (last.transcriptOffset !== undefined && last.transcriptOffset > options.afterTranscriptOffset);
    const fresh = freshTimestamp && freshTranscript;
    if (fresh && last.observedModel === target.model && last.observedReasoningEffort === target.effort) return last;
    if (fresh) {
      const observed = `${last.observedModel ?? 'unknown model'} · ${last.observedReasoningEffort ?? 'unknown effort'}`;
      throw new Error(`Codex reported ${observed} instead of ${target.model} · ${target.effort}`);
    }
    if (last.status && ['completed', 'failed', 'stopped', 'stalled'].includes(last.status))
      throw new Error(`Codex ended before confirming ${target.model} · ${target.effort}`);
    await sleep(pollMs);
  }
  const observed = `${last.observedModel ?? 'unknown model'} · ${last.observedReasoningEffort ?? 'unknown effort'}`;
  throw new Error(
    `Codex did not confirm ${target.model} · ${target.effort} within ${Math.round(timeoutMs / 1000)}s (last observed: ${observed})`,
  );
}
