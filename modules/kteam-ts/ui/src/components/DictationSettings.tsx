// The dictation settings surface.
//
// Dictation is browser-local only. The box still HOSTS the pinned model files,
// but microphone audio never goes back to it and there is no dead daemon mode
// card implying otherwise. This surface makes the local engine's real costs
// visible BEFORE anyone commits to them, because one is a ~700 MB download
// onto a phone that may be on cellular. Every clause in
// `LOCAL_MODE_TRADEOFFS` is a measured or documented cost, not a disclaimer,
// and the component renders all of them — there is no "show more".
//
// NO AUTOFOCUS anywhere, per this app's touch rules — opening a settings
// section must not raise the keyboard on a phone. Every interactive target is
// at least 44 px.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Loader2, Trash2 } from 'lucide-react';
import { Button, Textarea } from './Primitives';
import { cn } from '../lib/utils';
import { MAX_USER_CONTEXT_CHARS, sttDictionary, useSttSettings } from '../lib/stt/stt-settings';
import { userContextVocabulary } from '../lib/stt/enhancement';
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
import { DictationShortcutPicker } from './DictationShortcutPicker';

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
  'About 700 MB per device — every phone, laptop and browser profile stores its own copy. Your box hosts the pinned files, but never receives microphone audio.',
  'Slower on a phone. Transcribing can take longer than the recording did, because it runs on the CPU.',
  'Your browser can reclaim the download. Safari clears unused site storage after about seven days of not opening the app, and you would prepare the device again.',
  'It warms the device and uses battery while it transcribes.',
  'Model files come from your own kteam box, never a third-party CDN.',
] as const;

export const LOCAL_MODE_SUMMARY =
  'Everything happens inside this browser. Fresh snapshots are transcribed while you keep speaking, without waiting for a pause; microphone audio is never sent to your box or a third party.';

/** Said plainly next to the enhancement toggle. The capitalised phrase is the
 *  promise: a separate verifier compares the before and after and throws the
 *  whole result away if anything but a whole word changed. */
export const ENHANCEMENT_EXPLANATION =
  'WORDS ONLY. It can swap a whole word for one you actually use — “kteam”, “tmux”, “Parakeet” — and nothing else. It cannot add, remove or reorder words, change punctuation or spacing, or rewrite a sentence. A separate check compares the result against the raw transcript and discards the whole thing if anything else moved.';

/** Where enhancement's vocabulary comes from, in the order it is trusted.
 *  Rendered under the toggle so the section explains itself: the reader should
 *  not need the source to learn that it is offline and has no AI model. */
export const ENHANCEMENT_SOURCES_EXPLANATION =
  'It knows a word three ways, tried in this order: your words below (which always win), your context, and words used in the recent conversation. Everything runs instantly on this device — no AI model, nothing sent anywhere. When it is not sure, it changes nothing.';

export const DICTATION_SAFETY_NOTE =
  'Microphone audio stays in this browser. Stop runs one final local decode and enhancement pass, then inserts the result once at your current caret. Nothing is ever sent for you.';

/** Above the free-text context field. It has to establish two things fast:
 *  paste anything (it is prose, not a format), and only single words can ever
 *  be swapped in — the same contract the dictionary states line by line. */
export const USER_CONTEXT_EXPLANATION =
  'Paste anything: project names, people, a glossary, a paragraph about what you work on. Dictation picks out the distinctive words and fixes mishearings of them. Plain English words are ignored, and if a term is also in “Your words” above, that entry wins.';

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

export function DictationSettings() {
  const { settings, update, persisted } = useSttSettings();
  const capabilities = useMemo(() => readSttCapabilities(), []);
  const backend = useMemo(() => selectLocalBackend(capabilities), [capabilities]);

  const [daemon, setDaemon] = useState<DaemonSttStatus | null>(null);
  /** Keyed by browser-model id. The box hosts these public weight files; it
   * never receives microphone audio or performs dictation. */
  const [installMessages, setInstallMessages] = useState<Record<string, string>>({});

  const [localState, setLocalState] = useState<SectionState>('unknown');
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const preparing = useRef<AbortController | null>(null);

  const refreshDaemon = useCallback(async () => {
    const status = await daemonSttStatus();
    setDaemon(status);
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

  /** Ask the box to fetch the browser model it SERVES to devices. This installs
   * public weight files only; microphone audio never takes this route. */
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
  /** Live echo of what the context field actually yields, so a reader can see
   *  their glossary "take" (or see that plain prose yields nothing) without
   *  dictating a test sentence. */
  const userVocabulary = useMemo(() => userContextVocabulary(settings.userContext), [settings.userContext]);
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

      {/* ---- one honest engine ---- */}
      <section
        aria-label="Where speech is transcribed"
        className="flex flex-col gap-2 rounded-control border border-accent bg-accent-soft p-3"
      >
        <h3 className="text-ui font-semibold text-accent">Transcribed on this device</h3>
        <p className="text-meta leading-base text-fg">{LOCAL_MODE_SUMMARY}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
          {LOCAL_MODE_TRADEOFFS.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-meta leading-base text-faint">{backend.webgpuBlockedReason}</p>
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
          <p className="text-meta leading-base text-faint">Not prepared. Dictation will not record until it is.</p>
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

      {/* ---- push-to-talk shortcut ---- */}
      <DictationShortcutPicker binding={settings.shortcut} onChange={shortcut => update({ shortcut })} />

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
        <p className="text-meta leading-base text-muted">{ENHANCEMENT_SOURCES_EXPLANATION}</p>
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

      {/* ---- free-text context ---- */}
      <div className="flex flex-col gap-2">
        <label htmlFor="stt-user-context" className="text-ui font-semibold">
          Your context
        </label>
        <p className="text-meta leading-base text-muted">{USER_CONTEXT_EXPLANATION}</p>
        <Textarea
          id="stt-user-context"
          className="min-h-[44px]"
          rows={4}
          spellCheck={false}
          maxLength={MAX_USER_CONTEXT_CHARS}
          value={settings.userContext}
          onChange={event => update({ userContext: event.target.value })}
          placeholder={'I work on kteam and kfleet with Kirin.\nOur services: nitroso, diene, alcohol.'}
        />
        <p className="text-meta text-faint">
          {userVocabulary.length} word{userVocabulary.length === 1 ? '' : 's'} picked out
          {userVocabulary.length > 0
            ? ` — ${userVocabulary.slice(0, 8).join(', ')}${userVocabulary.length > 8 ? ', …' : ''}`
            : ''}
          .
        </p>
      </div>

      {!persisted && (
        <p className="text-meta leading-base text-warn" role="status">
          These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
        </p>
      )}
    </div>
  );
}
