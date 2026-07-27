// The Learning manager — the daemon-side orchestrator. Warden-shaped: its own
// timer, a serialized run chain, durable state (learning/state.json), and LLM
// work done by spawning ordinary kteam auto sessions (label `kteam-learning`,
// excluded from its own scan so there is no self-mining loop).
//
// A run has two passes, exactly like the warden's spawn-then-scan:
//   • spawnPass  — deterministic watermark scan → extract → signal filter →
//                  batch → spawn one miner per batch. The per-batch DIGESTS
//                  (including each session's verification corpus) are written to
//                  runs/<runId>/digests.json so ingest can verify later. The
//                  watermark advances past every scanned session.
//   • ingestPass — find runs whose miner has written observations.json but whose
//                  manifest is still pending; verify every quote against the
//                  saved corpus, append the survivors, aggregate into proposals.
//
// APPLY IS NEVER AUTOMATIC. The only "apply" in phase 1 is a patch FILE the
// human copies into kfleet by hand (learningPatch); the daemon never writes it.
//
// The whole subsystem is self-contained: it derives its file paths from
// paths.daemon (learning-store.learningPaths), declares its own config type
// (learning-types.LearningConfig), and depends only on a NARROW slice of
// KTeamService (LearningDeps). That keeps it type-checking independently of the
// concurrently-edited shared daemon files; the daemon wiring is a small patch.

import { readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { KTeamPaths } from './paths';
import { sessionDir } from './paths';
import { atomicJson, now, run } from './io';
import type { SessionView } from './service';
import type { StartSessionRequest } from './types';
import { LearningStore, parseJsonl, slugify, titleHash } from './learning-store';
import {
  extractSession,
  type InboxSendLike,
  type NormalizedRecordLike,
  type RawSessionInput,
  type SessionDigest,
} from './learning-extract';
import { applyMinerOutput, type MinerOutput } from './learning-aggregate';
import type {
  LearningConfig,
  LearningStatusView,
  Observation,
  Proposal,
  ProposalState,
  ProposalView,
  RunManifest,
  Tombstone,
} from './learning-types';

/** The `kteam-learning` label marks miner sessions — excluded from the scan so
 *  the learning system never mines itself. */
export const LEARNING_LABEL = 'kteam-learning';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stalled', 'stopped']);
/** Most-recent records fetched per session — the human signal is sparse and
 *  recency-biased, so a cap keeps I/O bounded on huge transcripts. */
const RECORD_CAP = 1200;

/** The narrow slice of KTeamService the manager needs — kept small so tests can
 *  pass a stub. SessionManager satisfies it structurally. */
export interface LearningDeps {
  list(): Promise<SessionView[]>;
  chatHistory(
    id: string,
    before?: number,
    limit?: number,
  ): Promise<{ total: number; offset: number; records: unknown[] }>;
  start(request: StartSessionRequest): Promise<SessionView>;
}

export interface LearningAction {
  action: 'accept' | 'reject' | 'edit';
  /** For edit: the new ruleText. */
  ruleText?: string;
  /** For reject: an optional note recorded on the tombstone. */
  note?: string;
}

export interface LearningService {
  learningStatus(): Promise<LearningStatusView>;
  learningProposals(state?: ProposalState): Promise<ProposalView[]>;
  learningAct(id: string, action: LearningAction): Promise<ProposalView | undefined>;
  learningRun(spawn?: boolean): Promise<RunManifest>;
  learningConfig(): Promise<LearningConfig>;
  learningPatch(id: string): Promise<{ path: string; contents: string }>;
}

export class LearningManager implements LearningService {
  private readonly store: LearningStore;
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<unknown> = Promise.resolve();
  private running = false;
  private lastSpawnAtCache?: string;
  private readonly repoCache = new Map<string, string>();

  constructor(
    private readonly paths: KTeamPaths,
    private config: LearningConfig,
    private readonly deps: LearningDeps,
  ) {
    this.store = new LearningStore(paths);
  }

  /** Arm the periodic tick and run one ingest pass at boot (so proposals from a
   *  miner that finished while the daemon was down land promptly). Deterministic
   *  scanning/spawning only happens when `enabled`. */
  async start(): Promise<void> {
    await this.store.ensureDir();
    const intervalMs = Math.max(60_000, this.config.intervalMinutes * 60_000);
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    await this.serialized(async () => {
      await this.ingestPass();
      if (this.config.enabled && this.spawnGapElapsed()) await this.spawnPass(false);
    });
  }

  private serialized<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private spawnGapElapsed(): boolean {
    const last = this.lastSpawnAtCache ? Date.parse(this.lastSpawnAtCache) : 0;
    const gapMs = Math.max(0, this.config.minSpawnGapMinutes * 60_000);
    return !last || Date.now() - last >= gapMs;
  }

  // ---- git toplevel (repo attribution) ----
  private async repoOf(cwd: string): Promise<string> {
    if (!cwd) return cwd;
    const cached = this.repoCache.get(cwd);
    if (cached) return cached;
    const result = await run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined);
    const top = result && result.code === 0 ? result.stdout.trim() : '';
    const repo = top || cwd;
    this.repoCache.set(cwd, repo);
    return repo;
  }

  // ---- reading a session's human signal ----
  private async readInput(view: SessionView): Promise<RawSessionInput> {
    const id = view.config.id;
    const dir = sessionDir(this.paths, id);
    const page = await this.deps
      .chatHistory(id, undefined, RECORD_CAP)
      .catch(() => ({ total: 0, offset: 0, records: [] }));
    const records = (page.records ?? []) as NormalizedRecordLike[];

    // Turn briefs (turns/turn-NNN.md) — pure user intent.
    const turnTexts: string[] = [];
    const turnsDir = path.join(dir, 'turns');
    const turnFiles = (await readdir(turnsDir).catch(() => [] as string[]))
      .filter(n => /^turn-\d+\.md$/.test(n))
      .sort();
    for (const name of turnFiles) {
      const text = await readFile(path.join(turnsDir, name), 'utf8').catch(() => '');
      if (text.trim()) turnTexts.push(text);
    }

    // Lead/peer + human sends.
    const inbox: InboxSendLike[] = [];
    const inboxText = await readFile(path.join(dir, 'channel', 'inbox.jsonl'), 'utf8').catch(() => '');
    for (const rec of parseJsonl<{
      type?: string;
      message?: string;
      text?: string;
      from?: string;
      fromName?: string;
      at?: string;
    }>(inboxText)) {
      if (rec.type && rec.type !== 'message') continue;
      const text = rec.message ?? rec.text ?? '';
      if (text.trim()) inbox.push({ text, from: rec.from, fromName: rec.fromName, at: rec.at });
    }

    // Interrupt count (a delivered interrupt is a strong steer signal).
    const eventsText = await readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => '');
    let interrupts = 0;
    for (const ev of parseJsonl<{ type?: string }>(eventsText)) {
      if (ev.type === 'control.interrupted') interrupts += 1;
    }

    const repo = await this.repoOf(view.config.cwd);
    return {
      sessionId: id,
      teammate: view.config.teammate,
      mode: view.config.mode === 'interactive' ? 'interactive' : 'auto',
      cwd: view.config.cwd,
      repo,
      harness: view.config.harness,
      status: view.state.status,
      finishedAt: view.state.finishedAt,
      records,
      turnTexts,
      inbox,
      interrupts,
    };
  }

  // ---- watermark scan ----
  private isCandidate(view: SessionView): boolean {
    if (!TERMINAL_STATUSES.has(view.state.status)) return false;
    if (view.config.label === LEARNING_LABEL) return false; // no self-mining
    return true;
  }

  private cursorKey(at: string | undefined, id: string): string {
    return `${at ?? ''} ${id}`;
  }

  private async scanCandidates(watermark: string): Promise<SessionView[]> {
    const all = await this.deps.list();
    const candidates = all
      .filter(v => this.isCandidate(v))
      .map(v => ({ v, key: this.cursorKey(v.state.finishedAt, v.config.id) }))
      .filter(x => x.key > watermark)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return candidates.slice(0, Math.max(1, this.config.maxSessionsPerRun)).map(x => x.v);
  }

  // ---- spawn pass ----
  private async spawnPass(force: boolean): Promise<RunManifest> {
    const state = await this.store.loadState();
    this.lastSpawnAtCache = state.lastSpawnAt;
    const watermark = this.cursorKey(state.watermarkAt, state.watermarkId ?? '');
    const candidates = await this.scanCandidates(watermark);

    const runId = `${now().replace(/[:.]/g, '-')}`;
    const manifest: RunManifest = {
      runId,
      startedAt: now(),
      sessionsScanned: candidates.length,
      sessionsWithSignal: 0,
      minerSessions: [],
      observationsProposed: 0,
      observationsVerified: 0,
      rejectedQuotes: 0,
      malformedFiles: 0,
      proposalsCreated: 0,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
      perHarness: { claude: 0, codex: 0 },
    };

    if (candidates.length === 0) {
      manifest.finishedAt = now();
      manifest.message = 'no new terminal sessions to scan';
      await this.store.writeRunManifest(manifest);
      return manifest;
    }

    // Extract + signal filter.
    const digests: SessionDigest[] = [];
    for (const view of candidates) {
      const input = await this.readInput(view).catch(() => undefined);
      if (!input) continue;
      const digest = extractSession(input);
      if (digest.hasSignal) {
        digests.push(digest);
        if (digest.harness === 'codex') manifest.perHarness.codex += 1;
        else manifest.perHarness.claude += 1;
      }
    }
    manifest.sessionsWithSignal = digests.length;

    // Advance the watermark past everything scanned — a session with no signal
    // is "processed", not pending, so it never re-scans.
    const newest = candidates.at(-1)!;
    const nextState = {
      ...state,
      watermarkAt: newest.state.finishedAt,
      watermarkId: newest.config.id,
    };

    if (digests.length === 0) {
      manifest.finishedAt = now();
      manifest.message = 'no human signal in the scanned batch';
      await this.store.writeRunManifest(manifest);
      await this.store.saveState({ ...nextState, lastRunAt: now(), lastRunId: runId });
      return manifest;
    }

    // Batch and spawn one miner per batch (bounded by maxMinersPerRun).
    const batches: SessionDigest[][] = [];
    const size = Math.max(1, this.config.batchSize);
    for (let i = 0; i < digests.length; i += size) batches.push(digests.slice(i, i + size));
    const spawnBatches = batches.slice(0, Math.max(1, this.config.maxMinersPerRun));
    if (batches.length > spawnBatches.length) {
      manifest.message = `${batches.length - spawnBatches.length} batch(es) deferred to a later run (maxMinersPerRun)`;
    }

    for (let b = 0; b < spawnBatches.length; b += 1) {
      const batch = spawnBatches[b]!;
      const batchRunId = spawnBatches.length === 1 ? runId : `${runId}-b${b + 1}`;
      const runDir = this.store.runDir(batchRunId);
      const outputPath = path.join(runDir, 'observations.json');
      // Save the digests (incl. corpus) so ingest can verify against them later.
      await atomicJson(path.join(runDir, 'digests.json'), batch);
      const prompt = await this.buildMinerPrompt(batch, outputPath, batchRunId);
      try {
        const view = await this.deps.start({
          prompt,
          agent: this.config.wrapper,
          model: this.config.model,
          mode: 'auto',
          label: LEARNING_LABEL,
          name: 'learning-miner',
          cwd: this.paths.home,
        });
        manifest.minerSessions.push(view.config.id);
        // Per-batch pending manifest so ingest knows to look here.
        await this.store.writeRunManifest({
          ...manifest,
          runId: batchRunId,
          sessionsScanned: batch.length,
          sessionsWithSignal: batch.length,
          minerSessions: [view.config.id],
        });
      } catch (error) {
        manifest.message = `miner spawn failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    await this.store.writeRunManifest(manifest);
    await this.store.saveState({
      ...nextState,
      lastRunAt: now(),
      lastRunId: runId,
      lastSpawnAt: now(),
    });
    this.lastSpawnAtCache = now();
    return manifest;
  }

  // ---- ingest pass ----
  private async ingestPass(): Promise<void> {
    const dirs = await readdir(this.store.runsDir).catch(() => [] as string[]);
    for (const runId of dirs.sort()) {
      const runDir = this.store.runDir(runId);
      const outputPath = path.join(runDir, 'observations.json');
      const digestsPath = path.join(runDir, 'digests.json');
      if (!existsSync(outputPath) || !existsSync(digestsPath)) continue;
      const manifest = await this.store.readRunManifest(runId);
      if (!manifest || manifest.finishedAt) continue; // already ingested
      await this.ingestRun(runId, outputPath, digestsPath, manifest).catch(() => undefined);
    }
  }

  private async ingestRun(
    runId: string,
    outputPath: string,
    digestsPath: string,
    manifest: RunManifest,
  ): Promise<void> {
    const digests = await readFile(digestsPath, 'utf8')
      .then(t => JSON.parse(t) as SessionDigest[])
      .catch(() => [] as SessionDigest[]);
    const digestsById = new Map(digests.map(d => [d.sessionId, d]));

    let output: MinerOutput | undefined;
    try {
      output = JSON.parse(await readFile(outputPath, 'utf8')) as MinerOutput;
      if (typeof output !== 'object' || output === null) throw new Error('not an object');
    } catch {
      // Quarantine malformed miner output; the run still finishes so it does not
      // block the queue forever.
      manifest.malformedFiles = 1;
      manifest.finishedAt = now();
      manifest.message = 'miner output was not valid JSON — quarantined';
      await this.store.writeRunManifest(manifest);
      await rm(outputPath, { force: true }).catch(() => undefined);
      return;
    }

    const existing = await this.store.loadProposals();
    const tombstones = await this.store.loadTombstones();
    const known = await this.store.observationsById();
    const result = applyMinerOutput(existing, tombstones, output, digestsById, known, runId, now());

    await this.store.appendObservations(result.observations);
    await this.store.saveProposals(result.proposals);

    manifest.observationsProposed = result.stats.observationsProposed;
    manifest.observationsVerified = result.stats.observationsVerified;
    manifest.rejectedQuotes = result.stats.rejectedQuotes;
    manifest.proposalsCreated = result.stats.proposalsCreated;
    manifest.proposalsStrengthened = result.stats.proposalsStrengthened;
    manifest.proposalsSuppressedByTombstone = result.stats.proposalsSuppressedByTombstone;
    manifest.finishedAt = now();
    await this.store.writeRunManifest(manifest);
  }

  // ---- miner prompt ----
  private async buildMinerPrompt(batch: SessionDigest[], outputPath: string, runId: string): Promise<string> {
    const existing = await this.store.loadProposals();
    const tombstones = await this.store.loadTombstones();
    const existingTitles = existing
      .filter(p => p.state === 'pending' || p.state === 'accepted')
      .map(p => `- [${p.identity}] ${p.title}`)
      .join('\n');
    const tombstoneList = tombstones.map(t => `- [${t.identity}] ${t.ruleGist}`).join('\n');

    const digestBlocks = batch
      .map(d =>
        [
          `### session ${d.sessionId} — teammate ${d.teammate ?? '-'} — mode ${d.mode} — repo ${d.repo}`,
          `signal: ${d.signalReasons.join('; ') || 'none'}`,
          d.digest,
        ].join('\n'),
      )
      .join('\n\n---\n\n');

    return [
      'You are a kteam LEARNING MINER. You read a batch of finished sessions and extract GLOBAL, cross-repo lessons about how the human wants agents to work — corrections, standing preferences, and tooling failures that recur.',
      '',
      '## The one rule that matters',
      'Every quote you emit MUST be copied VERBATIM from the session text below — character for character, ≤300 chars. The daemon substring-verifies each quote against the real transcript and DROPS any that does not literally appear. A fabricated or paraphrased quote is worse than none: it is discarded and counts against you. When in doubt, copy less but copy exactly.',
      '',
      '## What to extract',
      '- Only GLOBAL, repo-independent lessons (they should apply across ≥2 repos or be about the way of working, not one codebase). Skip anything specific to a single project.',
      '- Kinds: correction | preference | tooling_failure | roadblock | recurring_task.',
      '- Group observations that say the same thing into ONE proposal with a stable kebab `identity` (e.g. "direnv-exec-required").',
      '',
      '## Do NOT re-propose',
      'These already exist (strengthen them by reusing the SAME identity if you find new evidence, do not duplicate):',
      existingTitles || '(none yet)',
      'These were permanently REJECTED — never propose them again:',
      tombstoneList || '(none)',
      '',
      '## Output',
      `Write a JSON file to EXACTLY this path: ${outputPath}`,
      'Shape:',
      '```json',
      '{',
      '  "observations": [',
      '    {"key": "o1", "sessionId": "<one of the sessions below>", "kind": "correction", "gist": "short paraphrase", "quote": "VERBATIM user text", "source": "human"}',
      '  ],',
      '  "proposals": [',
      '    {"identity": "kebab-slug", "title": "short imperative rule title", "ruleText": "the exact text to insert into the rules file", "target": "claude-md", "observationKeys": ["o1"]}',
      '  ]',
      '}',
      '```',
      '- `source`: "human" for a real human message, "teammate" for a lead/peer steer.',
      '- `target`: "claude-md" for a rule that applies interactive + auto, "auto-md" for autonomy-only rules.',
      '- Every proposal must list the observationKeys that are its evidence. A proposal with no verifiable evidence is dropped.',
      '- If the batch has no genuine global lesson, write {"observations": [], "proposals": []}. An empty honest result is correct.',
      '',
      '## Sessions',
      digestBlocks,
      '',
      `When the file is written, run: kteam signal done   (run id ${runId})`,
    ].join('\n');
  }

  // ---- service surface ----
  async learningConfig(): Promise<LearningConfig> {
    return this.config;
  }

  private proposalView(p: Proposal, obsById: Map<string, Observation>): ProposalView {
    const evidence = p.observationIds
      .map(id => obsById.get(id))
      .filter((o): o is Observation => o !== undefined)
      .map(o => ({
        observationId: o.id,
        sessionId: o.sessionId,
        teammate: o.teammate,
        repo: o.repo,
        at: o.at,
        quote: o.quote,
        source: o.source,
        kind: o.kind,
      }));
    return { ...p, evidence };
  }

  async learningProposals(state?: ProposalState): Promise<ProposalView[]> {
    const proposals = await this.store.loadProposals();
    const obsById = await this.store.observationsById();
    const filtered = state ? proposals.filter(p => p.state === state) : proposals;
    // Strongest and most recent first (design §7.2).
    const sorted = [...filtered].sort((a, b) => b.occurrences - a.occurrences || (a.lastSeen < b.lastSeen ? 1 : -1));
    return sorted.map(p => this.proposalView(p, obsById));
  }

  async learningStatus(): Promise<LearningStatusView> {
    const state = await this.store.loadState();
    const proposals = await this.store.loadProposals();
    const observations = await this.store.readObservations();
    const tombstones = await this.store.loadTombstones();
    const pending = proposals.filter(p => p.state === 'pending');
    return {
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMinutes,
      watermarkAt: state.watermarkAt,
      lastRunAt: state.lastRunAt,
      pending: {
        total: pending.length,
        strong: pending.filter(p => p.occurrences >= 5).length,
        weak: pending.filter(p => p.occurrences <= 1).length,
      },
      totals: {
        observations: observations.length,
        proposals: proposals.length,
        tombstones: tombstones.length,
      },
      running: this.running,
      lastRun: await this.store.latestRunManifest(),
    };
  }

  async learningAct(id: string, action: LearningAction): Promise<ProposalView | undefined> {
    return this.serialized(async () => {
      const proposals = await this.store.loadProposals();
      const proposal = proposals.find(p => p.id === id);
      if (!proposal) return undefined;
      const at = now();
      if (action.action === 'accept') {
        proposal.state = 'accepted';
        proposal.history.push({ at, event: 'accepted', by: 'user' });
      } else if (action.action === 'edit') {
        if (typeof action.ruleText === 'string' && action.ruleText.trim()) {
          proposal.ruleText = action.ruleText.trim();
          proposal.history.push({ at, event: 'edited', by: 'user' });
        }
      } else if (action.action === 'reject') {
        proposal.state = 'rejected';
        proposal.history.push({ at, event: 'rejected', by: 'user', note: action.note });
        // Permanent tombstone (dual enforcement: also filtered at aggregation).
        const tombstones = await this.store.loadTombstones();
        if (!tombstones.some(t => t.identity === proposal.identity)) {
          const tomb: Tombstone = {
            identity: proposal.identity,
            titleHash: titleHash(proposal.title),
            ruleGist: proposal.title,
            rejectedAt: at,
            note: action.note,
          };
          tombstones.push(tomb);
          await this.store.saveTombstones(tombstones);
        }
      }
      await this.store.saveProposals(proposals);
      const obsById = await this.store.observationsById();
      return this.proposalView(proposal, obsById);
    });
  }

  async learningRun(spawn?: boolean): Promise<RunManifest> {
    return this.serialized(async () => {
      this.running = true;
      try {
        await this.ingestPass();
        if (spawn) return await this.spawnPass(true);
        const latest = await this.store.latestRunManifest();
        return (
          latest ?? {
            runId: 'none',
            startedAt: now(),
            finishedAt: now(),
            sessionsScanned: 0,
            sessionsWithSignal: 0,
            minerSessions: [],
            observationsProposed: 0,
            observationsVerified: 0,
            rejectedQuotes: 0,
            malformedFiles: 0,
            proposalsCreated: 0,
            proposalsStrengthened: 0,
            proposalsSuppressedByTombstone: 0,
            perHarness: { claude: 0, codex: 0 },
            message: 'ingest-only run (no spawn requested)',
          }
        );
      } finally {
        this.running = false;
      }
    });
  }

  /** Phase-1 "apply": build a patch FILE the human copies into kfleet by hand.
   *  The daemon writes nothing to kfleet itself. */
  async learningPatch(id: string): Promise<{ path: string; contents: string }> {
    const proposals = await this.store.loadProposals();
    const proposal = proposals.find(p => p.id === id);
    if (!proposal) throw new Error(`unknown learning proposal ${id}`);
    const obsById = await this.store.observationsById();
    const view = this.proposalView(proposal, obsById);
    const contents = [
      `# Learning proposal — ${proposal.title}`,
      '',
      `Target file: \`${proposal.target.path}\`${proposal.target.anchor ? ` (under \`${proposal.target.anchor}\`)` : ''}`,
      `Occurrences: ${proposal.occurrences} session(s) across ${proposal.crossRepoCount} repo(s)`,
      `State: ${proposal.state}`,
      '',
      '## Rule to insert',
      '',
      proposal.ruleText,
      '',
      '## Evidence (verified verbatim quotes)',
      '',
      ...view.evidence.map(
        e =>
          `- _${e.source}${e.teammate ? ` ${e.teammate}` : ''} · ${e.repo} · ${e.at}_\n  > ${e.quote.replace(/\n/g, ' ')}`,
      ),
      '',
      '_Apply by hand: paste the rule into the target file, then run `hms` (or `kfleet apply`). The daemon never writes kfleet automatically._',
      '',
    ].join('\n');
    const file = await this.store.writePatch(slugify(proposal.identity), contents);
    return { path: file, contents };
  }
}
