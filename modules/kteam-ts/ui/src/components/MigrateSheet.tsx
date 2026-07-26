import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  RefreshCw,
  ServerCog,
  ShieldAlert,
} from 'lucide-react';
import type { ChatRecord, SessionView, WrapperInfo } from '../types';
import { api, ApiError, type MigrateSessionTarget } from '../lib/api';
import { cn, fmtAge, isBusy, TERMINAL_STATUSES } from '../lib/utils';
import { BottomSheet } from './SessionDetails';
import { Badge, Button } from './Primitives';

const CHAT_PAGE_SIZE = 500;
const MAX_CHAT_PAGES = 8;
const SMALL_CONTEXT_WINDOW = 200_000;
const LARGE_CONTEXT_WINDOW = 1_000_000;
const DOWNGRADE_REFUSAL = 'refusing context-window downgrade';

export type InflightVerdict = 'safe_to_kill' | 're_armable' | 'destructive_to_interrupt' | 'unknown';

export interface OpenToolDetail {
  toolUseId: string;
  name: string;
  summary: string;
  verdict: InflightVerdict;
  startedAt?: string;
}

export interface InflightItem {
  key: string;
  label: string;
  detail: string;
  verdict: InflightVerdict;
}

interface Props {
  view: SessionView;
  open: boolean;
  onClose: () => void;
}

interface ContextState {
  contextTokens?: number;
  contextWindow?: number;
}

interface Failure {
  message: string;
  restoredStopped: boolean;
}

interface RequestIdentity {
  key: string;
  id: string;
}

function requestIdFor(current: RequestIdentity | null, key: string): RequestIdentity {
  return current?.key === key ? current : { key, id: crypto.randomUUID() };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shortened(value: string, max = 320): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') {
    const command = commandFrom(input);
    return shortened(command) || 'No input was recorded.';
  }
  const object = asRecord(input);
  if (object) {
    for (const key of ['command', 'cmd', 'query', 'pattern', 'path', 'file_path']) {
      if (typeof object[key] === 'string' && object[key].trim()) return shortened(object[key]);
    }
  }
  try {
    const json = JSON.stringify(input);
    return json ? shortened(json) : 'No input was recorded.';
  } catch {
    return 'The tool input could not be read.';
  }
}

function commandFrom(input: unknown): string {
  if (typeof input === 'string') {
    const value = input.trim();
    if (!value) return '';
    if (value.includes('tools.exec_command')) {
      const commands = [...value.matchAll(/"cmd"\s*:\s*("(?:\\.|[^"\\])*")/g)]
        .map(match => {
          try {
            return JSON.parse(match[1]!) as string;
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      if (commands.length > 0) return commands.join(' && ');
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== value) {
        const nested = commandFrom(parsed);
        if (nested) return nested;
      }
    } catch {
      // Raw shell or orchestration source: the conservative classifier below
      // sees the whole value and leaves anything outside its table unknown.
    }
    return value;
  }
  const object = asRecord(input);
  if (!object) return '';
  for (const key of ['command', 'cmd']) {
    if (typeof object[key] === 'string') return object[key];
  }
  return '';
}

/** Deterministic and deliberately conservative. A destructive token anywhere
 * in a pipeline wins; commands outside the table remain unknown and therefore
 * require the explicit in-flight override. */
export function classifyCommand(command: string): InflightVerdict {
  const value = command.trim().toLowerCase();
  if (!value) return 'unknown';

  const destructive = [
    /\bgit\s+(?:commit|rebase|merge|push|pull|cherry-pick|reset|clean|checkout|switch)\b/,
    /\b(?:bun|npm|pnpm|yarn)\s+(?:add|install|remove|uninstall|update|upgrade)\b/,
    /\b(?:nix|hms|home-manager|darwin-rebuild)\b/,
    /\b(?:terraform|tofu)\s+(?:apply|destroy|import|state|taint|untaint)\b/,
    /\b(?:kubectl|helm|argocd|loctl)\b/,
    /\b(?:sops|rsync)\b/,
    /(?:^|[;&|]\s*)rm\s/,
    /(?:^|[;&|]\s*)mv\s/,
    /\bdeploy(?:ment|ing)?\b/,
    /\bgh\s+pr\s+(?:create|merge|close|reopen)\b/,
  ];
  if (
    destructive.some(pattern => pattern.test(value)) ||
    /\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command)
  )
    return 'destructive_to_interrupt';

  // A file redirection can turn an otherwise read-only command into a write.
  // The one commonplace exception is discarding diagnostics to /dev/null.
  const withoutDevNull = value.replace(/\d*>{1,2}\s*\/dev\/null\b/g, '');
  if (/[<>]/.test(withoutDevNull)) return 'unknown';

  const segments = withoutDevNull
    .split(/&&|\|\||[;|]/)
    .map(segment => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return 'unknown';

  let strongest: InflightVerdict = 'safe_to_kill';
  for (const segment of segments) {
    if (/^cd\s+\S+$/.test(segment) || /^(?:export\s+)?[a-z_][a-z0-9_]*=\S+$/i.test(segment)) continue;
    const executable = segment
      .replace(/^(?:[a-z_][a-z0-9_]*=\S+\s+)+/i, '')
      .replace(/^env\s+(?:[a-z_][a-z0-9_]*=\S+\s+)*/i, '')
      .replace(/^direnv\s+exec\s+\S+\s+/, '')
      .trim();

    const reArmable = [
      /^(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|typecheck|lint|build))\b/,
      /^(?:tsc|eslint|vitest|jest|pytest|cargo\s+test|go\s+test)\b/,
      /^(?:vite|webpack|rollup|esbuild)\s+build\b/,
    ];
    if (reArmable.some(pattern => pattern.test(executable))) {
      strongest = 're_armable';
      continue;
    }

    const safe = [/^(?:rg|grep|fd|find|ls|cat|jq|tail|head|sleep)\b/, /^sed\s+-n\b/, /^(?:pwd|wc|stat|readlink)\b/];
    if (safe.some(pattern => pattern.test(executable))) continue;
    return 'unknown';
  }
  return strongest;
}

export function classifyTool(name: string, input: unknown): InflightVerdict {
  const normalized = name.trim().toLowerCase();
  if (['read', 'grep', 'glob', 'ls', 'search'].includes(normalized)) return 'safe_to_kill';
  if (['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch'].includes(normalized))
    return 'destructive_to_interrupt';
  if (['bash', 'shell', 'exec', 'exec_command'].includes(normalized)) return classifyCommand(commandFrom(input));
  return 'unknown';
}

function toolUse(record: ChatRecord): { id: string; name: string; input: unknown; startedAt?: string } | null {
  if (record.type !== 'tool.use') return null;
  const data = asRecord(record.data);
  if (!data) return null;
  const id = typeof data.toolUseId === 'string' ? data.toolUseId : typeof data.id === 'string' ? data.id : '';
  if (!id) return null;
  return {
    id,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Unknown tool',
    input: data.input,
    ...(record.timestamp ? { startedAt: record.timestamp } : {}),
  };
}

export function joinOpenTools(openToolIds: readonly string[], records: readonly ChatRecord[]): OpenToolDetail[] {
  const uses = new Map<string, ReturnType<typeof toolUse>>();
  for (let index = records.length - 1; index >= 0; index--) {
    const use = toolUse(records[index]!);
    if (use && !uses.has(use.id)) uses.set(use.id, use);
  }
  return openToolIds.map(toolUseId => {
    const use = uses.get(toolUseId);
    if (!use) {
      return {
        toolUseId,
        name: 'Unknown open tool',
        summary: 'The chat tail did not contain this tool’s command or input.',
        verdict: 'unknown',
      };
    }
    return {
      toolUseId,
      name: use.name,
      summary: summarizeToolInput(use.input),
      verdict: classifyTool(use.name, use.input),
      ...(use.startedAt ? { startedAt: use.startedAt } : {}),
    };
  });
}

export function contextWindowForModel(model: string): number | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.includes('[1m]') ? LARGE_CONTEXT_WINDOW : SMALL_CONTEXT_WINDOW;
}

export function oneMillionVariant(model: string): string {
  const value = model.trim();
  if (!value || value.toLowerCase().includes('[1m]')) return value;
  return `${value}[1m]`;
}

function withoutOneMillionVariant(model: string): string {
  return model.replace(/\[1m\]/gi, '').trim();
}

function verdictLabel(verdict: InflightVerdict): string {
  switch (verdict) {
    case 'safe_to_kill':
      return 'safe to stop';
    case 're_armable':
      return 're-runnable';
    case 'destructive_to_interrupt':
      return 'destructive to interrupt';
    case 'unknown':
      return 'unknown risk';
  }
}

function blocksMigration(verdict: InflightVerdict): boolean {
  return verdict === 'destructive_to_interrupt' || verdict === 'unknown';
}

function routingCaution(wrapper: WrapperInfo): string | null {
  return /(mm3|minimax|dsv4|glm52)/i.test(wrapper.name)
    ? 'Restricted tier — check the routing policy before moving product-facing work here.'
    : null;
}

export function buildInflightItems(
  view: SessionView,
  tools: readonly OpenToolDetail[],
  toolLoadError: string | null,
): InflightItem[] {
  const items: InflightItem[] = [];
  if (isBusy(view)) {
    items.push({
      key: 'turn',
      label: `Turn ${view.state.turn} is active`,
      detail: `Status: ${view.state.status.replace(/_/g, ' ')}. The current turn will be interrupted and relaunched.`,
      verdict: 're_armable',
    });
  }
  for (const tool of tools) {
    items.push({
      key: `tool:${tool.toolUseId}`,
      label: tool.name,
      detail: `${tool.summary}${tool.startedAt ? ` · started ${fmtAge(tool.startedAt)} ago` : ''}`,
      verdict: tool.verdict,
    });
  }
  if (toolLoadError) {
    items.push({
      key: 'tool-load-error',
      label: 'Open-tool inventory is incomplete',
      detail: toolLoadError,
      verdict: 'unknown',
    });
  }
  if (view.state.subprocessSince) {
    items.push({
      key: 'subprocess',
      label: 'A subprocess is running',
      detail: `The subprocess signal has stayed active for ${fmtAge(view.state.subprocessSince)}. The browser cannot inspect its process tree, so it may include background work not represented above.`,
      verdict: 'unknown',
    });
  }
  return items;
}

export function migrationHandoff(items: readonly InflightItem[], agent: string, model: string): string {
  const target = `${agent}${model.trim() ? ` on ${model.trim()}` : ''}`;
  return [
    `Safety handoff: this session was migrated mid-turn to ${target}.`,
    'Before re-running anything, inspect the workspace and verify whether interrupted work partially applied.',
    'In flight immediately before migration:',
    ...items.map(item => `- [${verdictLabel(item.verdict)}] ${item.label}: ${item.detail}`),
    'Re-run re-runnable work only if it is still needed. For destructive or unknown work, inspect state first; do not blindly repeat the command.',
  ].join('\n');
}

async function loadOpenTools(sessionId: string, openToolIds: readonly string[]): Promise<OpenToolDetail[]> {
  if (openToolIds.length === 0) return [];
  const records: ChatRecord[] = [];
  let before: number | undefined;
  for (let pageNumber = 0; pageNumber < MAX_CHAT_PAGES; pageNumber++) {
    const page = await api.chatHistory(sessionId, before, CHAT_PAGE_SIZE);
    records.unshift(...page.records);
    const joined = joinOpenTools(openToolIds, records);
    if (joined.every(tool => tool.name !== 'Unknown open tool') || page.offset === 0) return joined;
    before = page.offset;
  }
  return joinOpenTools(openToolIds, records);
}

function modelFromDowngradeError(message: string): string | null {
  return message.match(/use --model\s+([^\s]+\[1m\])/i)?.[1] ?? null;
}

function readableNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function verdictTone(verdict: InflightVerdict): string {
  if (verdict === 'destructive_to_interrupt') return 'border-err text-err';
  if (verdict === 'unknown') return 'border-warn-border text-warn';
  if (verdict === 're_armable') return 'border-accent-border text-accent';
  return 'border-ok-border text-ok';
}

function InflightList({ items }: { items: readonly InflightItem[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-sm rounded-control border border-ok-border bg-surface-2 p-3 text-ui text-ok">
        <CheckCircle2 size={16} aria-hidden="true" className="shrink-0" />
        No active turn, open tool, or subprocess signal was detected.
      </div>
    );
  }
  return (
    <div className="grid gap-2" aria-label="Work in flight">
      {items.map(item => (
        <div
          key={item.key}
          className={cn('rounded-control border-l-heavy bg-surface-2 px-3 py-2', verdictTone(item.verdict))}
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-xs">
            <span className="text-ui font-semibold text-fg">{item.label}</span>
            <span className="kt-label shrink-0">{verdictLabel(item.verdict)}</span>
          </div>
          <p className="mt-1 break-words text-meta leading-base text-muted">{item.detail}</p>
        </div>
      ))}
    </div>
  );
}

export function MigrateSheet({ view, open, onClose }: Props) {
  const { config } = view;
  const contextState = view.state as typeof view.state & ContextState;
  const titleId = useId();
  const modelId = useId();
  const modelListId = useId();
  const currentModel = (config.model || config.modelHint || '').trim();
  const [wrappers, setWrappers] = useState<WrapperInfo[]>([]);
  const [wrappersLoading, setWrappersLoading] = useState(false);
  const [wrappersError, setWrappersError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState(config.binary);
  const [model, setModel] = useState(currentModel);
  const [phase, setPhase] = useState<'form' | 'confirm' | 'downgrade' | 'submitting' | 'handoff-failed'>('form');
  const [tools, setTools] = useState<OpenToolDetail[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolLoadError, setToolLoadError] = useState<string | null>(null);
  const [allowContextDowngrade, setAllowContextDowngrade] = useState(false);
  const [forceInflight, setForceInflight] = useState(false);
  const [downgradeMessage, setDowngradeMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [handoffFailure, setHandoffFailure] = useState<string | null>(null);
  const migrateRequestRef = useRef<RequestIdentity | null>(null);
  const handoffRequestRef = useRef<RequestIdentity | null>(null);
  const openToolIds = view.state.openTools ?? [];
  const openToolKey = openToolIds.join('\u0000');

  useEffect(() => {
    if (!open) return;
    setSelectedAgent(config.binary);
    setModel(currentModel);
    setPhase('form');
    setAllowContextDowngrade(false);
    setForceInflight(false);
    setDowngradeMessage(null);
    setFailure(null);
    setHandoffFailure(null);
    migrateRequestRef.current = null;
    handoffRequestRef.current = null;
  }, [open, config.id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setWrappersLoading(true);
    setWrappersError(null);
    void api
      .wrappers()
      .then(result => {
        if (cancelled) return;
        setWrappers(result.filter(wrapper => wrapper.launchable && wrapper.harness === config.harness));
      })
      .catch(error => {
        if (!cancelled) setWrappersError(error instanceof ApiError ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setWrappersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, config.harness, config.id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTools([]);
    setToolLoadError(null);
    setToolsLoading(openToolIds.length > 0);
    void loadOpenTools(config.id, openToolIds)
      .then(result => {
        if (!cancelled) setTools(result);
      })
      .catch(error => {
        if (!cancelled) {
          setToolLoadError(
            `Could not resolve the open tool commands: ${error instanceof ApiError ? error.message : String(error)}`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setToolsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, config.id, openToolKey]);

  const inflightItems = useMemo(() => buildInflightItems(view, tools, toolLoadError), [toolLoadError, tools, view]);
  const blockerKey = inflightItems
    .filter(item => blocksMigration(item.verdict))
    .map(item => `${item.key}:${item.detail}`)
    .join('\u0000');
  const blockers = inflightItems.filter(item => blocksMigration(item.verdict));
  const hasInflightBlockers = blockers.length > 0;

  useEffect(() => setForceInflight(false), [blockerKey]);

  const explicitTargetWindow = contextWindowForModel(model);
  const currentWindow = contextState.contextWindow ?? contextWindowForModel(currentModel);
  const contextTokens = contextState.contextTokens;
  const isContextDowngrade =
    explicitTargetWindow !== undefined && currentWindow !== undefined && explicitTargetWindow < currentWindow;
  const conversationTooLarge =
    explicitTargetWindow !== undefined && contextTokens !== undefined && contextTokens > explicitTargetWindow;
  const normalizedModel = model.trim();
  const sameAccount = selectedAgent === config.binary;
  const noRuntimeChange = sameAccount && (!normalizedModel || normalizedModel === currentModel);
  const selectedWrapperExists = wrappers.some(wrapper => wrapper.name === selectedAgent);
  const preflightReady = !toolsLoading && !wrappersLoading;
  const canReview =
    preflightReady && !wrappersError && selectedWrapperExists && !conversationTooLarge && !noRuntimeChange;
  const terminal = TERMINAL_STATUSES.has(view.state.status);
  const modelSuggestions = [
    ...new Set([currentModel, oneMillionVariant(currentModel), withoutOneMillionVariant(currentModel)]),
  ].filter(Boolean);

  function chooseAgent(wrapper: WrapperInfo) {
    setSelectedAgent(wrapper.name);
    setModel(wrapper.name === config.binary ? currentModel : '');
    setAllowContextDowngrade(false);
    setDowngradeMessage(null);
    setFailure(null);
  }

  function changeModel(next: string) {
    setModel(next);
    setAllowContextDowngrade(false);
    setDowngradeMessage(null);
    setFailure(null);
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReview) return;
    setFailure(null);
    setPhase('confirm');
  }

  async function performMigration(allowDowngrade: boolean) {
    if (phase === 'submitting' || conversationTooLarge || (hasInflightBlockers && !forceInflight)) return;
    const target: MigrateSessionTarget = {
      agent: selectedAgent,
      ...(normalizedModel ? { model: normalizedModel } : {}),
      ...(allowDowngrade ? { allowContextDowngrade: true } : {}),
    };
    const requestKey = JSON.stringify(target);
    migrateRequestRef.current = requestIdFor(migrateRequestRef.current, requestKey);
    setFailure(null);
    setDowngradeMessage(null);
    setPhase('submitting');
    let migrated = false;
    try {
      await api.migrate(config.id, target, migrateRequestRef.current.id);
      migrated = true;
      if (inflightItems.length > 0) {
        const message = migrationHandoff(inflightItems, selectedAgent, normalizedModel);
        handoffRequestRef.current = requestIdFor(handoffRequestRef.current, message);
        await api.send(config.id, message, false, handoffRequestRef.current.id);
      }
      onClose();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      if (migrated) {
        setHandoffFailure(message);
        setPhase('handoff-failed');
      } else if (message.includes(DOWNGRADE_REFUSAL) && !allowDowngrade) {
        setDowngradeMessage(message);
        setPhase('downgrade');
      } else {
        setFailure({ message, restoredStopped: /session restored to .*\(stopped\)/i.test(message) });
        setPhase('confirm');
      }
    }
  }

  const recommendedModel = downgradeMessage ? modelFromDowngradeError(downgradeMessage) : null;

  return (
    <BottomSheet
      id={`migrate-${config.id}`}
      open={open}
      onClose={phase === 'submitting' ? () => undefined : onClose}
      labelledBy={titleId}
      closeLabel="Close change model or account"
      panelClassName="kt-details bg-surface"
      maxHeight="min(94dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <div className="flex items-center gap-sm">
          <ServerCog size={16} aria-hidden="true" className="text-accent" />
          <h1 id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Change model or account
          </h1>
        </div>
        <p className="mt-1 text-ui leading-base text-muted">
          Relaunch this conversation on another same-CLI account or model.
        </p>
      </div>

      {phase === 'submitting' ? (
        <div
          className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-3 px-panel pb-6 text-center"
          aria-live="polite"
        >
          <LoaderCircle size={28} aria-hidden="true" className="animate-spin text-accent" />
          <p className="m-0 text-title font-semibold text-fg">Migrating — stopping the old pane and relaunching…</p>
          <p className="m-0 max-w-xl text-ui leading-base text-muted">
            Keep this sheet open. A large conversation can take tens of seconds to resume.
          </p>
        </div>
      ) : phase === 'handoff-failed' ? (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
          <div className="mx-auto grid w-full max-w-2xl gap-4 py-4">
            <div role="alert" className="rounded-control border border-warn-border bg-surface-2 p-4">
              <div className="flex items-start gap-sm text-warn">
                <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
                <div>
                  <h2 className="m-0 text-title font-semibold text-fg">Migration succeeded; safety handoff failed</h2>
                  <p className="mt-1 text-ui leading-base text-muted">
                    The new pane is running, but the in-flight inventory could not be queued into its conversation.
                  </p>
                </div>
              </div>
              <p className="mt-3 break-words text-ui text-err">{handoffFailure}</p>
            </div>
            <InflightList items={inflightItems} />
            <p className="m-0 text-ui leading-base text-warn">
              Inspect this list and the workspace before re-running anything.
            </p>
            <Button type="button" variant="primary" onClick={onClose} className="min-h-[44px] justify-center">
              Close and inspect session
            </Button>
          </div>
        </div>
      ) : phase === 'form' ? (
        <form noValidate onSubmit={review} className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
          <div className="mx-auto grid w-full max-w-2xl gap-5 py-4">
            <section aria-labelledby={`${titleId}-account-heading`}>
              <h2 id={`${titleId}-account-heading`} className="m-0 text-ui font-semibold text-fg">
                Account
              </h2>
              <p className="mt-1 text-meta leading-base text-muted">
                Only launchable {config.harness} wrappers are shown.
              </p>
              {wrappersLoading ? (
                <div role="status" className="mt-2 flex min-h-[44px] items-center gap-sm text-ui text-muted">
                  <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
                  Loading accounts…
                </div>
              ) : wrappersError ? (
                <div role="alert" className="mt-2 rounded-control border border-err p-3 text-ui text-err">
                  {wrappersError}
                </div>
              ) : (
                <div role="radiogroup" aria-label="Migration account" className="mt-2 grid gap-2">
                  {wrappers.map(wrapper => {
                    const selected = selectedAgent === wrapper.name;
                    const caution = routingCaution(wrapper);
                    return (
                      <label
                        key={wrapper.name}
                        className={cn(
                          'flex min-h-[52px] cursor-pointer items-start gap-sm rounded-control border px-control-x py-2 transition-colors',
                          selected
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-border bg-surface-2 text-fg hover:border-accent',
                        )}
                      >
                        <input
                          type="radio"
                          name={`${titleId}-agent`}
                          value={wrapper.name}
                          checked={selected}
                          onChange={() => chooseAgent(wrapper)}
                          className="mt-1 h-4 w-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 flex-wrap items-center gap-xs">
                            <span className="mono break-all text-ui font-semibold text-fg">{wrapper.name}</span>
                            {wrapper.name === config.binary && <Badge tone="accent">current</Badge>}
                          </span>
                          <span className="mt-0.5 block text-meta leading-base text-muted">
                            {wrapper.modelHint || 'Default model is not exposed by this daemon.'}
                          </span>
                          {caution && <span className="mt-1 block text-meta leading-base text-warn">⚠ {caution}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="mt-2 flex items-start gap-xs text-meta leading-base text-muted">
                <CircleHelp size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                Cross-CLI migration is not offered: Claude and Codex cannot resume each other’s conversation format. A
                handoff must start a new session.
              </p>
            </section>

            <section aria-labelledby={`${titleId}-model-heading`}>
              <label id={`${titleId}-model-heading`} htmlFor={modelId} className="text-ui font-semibold text-fg">
                Model
              </label>
              <input
                id={modelId}
                list={modelListId}
                value={model}
                onChange={event => changeModel(event.target.value)}
                className="kt-input mt-2 !min-h-[44px] w-full mono"
                placeholder={sameAccount ? 'Enter a different model' : 'Use the account default'}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
              <datalist id={modelListId}>
                {modelSuggestions.map(suggestion => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
              <p className="mt-1 text-meta leading-base text-muted">
                Leave empty to use the account’s default model. Add <span className="mono">[1m]</span> for the 1M-token
                context window.
              </p>

              {conversationTooLarge && explicitTargetWindow !== undefined && contextTokens !== undefined ? (
                <div
                  role="alert"
                  className="mt-3 rounded-control border border-err bg-surface-2 p-3 text-ui leading-base text-err"
                >
                  <div className="flex items-start gap-sm">
                    <AlertOctagon size={17} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span>
                      This conversation ({readableNumber(contextTokens)} tokens) no longer fits that model’s window (
                      {readableNumber(explicitTargetWindow)}). Pick a <span className="mono">[1m]</span> variant. The
                      daemon refuses this even with a downgrade override.
                    </span>
                  </div>
                </div>
              ) : isContextDowngrade ? (
                <div className="mt-3 rounded-control border border-warn-border bg-surface-2 p-3">
                  <div className="flex items-start gap-sm text-warn">
                    <ShieldAlert size={17} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <p className="m-0 text-ui leading-base">
                      This changes the context window from {readableNumber(currentWindow!)} to{' '}
                      {readableNumber(explicitTargetWindow!)} tokens.
                    </p>
                  </div>
                  <label className="mt-2 flex min-h-[44px] items-start gap-sm text-ui text-fg">
                    <input
                      type="checkbox"
                      checked={allowContextDowngrade}
                      onChange={event => setAllowContextDowngrade(event.target.checked)}
                      className="mt-1 h-4 w-4 shrink-0"
                    />
                    <span>
                      I understand this session may permanently outgrow the smaller window and become unrecoverable.
                    </span>
                  </label>
                </div>
              ) : null}
            </section>

            <section aria-labelledby={`${titleId}-preflight-heading`}>
              <h2 id={`${titleId}-preflight-heading`} className="m-0 text-ui font-semibold text-fg">
                Migration preflight
              </h2>
              <p className="mt-1 text-meta leading-base text-muted">
                Open tool commands are joined from chat history. The browser cannot inspect OS process arguments, so any
                active subprocess signal stays unknown and blocks by default.
              </p>
              {toolsLoading ? (
                <div role="status" className="mt-2 flex min-h-[44px] items-center gap-sm text-ui text-muted">
                  <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
                  Inspecting in-flight work…
                </div>
              ) : (
                <div className="mt-2">
                  <InflightList items={inflightItems} />
                </div>
              )}
            </section>

            {noRuntimeChange && (
              <p role="status" className="m-0 text-ui leading-base text-warn">
                Choose another account or enter a different model. Relaunching the same account and model would only
                destroy the current pane.
              </p>
            )}

            <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
              <Button type="button" onClick={onClose} className="min-h-[44px]">
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!canReview} className="min-h-[44px]">
                Review migration <ArrowRight size={15} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-5">
          <div className="mx-auto grid w-full max-w-2xl gap-4 py-4">
            <section
              className="rounded-control border border-warn-border bg-surface-2 p-4"
              aria-labelledby={`${titleId}-confirm-heading`}
            >
              <div className="flex items-start gap-sm text-warn">
                <AlertTriangle size={19} aria-hidden="true" className="mt-0.5 shrink-0" />
                <div>
                  <h2 id={`${titleId}-confirm-heading`} className="m-0 text-title font-semibold text-fg">
                    This is a destructive relaunch
                  </h2>
                  <p className="mt-1 text-ui leading-base text-muted">
                    {terminal
                      ? `This will relaunch the stopped session under ${selectedAgent}.`
                      : `Migrating relaunches this session under ${selectedAgent}. If it is mid-turn, the current turn is interrupted and unfinished work in it is lost; the teammate is told to re-read its turn file and continue.`}
                  </p>
                </div>
              </div>
            </section>

            {isBusy(view) && (
              <div
                role="alert"
                className="flex items-center gap-sm rounded-control border-l-heavy border-warn bg-surface-2 p-3 text-ui font-semibold text-warn"
              >
                <RefreshCw size={17} aria-hidden="true" className="shrink-0" />
                This session is working right now.
              </div>
            )}

            <section aria-labelledby={`${titleId}-inflight-confirm-heading`}>
              <h2 id={`${titleId}-inflight-confirm-heading`} className="m-0 text-ui font-semibold text-fg">
                What migration will interrupt
              </h2>
              <div className="mt-2">
                <InflightList items={inflightItems} />
              </div>
            </section>

            {hasInflightBlockers && (
              <label className="flex min-h-[52px] items-start gap-sm rounded-control border border-err bg-surface-2 p-3 text-ui text-fg">
                <input
                  type="checkbox"
                  checked={forceInflight}
                  onChange={event => setForceInflight(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0"
                />
                <span>
                  <span className="block font-semibold text-err">Override the in-flight safety block</span>
                  <span className="mt-0.5 block leading-base text-muted">
                    I understand migration will kill this in-flight work and may leave state half-applied. I will
                    inspect the workspace before re-running anything.
                  </span>
                </span>
              </label>
            )}

            {phase === 'downgrade' && downgradeMessage && (
              <section
                className="rounded-control border border-warn-border bg-surface-2 p-4"
                aria-labelledby={`${titleId}-downgrade-heading`}
              >
                <h2 id={`${titleId}-downgrade-heading`} className="m-0 text-title font-semibold text-fg">
                  The daemon refused a smaller context window
                </h2>
                <p role="alert" className="mt-2 break-words text-ui leading-base text-warn">
                  {downgradeMessage}
                </p>
                <Button
                  type="button"
                  variant="primary"
                  className="mt-3 min-h-[44px] w-full justify-center"
                  onClick={() => {
                    changeModel(recommendedModel ?? oneMillionVariant(normalizedModel || currentModel));
                    setPhase('form');
                  }}
                >
                  Use {recommendedModel ? <span className="mono">{recommendedModel}</span> : 'a 1M model'} instead
                </Button>
                <label className="mt-3 flex min-h-[52px] items-start gap-sm rounded-control border border-warn-border p-3 text-ui text-fg">
                  <input
                    type="checkbox"
                    checked={allowContextDowngrade}
                    onChange={event => setAllowContextDowngrade(event.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>
                    I understand this session may permanently outgrow the smaller window and become unrecoverable.
                  </span>
                </label>
              </section>
            )}

            {failure && (
              <div
                role="alert"
                className="rounded-control border border-err bg-surface-2 p-4 text-ui leading-base text-err"
              >
                <p className="m-0 break-words">{failure.message}</p>
                {failure.restoredStopped && (
                  <p className="mt-2 text-fg">
                    The session is now stopped — use Resume to relaunch it on the restored account.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
              <Button
                type="button"
                onClick={() => {
                  setPhase('form');
                  setFailure(null);
                }}
                className="min-h-[44px]"
              >
                Back
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={(hasInflightBlockers && !forceInflight) || (phase === 'downgrade' && !allowContextDowngrade)}
                className="min-h-[44px]"
                onClick={() => void performMigration(phase === 'downgrade' ? true : allowContextDowngrade)}
              >
                {phase === 'downgrade'
                  ? 'Migrate with smaller window'
                  : hasInflightBlockers
                    ? 'Force migration and kill work'
                    : terminal
                      ? 'Relaunch on selected runtime'
                      : 'Migrate and relaunch'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
