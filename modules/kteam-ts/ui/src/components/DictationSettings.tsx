// The dictation settings surface.
//
// Its job is not to sell the feature. It is to make the two modes' real costs
// visible BEFORE anyone commits to them, because one of those costs is a
// 640 MB download onto a phone that may be on cellular. Every clause in
// `LOCAL_MODE_TRADEOFFS` is a measured or documented cost, not a disclaimer,
// and the component renders all of them — there is no "show more".
//
// Daemon is the recommendation and says so in the card, not in a footnote. It
// downloads once, on the box, for every device; it does not hold a gigabyte of
// this browser's memory; and its storage cannot be reclaimed by the browser
// when you go a week without opening the app.
//
// NO AUTOFOCUS anywhere, per this app's touch rules — opening a settings
// section must not raise the keyboard on a phone. Every interactive target is
// at least 44 px.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Textarea } from './Primitives';
import { cn } from '../lib/utils';
import {
  STT_LANGUAGES,
  daemonSupportsLanguage,
  sttDictionary,
  useSttSettings,
  type SttMode,
} from '../lib/stt/stt-settings';
import { daemonSttStatus, requestDaemonModelInstall, type DaemonSttStatus } from '../lib/stt/daemon-engine';
import {
  STT_MODEL_BASE,
  clearLocalModel,
  localEngineTotalBytes,
  localModelReadiness,
  prepareLocalModel,
  selectLocalBackend,
  type PrepareProgress,
} from '../lib/stt/local-engine';
import { readSttCapabilities } from '../lib/stt/capabilities';

/** Human bytes, one decimal, MB/GB only — the two units these numbers live in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The mandatory local-mode disclosures. Every one is a real cost:
 *  - the download size is the daemon's own pinned manifest total;
 *  - "slower on a phone" is CPU WASM inference of a 622 MB int8 encoder, which
 *    is slower than real time on phone cores;
 *  - the eviction clause is WebKit's documented seven-day storage policy;
 *  - the battery clause follows from sustained full-CPU decoding.
 *  Exported so a test can assert the component renders all of them. */
export const LOCAL_MODE_TRADEOFFS: readonly string[] = [
  'About 640 MB per device — every phone, laptop and browser profile downloads it separately. Your box downloads it once, for all of them.',
  'Slower on a phone. Transcribing can take longer than the recording did, because it runs on the CPU.',
  'Your browser can reclaim the download. Safari clears unused site storage after about seven days of not opening the app, and you would prepare the device again.',
  'It warms the device and uses battery while it transcribes.',
  'Model files come from your own kteam box, never a third-party CDN.',
] as const;

export const DAEMON_MODE_SUMMARY =
  'Recommended. Your box does the transcribing. It downloads the model once for every device you use, and this browser stores nothing.';

export const LOCAL_MODE_SUMMARY =
  'Everything happens inside this browser — nothing is sent anywhere, not even to your own box. Desktop first; workable but slow on a phone.';

/** Said plainly next to the enhancement toggle. The capitalised phrase is the
 *  promise: a separate verifier compares the before and after and throws the
 *  whole result away if anything but a whole word changed. */
export const ENHANCEMENT_EXPLANATION =
  'WORDS ONLY. It can swap a whole word for one you actually use — “kteam”, “tmux”, “Parakeet” — and nothing else. It cannot add, remove or reorder words, change punctuation or spacing, or rewrite a sentence. A separate check compares the result against the raw transcript and discards the whole thing if anything else moved.';

/** The language selector applies to BOX transcription only.
 *
 *  Checked against the installed `parakeet.js@1.4.4`: neither `fromUrls` nor
 *  `transcribe()` takes a language, and the multilingual v3 export decodes
 *  whatever it hears. There is no forcing path, so the honest thing is to say
 *  that the choice does nothing in this mode rather than leave a control that
 *  looks like it works. */
export const LOCAL_LANGUAGE_NOTE =
  'This choice does not change transcription on this device. The browser model is multilingual and works the language out from what it hears — there is no way to make it commit to one. Your choice applies when your box does the transcribing.';

export const DAEMON_LANGUAGE_NOTE =
  'Your box runs the English model, so the other languages are unavailable in this mode.';

export const DICTATION_SAFETY_NOTE =
  'Dictated text always lands in the message box for you to read and edit. Nothing is ever sent for you.';

type SectionState = 'unknown' | 'checking' | 'ready' | 'missing' | 'error';

/** THE TWO-STAGE RULE, as a function so the fresh-install path has a test.
 *
 *  The browser model is downloaded TWICE over: once onto the box, which then
 *  serves it, and then once per device into that device's CacheStorage. If the
 *  box does not have it, "Prepare this device" would fetch the SPA shell where
 *  a 652 MB encoder should be. So it is disabled, with the box-side action
 *  offered instead.
 *
 *  An UNKNOWN status is deliberately NOT a refusal: an older daemon, or a page
 *  with no token, tells us nothing, and `prepareLocalModel` reports honestly if
 *  the route turns out to be missing. Refusing on ignorance would break a
 *  working setup to protect against a broken one. */
export function needsBoxBrowserModel(browserModel: { state: string } | undefined): boolean {
  return browserModel !== undefined && browserModel.state !== 'ready';
}

/** Daemon mode is English-only, so the other twelve are disabled — visible,
 *  with the reason, rather than quietly missing. */
export function languageOptionDisabled(mode: SttMode, code: string): boolean {
  return mode === 'daemon' && !daemonSupportsLanguage(code);
}

/** Which note sits under the language selector. See `LOCAL_LANGUAGE_NOTE`: in
 *  local mode the selector genuinely does nothing, and says so. */
export function languageNote(mode: SttMode): string {
  return mode === 'daemon' ? DAEMON_LANGUAGE_NOTE : LOCAL_LANGUAGE_NOTE;
}

interface ModeCardProps {
  mode: SttMode;
  checked: boolean;
  title: string;
  summary: string;
  onSelect: (mode: SttMode) => void;
  children?: React.ReactNode;
}

function ModeCard({ mode, checked, title, summary, onSelect, children }: ModeCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={() => onSelect(mode)}
      className={cn(
        'flex min-h-[44px] min-w-0 flex-col items-start justify-center gap-1 rounded-control border px-control-x py-3 text-left transition-colors',
        checked ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg hover:border-accent',
      )}
    >
      <span className="text-ui font-semibold">{title}</span>
      <span className="text-meta leading-base text-muted">{summary}</span>
      {children}
    </button>
  );
}

export function DictationSettings() {
  const { settings, update, persisted } = useSttSettings();
  const capabilities = useMemo(() => readSttCapabilities(), []);
  const backend = useMemo(() => selectLocalBackend(capabilities), [capabilities]);

  const [daemon, setDaemon] = useState<DaemonSttStatus | null>(null);
  const [daemonState, setDaemonState] = useState<SectionState>('unknown');
  /** Keyed by model id: the daemon and browser models install independently and
   *  a message about one must not appear under the other. */
  const [installMessages, setInstallMessages] = useState<Record<string, string>>({});

  const [localState, setLocalState] = useState<SectionState>('unknown');
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const preparing = useRef<AbortController | null>(null);

  const refreshDaemon = useCallback(async () => {
    setDaemonState('checking');
    const status = await daemonSttStatus();
    setDaemon(status);
    setDaemonState(status.available ? 'ready' : 'missing');
  }, []);

  const refreshLocal = useCallback(async () => {
    setLocalState('checking');
    try {
      const readiness = await localModelReadiness();
      setLocalState(readiness.ready ? 'ready' : 'missing');
    } catch {
      setLocalState('error');
    }
  }, []);

  useEffect(() => {
    void refreshDaemon();
    void refreshLocal();
    return () => preparing.current?.abort();
  }, [refreshDaemon, refreshLocal]);

  const prepare = useCallback(async () => {
    preparing.current?.abort();
    const controller = new AbortController();
    preparing.current = controller;
    setLocalError(null);
    setProgress({ phase: 'checking', label: '', receivedBytes: 0, totalBytes: localEngineTotalBytes(), fraction: 0 });
    try {
      await prepareLocalModel({ signal: controller.signal, onProgress: setProgress });
      setProgress(null);
      setLocalState('ready');
    } catch (error) {
      setProgress(null);
      setLocalError(error instanceof Error ? error.message : 'Preparation failed.');
      setLocalState('missing');
    } finally {
      preparing.current = null;
    }
  }, []);

  /** Ask the box to fetch a model it does not have. Shared by both sections:
   *  the daemon model (what the box runs) and the browser model (what the box
   *  SERVES to browsers) are two separate ~500 MB / ~670 MB downloads, and a
   *  fresh install needs whichever one the chosen mode depends on. */
  const installOnBox = useCallback(
    (modelId: string) => {
      setInstallMessages(current => {
        const next = { ...current };
        delete next[modelId];
        return next;
      });
      void requestDaemonModelInstall(modelId).then(result => {
        if (result.message) setInstallMessages(current => ({ ...current, [modelId]: result.message as string }));
        if (result.started) void refreshDaemon();
      });
    },
    [refreshDaemon],
  );

  const dictionary = useMemo(() => sttDictionary(settings), [settings]);
  const daemonModel = daemon?.daemonModel;
  const browserModel = daemon?.browserModel;
  /** The box has told us it does NOT have the browser weights. Preparing this
   *  device would then fetch the app shell instead of a 652 MB encoder, so the
   *  action is disabled with the reason shown rather than left to fail. An
   *  UNKNOWN status (older daemon, no token) is not treated as a refusal — the
   *  attempt is allowed and `prepareLocalModel` reports honestly if the route
   *  is missing. */
  const browserWeightsMissing = needsBoxBrowserModel(browserModel);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-meta leading-base text-muted">{DICTATION_SAFETY_NOTE}</p>

      {/* ---- mode ---- */}
      <div className="flex flex-col gap-2">
        <div
          role="radiogroup"
          aria-label="Where speech is transcribed"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <ModeCard
            mode="daemon"
            checked={settings.mode === 'daemon'}
            title="On my box (recommended)"
            summary={DAEMON_MODE_SUMMARY}
            onSelect={mode => update({ mode, language: 'en' })}
          />
          <ModeCard
            mode="local"
            checked={settings.mode === 'local'}
            title="On this device"
            summary={LOCAL_MODE_SUMMARY}
            onSelect={mode => update({ mode })}
          />
        </div>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
          {LOCAL_MODE_TRADEOFFS.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-meta leading-base text-faint">{backend.webgpuBlockedReason}</p>
      </div>

      {/* ---- daemon readiness ---- */}
      <section
        aria-label="Box transcription"
        className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      >
        <h3 className="text-ui font-semibold">Your box</h3>
        {daemonState === 'checking' && <p className="text-meta text-faint">Checking…</p>}
        {daemonState !== 'checking' && !daemon?.available && (
          <p className="text-meta leading-base text-warn">
            {daemon?.unavailableReason ?? 'Your box cannot transcribe yet.'}
          </p>
        )}
        {daemonModel && (
          <p className="text-meta leading-base text-muted">
            {daemonModel.label} — {daemonModel.state === 'ready' ? 'installed' : daemonModel.state.replace('-', ' ')}.{' '}
            {daemonModel.costs.summary}
          </p>
        )}
        {daemonModel?.install?.phase === 'downloading' && (
          <p className="text-meta text-faint" role="status">
            Downloading on the box — {formatBytes(daemonModel.install.receivedBytes)} of{' '}
            {formatBytes(daemonModel.install.totalBytes)}.
          </p>
        )}
        {daemonModel && installMessages[daemonModel.id] && (
          <p className="text-meta leading-base text-warn">{installMessages[daemonModel.id]}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="min-h-[44px] min-w-[44px]"
            onClick={() => void refreshDaemon()}
            aria-label="Re-check the box"
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span className="ml-1">Re-check</span>
          </Button>
          {daemonModel && daemonModel.state !== 'ready' && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="min-h-[44px] min-w-[44px]"
              disabled={daemonModel.install.phase === 'downloading'}
              onClick={() => installOnBox(daemonModel.id)}
            >
              <Download size={14} aria-hidden="true" />
              <span className="ml-1">Download on the box ({formatBytes(daemonModel.costs.downloadBytes)})</span>
            </Button>
          )}
        </div>
      </section>

      {/* ---- browser readiness ---- */}
      <section
        aria-label="This device"
        className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
      >
        <h3 className="text-ui font-semibold">This device</h3>
        {!capabilities.cacheStorage && (
          <p className="text-meta leading-base text-warn">This browser cannot store the speech model offline.</p>
        )}
        {/* TWO STAGES, and a fresh install needs both. The box fetches the
            browser weights once; then each device copies them into its own
            CacheStorage. Without the first stage there is nothing to copy, so
            the second is disabled with the reason and the action shown. */}
        {browserWeightsMissing && browserModel && (
          <div className="flex flex-col gap-2">
            <p className="text-meta leading-base text-warn">
              Your box has not downloaded the browser model yet, so this device has nothing to fetch. That is a one-time{' '}
              {formatBytes(browserModel.costs.downloadBytes)} download onto the box, shared by every device.
            </p>
            {browserModel.install.phase === 'downloading' && (
              <p className="text-meta text-faint" role="status">
                Downloading on the box — {formatBytes(browserModel.install.receivedBytes)} of{' '}
                {formatBytes(browserModel.install.totalBytes)}.
              </p>
            )}
            {installMessages[browserModel.id] && (
              <p className="text-meta leading-base text-warn">{installMessages[browserModel.id]}</p>
            )}
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="min-h-[44px] min-w-[44px] self-start"
              disabled={browserModel.install.phase === 'downloading'}
              onClick={() => installOnBox(browserModel.id)}
            >
              <Download size={14} aria-hidden="true" />
              <span className="ml-1">
                Download browser model on the box ({formatBytes(browserModel.costs.downloadBytes)})
              </span>
            </Button>
          </div>
        )}
        <p className="text-meta leading-base text-muted">
          {formatBytes(localEngineTotalBytes())} in total: the speech model plus the runtime that executes it, served
          from <code className="text-faint">{STT_MODEL_BASE}</code> on your own box.
        </p>
        {localState === 'ready' && (
          <p className="flex items-center gap-1 text-meta text-ok" role="status">
            <Check size={14} aria-hidden="true" /> Prepared — dictation works on this device offline.
          </p>
        )}
        {localState === 'missing' && !progress && (
          <p className="text-meta leading-base text-faint">Not prepared. Local mode will not record until it is.</p>
        )}
        {progress && (
          <p className="text-meta text-faint" role="status">
            {progress.phase === 'storing' ? 'Storing' : 'Downloading'} {progress.label} —{' '}
            {formatBytes(progress.receivedBytes)} of {formatBytes(progress.totalBytes)}
            {progress.fraction === null ? '' : ` (${Math.round(progress.fraction * 100)}%)`}
          </p>
        )}
        {localError && <p className="text-meta leading-base text-warn">{localError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="primary"
            className="min-h-[44px] min-w-[44px]"
            disabled={progress !== null || !capabilities.cacheStorage || browserWeightsMissing}
            onClick={() => void prepare()}
          >
            {progress ? (
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            ) : (
              <Download size={14} aria-hidden="true" />
            )}
            <span className="ml-1">
              {localState === 'ready'
                ? 'Re-download to this device'
                : `Prepare this device (${formatBytes(localEngineTotalBytes())})`}
            </span>
          </Button>
          {progress && (
            <Button
              type="button"
              size="sm"
              className="min-h-[44px] min-w-[44px]"
              onClick={() => preparing.current?.abort()}
            >
              Stop
            </Button>
          )}
          {localState === 'ready' && !progress && (
            <Button
              type="button"
              size="sm"
              variant="danger"
              className="min-h-[44px] min-w-[44px]"
              onClick={() => void clearLocalModel().then(() => refreshLocal())}
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="ml-1">Remove from this device</span>
            </Button>
          )}
        </div>
      </section>

      {/* ---- language ---- */}
      <div className="flex flex-col gap-2">
        <label htmlFor="stt-language" className="text-ui font-semibold">
          Language (box transcription)
        </label>
        <select
          id="stt-language"
          className="min-h-[44px] rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg"
          value={settings.language}
          onChange={event => update({ language: event.target.value })}
        >
          {STT_LANGUAGES.map(language => {
            // Daemon mode is English-only. The other twelve are DISABLED rather
            // than hidden, so the reader can see that the choice exists and
            // read why it is unavailable — instead of wondering where it went.
            const unavailable = languageOptionDisabled(settings.mode, language.code);
            return (
              <option key={language.code} value={language.code} disabled={unavailable}>
                {language.label}
                {unavailable ? ' — box transcribes English only' : ''}
              </option>
            );
          })}
        </select>
        <p className="text-meta leading-base text-faint">{languageNote(settings.mode)}</p>
      </div>

      {/* ---- enhancement ---- */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={settings.enhancement}
          onClick={() => update({ enhancement: !settings.enhancement })}
          className={cn(
            'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
            settings.enhancement ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
          )}
        >
          <span className="text-ui font-semibold">Fix names and jargon</span>
          <span className="text-meta">{settings.enhancement ? 'On' : 'Off'}</span>
        </button>
        <p className="text-meta leading-base text-muted">{ENHANCEMENT_EXPLANATION}</p>
      </div>

      {/* ---- dictionary ---- */}
      <div className="flex flex-col gap-2">
        <label htmlFor="stt-dictionary" className="text-ui font-semibold">
          Your words
        </label>
        <p className="text-meta leading-base text-muted">
          One per line. Add alternatives after an “=”, separated by commas — <code>kteam = kteem, katim</code>. Single
          words only: dictation never joins or splits what you said.
        </p>
        <Textarea
          id="stt-dictionary"
          className="min-h-[44px]"
          rows={5}
          spellCheck={false}
          value={settings.dictionary.join('\n')}
          onChange={event => update({ dictionary: event.target.value.split('\n') })}
          placeholder={'kteam = kteem, katim\ntmux\nkfleet\nParakeet = paraquet'}
        />
        <p className="text-meta text-faint">
          {dictionary.entries.length} term{dictionary.entries.length === 1 ? '' : 's'}.
        </p>
        {dictionary.problems.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-warn">
            {dictionary.problems.map(problem => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </div>

      {!persisted && (
        <p className="text-meta leading-base text-warn" role="status">
          These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
        </p>
      )}
    </div>
  );
}
