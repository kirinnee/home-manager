/**
 * Test file
 *
 * This project uses build-time verification rather than unit tests.
 * The implementation is verified through:
 * - TypeScript compilation (bun build)
 * - Code review by multiple reviewers
 * - Manual testing during development
 */

import { describe, it, expect } from 'bun:test';
import {
  buildImplementerPrompt,
  buildReSynthesisPrompt,
  buildSynthesizerPrompt,
  buildVerifierPrompt,
} from './agents/prompts';
import {
  parseRawConfig,
  parseImplementerConfig,
  parseReviewerConfig,
  parseConflictCheckerConfig,
  selectImplementer,
  selectRoleAccount,
  DEFAULT_CONFIG,
  EVENT_TYPES,
} from './types';
import { buildDefaultConfigYaml } from './agents/default-config';
import { DAEMON_UNAVAILABLE_STATUS_LINE } from './kteam';
import YAML from 'yaml';
import type { Config, ImplementerRetryEvent, ImplementerEndEvent } from './types';
import {
  DEFAULT_RE_SYNTHESIS_PROMPT,
  DEFAULT_IMPLEMENTER_PROMPT,
  REVIEWER_PLUMBING_PROMPT,
  REVIEW_LENS_PROFILES,
} from './agents/default-prompts';
import { AgentRunner, DaemonUnavailableError, validateAgentsOrThrow, type KteamExec } from './agents/runner';
import * as fsp from 'fs/promises';
import * as nodeOs from 'os';
import * as nodePath from 'path';

describe('Placeholder', () => {
  it('should pass basic verification', () => {
    expect(true).toBe(true);
  });
});

describe('Config parsing', () => {
  it('parses a minimal config with defaults', () => {
    const config = parseRawConfig({});
    expect(config.implementers).toEqual({ claude: 1 });
    expect(config.synthesis).toBe(true);
    expect(config.verify).toBe(true);
    expect(config.verifyPhases).toEqual([['claude:claude']]);
    expect(config.verifyTimeout).toBe(5);
    expect(config.synthesisTimeout).toBe(15);
    expect(config.rerankAfterCheckpoint).toBe(true);
    expect(config.implementerRetry).toEqual({ maxRetries: 2, backoffBaseMs: 5000 });
    expect(config.firstIterationWeightMultiplier).toBe(2);
  });

  it('parses config with verify enabled and custom phases', () => {
    const config = parseRawConfig({
      verify: true,
      verifyPhases: [['claude-haiku:claude', 'gemini-fast:gemini']],
    });
    expect(config.verify).toBe(true);
    expect(config.verifyPhases).toEqual([['claude-haiku:claude', 'gemini-fast:gemini']]);
    expect(config.verifyTimeout).toBe(5); // default timeout
  });

  it('parses legacy reReview shape into flat fields', () => {
    const config = parseRawConfig({
      reReview: { enabled: true, phases: [['claude-haiku:claude']], timeout: 10 },
    });
    expect(config.verify).toBe(true);
    expect(config.verifyPhases).toEqual([['claude-haiku:claude']]);
    expect(config.verifyTimeout).toBe(10);
  });

  it('parses config with rerankAfterCheckpoint enabled', () => {
    const config = parseRawConfig({ rerankAfterCheckpoint: true });
    expect(config.rerankAfterCheckpoint).toBe(true);
  });

  it('parses config with synthesis disabled', () => {
    const config = parseRawConfig({ synthesis: false });
    expect(config.synthesis).toBe(false);
  });

  it('parses legacy nested synthesis shape', () => {
    const config = parseRawConfig({ synthesis: { enabled: false } });
    expect(config.synthesis).toBe(false);
  });

  it('parses config with implementerRetry custom values', () => {
    const config = parseRawConfig({ implementerRetry: { maxRetries: 5, backoffBaseMs: 10000 } });
    expect(config.implementerRetry.maxRetries).toBe(5);
    expect(config.implementerRetry.backoffBaseMs).toBe(10000);
  });

  it('parses config with firstIterationWeightMultiplier', () => {
    const config = parseRawConfig({ firstIterationWeightMultiplier: 3 });
    expect(config.firstIterationWeightMultiplier).toBe(3);
  });

  it('parses config with all fields explicitly set', () => {
    const config = parseRawConfig({
      verify: true,
      verifyPhases: [['haiku:claude']],
      verifyTimeout: 10,
      rerankAfterCheckpoint: true,
      synthesis: false,
      synthesisTimeout: 20,
      implementerRetry: { maxRetries: 3, backoffBaseMs: 8000 },
      firstIterationWeightMultiplier: 4,
      prompts: {
        synthesizer: 'Custom synthesizer prompt',
        verifier: 'Custom verifier prompt',
        reSynthesizer: 'Custom re-synthesis prompt',
      },
    });
    expect(config.verify).toBe(true);
    expect(config.verifyTimeout).toBe(10);
    expect(config.rerankAfterCheckpoint).toBe(true);
    expect(config.synthesis).toBe(false);
    expect(config.synthesisTimeout).toBe(20);
    expect(config.implementerRetry.maxRetries).toBe(3);
    expect(config.firstIterationWeightMultiplier).toBe(4);
    expect(config.prompts?.synthesizer).toBe('Custom synthesizer prompt');
    expect(config.prompts?.verifier).toBe('Custom verifier prompt');
    expect(config.prompts?.reSynthesizer).toBe('Custom re-synthesis prompt');
  });

  it('parses legacy reReviewer prompt into verifier', () => {
    const config = parseRawConfig({
      prompts: { reReviewer: 'old prompt' },
    });
    expect(config.prompts?.verifier).toBe('old prompt');
  });

  it('default config YAML parses under the kteam-only schema', () => {
    // The generated default config no longer carries interactive/agentBackend.
    const config = parseRawConfig(YAML.parse(buildDefaultConfigYaml()));
    expect((config as Record<string, unknown>).agentBackend).toBeUndefined();
    expect((config as Record<string, unknown>).interactive).toBeUndefined();
  });

  it('strips removed interactive/agentBackend fields from old configs', () => {
    // Extra (now-removed) keys are dropped by zod rather than breaking the parse.
    const config = parseRawConfig({ interactive: true, agentBackend: 'tmux' } as any);
    expect((config as Record<string, unknown>).interactive).toBeUndefined();
    expect((config as Record<string, unknown>).agentBackend).toBeUndefined();
  });

  it('defaults match DEFAULT_CONFIG', () => {
    const config = parseRawConfig({});
    expect(config.synthesis).toEqual(DEFAULT_CONFIG.synthesis);
    expect(config.verify).toEqual(DEFAULT_CONFIG.verify);
    expect(config.verifyPhases).toEqual(DEFAULT_CONFIG.verifyPhases);
    expect(config.verifyTimeout).toEqual(DEFAULT_CONFIG.verifyTimeout);
    expect(config.synthesisTimeout).toEqual(DEFAULT_CONFIG.synthesisTimeout);
    expect(config.rerankAfterCheckpoint).toEqual(DEFAULT_CONFIG.rerankAfterCheckpoint);
    expect(config.implementerRetry).toEqual(DEFAULT_CONFIG.implementerRetry);
    expect(config.firstIterationWeightMultiplier).toEqual(DEFAULT_CONFIG.firstIterationWeightMultiplier);
  });
});

describe('Implementer prompt building', () => {
  it('replaces missing reviewSummaryPath with an empty string', () => {
    const prompt = buildImplementerPrompt(undefined, {
      specPath: '/tmp/spec.md',
      iteration: '1',
      reviewsDir: '/tmp/reviews',
      evidenceDir: '/tmp/evidence',
      learningsFile: '/tmp/learnings.md',
    });

    expect(prompt.includes('{reviewSummaryPath}')).toBe(false);
    expect(prompt).toContain('Synthesized review summary (loop 2+): ');
  });
});

describe('::i implementer suffix parsing', () => {
  it('parses bare implementer without ::i suffix', () => {
    const result = parseImplementerConfig('claude-auto-opus');
    expect(result).toEqual({
      binary: 'claude-auto-opus',
      harness: 'claude',
      firstIterationPreferred: false,
    });
  });

  it('parses implementer with ::i suffix', () => {
    const result = parseImplementerConfig('claude-auto-opus::i');
    expect(result).toEqual({
      binary: 'claude-auto-opus',
      harness: 'claude',
      firstIterationPreferred: true,
    });
  });

  it('parses binary:harness with ::i suffix', () => {
    const result = parseImplementerConfig('gemini-auto:gemini::i');
    expect(result).toEqual({
      binary: 'gemini-auto',
      harness: 'gemini',
      firstIterationPreferred: true,
    });
  });

  it('parses binary:harness without ::i suffix', () => {
    const result = parseImplementerConfig('gemini-auto:gemini');
    expect(result).toEqual({
      binary: 'gemini-auto',
      harness: 'gemini',
      firstIterationPreferred: false,
    });
  });

  it('throws on empty config', () => {
    expect(() => parseImplementerConfig('')).toThrow('cannot be empty');
  });

  it('throws on too many colons', () => {
    expect(() => parseImplementerConfig('a:b:c')).toThrow('too many colons');
  });

  it('parses codex implementer config', () => {
    const result = parseImplementerConfig('codex-personal:codex');
    expect(result).toEqual({
      binary: 'codex-personal',
      harness: 'codex',
      firstIterationPreferred: false,
    });
  });

  it('parses codex implementer config with ::i suffix', () => {
    const result = parseImplementerConfig('codex-personal:codex::i');
    expect(result).toEqual({
      binary: 'codex-personal',
      harness: 'codex',
      firstIterationPreferred: true,
    });
  });
});

// ============================================================================
// Re-synthesis prompt building
// ============================================================================

describe('Re-synthesis prompt building', () => {
  const baseVars = {
    specPath: '/tmp/spec.md',
    iteration: '3',
    previousSummaryPath: '/tmp/loop-2/review-summary.md',
    verifyDir: '/tmp/loop-3/verify',
    verdictsDir: '/tmp/loop-3/verdicts',
    summaryOutputPath: '/tmp/loop-3/synthesis',
    learningsFile: '/tmp/learnings.md',
  };

  it('substitutes all placeholders in default template', () => {
    const prompt = buildReSynthesisPrompt(undefined, baseVars);
    // All placeholders should be resolved — none of our vars should remain as {key}
    expect(prompt.includes('{specPath}')).toBe(false);
    expect(prompt.includes('{iteration}')).toBe(false);
    expect(prompt.includes('{previousSummaryPath}')).toBe(false);
    expect(prompt.includes('{verifyDir}')).toBe(false);
    expect(prompt.includes('{verdictsDir}')).toBe(false);
    expect(prompt.includes('{summaryOutputPath}')).toBe(false);
    expect(prompt.includes('{learningsFile}')).toBe(false);
    // Actual values should appear
    expect(prompt).toContain('/tmp/spec.md');
    expect(prompt).toContain('loop 3');
    expect(prompt).toContain('/tmp/loop-2/review-summary.md');
    expect(prompt).toContain('/tmp/loop-3/verify');
    expect(prompt).toContain('/tmp/loop-3/synthesis');
  });

  it('uses custom template when provided', () => {
    const custom = 'Spec: {specPath}, Loop: {iteration}, Verify: {verifyDir}';
    const prompt = buildReSynthesisPrompt(custom, baseVars);
    expect(prompt).toBe('Spec: /tmp/spec.md, Loop: 3, Verify: /tmp/loop-3/verify');
  });

  it('leaves unknown placeholders intact', () => {
    const custom = '{specPath} and {unknownPlaceholder}';
    const prompt = buildReSynthesisPrompt(custom, baseVars);
    expect(prompt).toBe('/tmp/spec.md and {unknownPlaceholder}');
  });
});

// ============================================================================
// Synthesizer prompt building
// ============================================================================

describe('Synthesizer prompt building', () => {
  const baseVars = {
    specPath: '/tmp/spec.md',
    iteration: '2',
    reviewsDir: '/tmp/loop-2/reviews',
    verdictsDir: '/tmp/loop-2/verdicts',
    previousSummaryPath: '/tmp/loop-1/review-summary.md',
    summaryOutputPath: '/tmp/loop-2/synthesis',
    learningsFile: '/tmp/learnings.md',
    evidenceDir: '/tmp/loop-2/evidence',
  };

  it('substitutes all placeholders in default template', () => {
    const prompt = buildSynthesizerPrompt(undefined, baseVars);
    expect(prompt.includes('{specPath}')).toBe(false);
    expect(prompt.includes('{iteration}')).toBe(false);
    expect(prompt.includes('{reviewsDir}')).toBe(false);
    expect(prompt.includes('{verdictsDir}')).toBe(false);
    expect(prompt.includes('{summaryOutputPath}')).toBe(false);
    expect(prompt).toContain('/tmp/spec.md');
    expect(prompt).toContain('/tmp/loop-2/reviews');
  });

  it('uses custom template when provided', () => {
    const custom = 'Reviews at {reviewsDir}, output to {summaryOutputPath}';
    const prompt = buildSynthesizerPrompt(custom, baseVars);
    expect(prompt).toBe('Reviews at /tmp/loop-2/reviews, output to /tmp/loop-2/synthesis');
  });
});

// ============================================================================
// Verifier prompt building
// ============================================================================

describe('Verifier prompt building', () => {
  const baseVars = {
    specPath: '/tmp/spec.md',
    iteration: '3',
    previousSummaryPath: '/tmp/loop-2/review-summary.md',
    reviewsDir: '/tmp/loop-3/reviews',
    verdictsDir: '/tmp/loop-3/verdicts',
    evidenceDir: '/tmp/loop-3/evidence',
    learningsFile: '/tmp/learnings.md',
    verifierIndex: '0',
  };

  it('substitutes all placeholders in default template', () => {
    const prompt = buildVerifierPrompt(undefined, baseVars);
    expect(prompt.includes('{specPath}')).toBe(false);
    expect(prompt.includes('{verifierIndex}')).toBe(false);
    expect(prompt).toContain('/tmp/spec.md');
    expect(prompt).toContain('/tmp/loop-2/review-summary.md');
  });

  it('uses custom template when provided', () => {
    const custom = 'Verifier {verifierIndex} checking {previousSummaryPath}';
    const prompt = buildVerifierPrompt(custom, baseVars);
    expect(prompt).toBe('Verifier 0 checking /tmp/loop-2/review-summary.md');
  });
});

// ============================================================================
// Default prompt content verification
// ============================================================================

describe('Default prompt templates', () => {
  it('implementer prompt includes self-review step', () => {
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('Self-review your changes');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('self-review.md');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{evidenceDir}/self-review.md');
  });

  it('implementer prompt includes addressed-reviews step', () => {
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('addressed-reviews.md');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{evidenceDir}/addressed-reviews.md');
  });

  it('implementer prompt has all required placeholders', () => {
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{specPath}');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{iteration}');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{reviewsDir}');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{evidenceDir}');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{learningsFile}');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{reviewSummaryPath}');
  });

  it('re-synthesis prompt has all required placeholders', () => {
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{specPath}');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{iteration}');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{previousSummaryPath}');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{verifyDir}');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{verdictsDir}');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{summaryOutputPath}');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('{learningsFile}');
  });

  it('re-synthesis prompt describes lightweight merge behavior', () => {
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('LIGHTWEIGHT synthesis');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('verifier');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('Issues Requiring Action');
    expect(DEFAULT_RE_SYNTHESIS_PROMPT).toContain('Confirmed Complete');
  });

  it('self-review step comes before addressed-reviews step', () => {
    const selfReviewIdx = DEFAULT_IMPLEMENTER_PROMPT.indexOf('Self-review your changes');
    const addressedIdx = DEFAULT_IMPLEMENTER_PROMPT.indexOf('Document how you addressed');
    expect(selfReviewIdx).toBeLessThan(addressedIdx);
  });

  it('implementer prompt defines the Type 1 / Type 2 evidence model', () => {
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('Type 1');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('Type 2');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('automated proof');
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('code-review proof');
    // Type-1 capture still pipes real command output into the evidence folder.
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('{evidenceDir}/<criterion>.log');
    // Hollow commands are explicitly disallowed.
    expect(DEFAULT_IMPLEMENTER_PROMPT).toContain('assert true');
  });

  it('reviewer prompt gates each criterion on its evidence type', () => {
    // Evidence gating lives in the LENS now (general carries the whole job; completion owns
    // it as its focused slice) — the plumbing is lens-neutral mechanics.
    expect(REVIEW_LENS_PROFILES.general).toContain('Type 1');
    expect(REVIEW_LENS_PROFILES.general).toContain('Type 2');
    expect(REVIEW_LENS_PROFILES.general).toContain('hollow');
    expect(REVIEW_LENS_PROFILES.completion).toContain('Type 1');
    // The plumbing still points reviewers at the evidence folder + the self-review index.
    expect(REVIEWER_PLUMBING_PROMPT).toContain('self-review.md');
    expect(REVIEWER_PLUMBING_PROMPT).toContain('{evidenceDir}/');
  });

  it('no prompt requires a .meta sidecar', () => {
    expect(DEFAULT_IMPLEMENTER_PROMPT).not.toContain('.meta');
    expect(REVIEWER_PLUMBING_PROMPT).not.toContain('.meta');
  });
});

// ============================================================================
// selectImplementer with firstIterationWeightMultiplier
// ============================================================================

describe('selectImplementer', () => {
  it('returns a valid implementer binary from config', () => {
    const config = parseRawConfig({ implementers: { 'claude-a': 1, 'claude-b': 1 } });
    const result = selectImplementer(config, 1);
    expect(['claude-a', 'claude-b']).toContain(result);
  });

  it('returns the only implementer when there is one', () => {
    const config = parseRawConfig({ implementers: { 'solo-impl': 1 } });
    expect(selectImplementer(config, 1)).toBe('solo-impl');
    expect(selectImplementer(config, 5)).toBe('solo-impl');
  });

  it('respects firstIterationWeightMultiplier on loop 1 for ::i implementers', () => {
    // With a very high multiplier, the ::i implementer should almost always win on loop 1
    const config = parseRawConfig({
      implementers: { 'fast::i': 1, slow: 1 },
      firstIterationWeightMultiplier: 10,
    });
    // Run 100 selections — with 10x weight, fast::i should dominate
    const counts = { 'fast::i': 0, slow: 0 };
    for (let i = 0; i < 100; i++) {
      const pick = selectImplementer(config, 1);
      counts[pick as keyof typeof counts]++;
    }
    // With 10:1 weight ratio, expect fast::i > 80% of the time
    expect(counts['fast::i']).toBeGreaterThan(80);
  });

  it('does not boost ::i implementers on loop 2+', () => {
    const config = parseRawConfig({
      implementers: { 'fast::i': 1, slow: 1 },
      firstIterationWeightMultiplier: 10,
    });
    // On loop 2, both should have equal weight (no multiplier)
    const counts = { 'fast::i': 0, slow: 0 };
    for (let i = 0; i < 200; i++) {
      const pick = selectImplementer(config, 2);
      counts[pick as keyof typeof counts]++;
    }
    // With equal weights, expect roughly 50/50 — allow wide margin (30-70%)
    expect(counts['fast::i']).toBeGreaterThan(30);
    expect(counts['slow']).toBeGreaterThan(30);
  });

  it('uses default multiplier of 2 when not specified', () => {
    const config = parseRawConfig({ implementers: { 'boost::i': 1, normal: 1 } });
    expect(config.firstIterationWeightMultiplier).toBe(2);
  });
});

// ============================================================================
// EVENT_TYPES constants
// ============================================================================

describe('EVENT_TYPES', () => {
  it('includes IMPLEMENTER_RETRY event type', () => {
    expect(EVENT_TYPES.IMPLEMENTER_RETRY).toBe('implementer_retry');
  });

  it('includes CRASHED event type', () => {
    expect(EVENT_TYPES.CRASHED).toBe('crashed');
  });

  it('includes all synthesis-related event types', () => {
    expect(EVENT_TYPES.SYNTHESIS_START).toBe('synthesis_start');
    expect(EVENT_TYPES.SYNTHESIS_END).toBe('synthesis_end');
  });

  it('includes all verify event types', () => {
    expect(EVENT_TYPES.VERIFY_PHASE_START).toBe('verify_phase_start');
    expect(EVENT_TYPES.VERIFIER_START).toBe('verifier_start');
    expect(EVENT_TYPES.VERIFIER_END).toBe('verifier_end');
    expect(EVENT_TYPES.VERIFY_PHASE_END).toBe('verify_phase_end');
  });
});

// ============================================================================
// Config validation edge cases
// ============================================================================

describe('Config validation edge cases', () => {
  it('rejects dynamicReviewOrdering (removed field)', () => {
    // Old config shape should be ignored (extra fields are stripped by zod)
    const config = parseRawConfig({ dynamicReviewOrdering: { enabled: true } } as any);
    // Should not have dynamicReviewOrdering — it's gone
    expect((config as any).dynamicReviewOrdering).toBeUndefined();
    // rerankAfterCheckpoint should use default
    expect(config.rerankAfterCheckpoint).toBe(true);
  });

  it('clamps implementerRetry.maxRetries within schema bounds', () => {
    // Valid range is 0-10
    const config = parseRawConfig({ implementerRetry: { maxRetries: 0, backoffBaseMs: 1000 } });
    expect(config.implementerRetry.maxRetries).toBe(0);
  });

  it('allows maxRetries of 10', () => {
    const config = parseRawConfig({ implementerRetry: { maxRetries: 10, backoffBaseMs: 100 } });
    expect(config.implementerRetry.maxRetries).toBe(10);
  });

  it('allows backoffBaseMs of 0', () => {
    const config = parseRawConfig({ implementerRetry: { maxRetries: 1, backoffBaseMs: 0 } });
    expect(config.implementerRetry.backoffBaseMs).toBe(0);
  });

  it('defaults implementerRetry when omitted entirely', () => {
    const config = parseRawConfig({});
    expect(config.implementerRetry).toEqual({ maxRetries: 2, backoffBaseMs: 5000 });
  });

  it('firstIterationWeightMultiplier defaults to 2', () => {
    const config = parseRawConfig({});
    expect(config.firstIterationWeightMultiplier).toBe(2);
  });

  it('firstIterationWeightMultiplier allows min value 1', () => {
    const config = parseRawConfig({ firstIterationWeightMultiplier: 1 });
    expect(config.firstIterationWeightMultiplier).toBe(1);
  });

  it('firstIterationWeightMultiplier allows max value 10', () => {
    const config = parseRawConfig({ firstIterationWeightMultiplier: 10 });
    expect(config.firstIterationWeightMultiplier).toBe(10);
  });

  it('reSynthesizer prompt is optional in config', () => {
    const config = parseRawConfig({});
    expect(config.prompts).toBeUndefined();

    const withPrompt = parseRawConfig({ prompts: { reSynthesizer: 'custom' } });
    expect(withPrompt.prompts?.reSynthesizer).toBe('custom');
  });

  it('preserves all prompt fields when set', () => {
    const config = parseRawConfig({
      prompts: {
        implementer: 'impl',
        reviewer: 'rev',
        synthesizer: 'synth',
        verifier: 'verify',
        reSynthesizer: 'resynth',
      },
    });
    expect(config.prompts?.implementer).toBe('impl');
    expect(config.prompts?.reviewer).toBe('rev');
    expect(config.prompts?.synthesizer).toBe('synth');
    expect(config.prompts?.verifier).toBe('verify');
    expect(config.prompts?.reSynthesizer).toBe('resynth');
  });

  it('verify defaults match DEFAULT_CONFIG', () => {
    const config = parseRawConfig({});
    expect(config.verify).toEqual(DEFAULT_CONFIG.verify);
    expect(config.verifyPhases).toEqual(DEFAULT_CONFIG.verifyPhases);
    expect(config.verifyTimeout).toEqual(DEFAULT_CONFIG.verifyTimeout);
  });

  it('synthesis defaults to true', () => {
    const config = parseRawConfig({});
    expect(config.synthesis).toBe(true);
    expect(config.synthesisTimeout).toBe(15);
  });

  it('synthesizer binary defaults to undefined', () => {
    const config = parseRawConfig({});
    expect(config.synthesizer).toBeUndefined();
  });

  it('synthesizer binary can be explicitly set', () => {
    const config = parseRawConfig({ synthesizer: 'gemini:gemini' });
    expect(config.synthesizer).toBe('gemini:gemini');
  });

  it('synthesizer accepts an inline weighted pool', () => {
    const config = parseRawConfig({ synthesizer: { 'a:claude': 1, 'b:claude': 1 } });
    expect(config.synthesizer).toEqual({ 'a:claude': 1, 'b:claude': 1 });
  });

  it('conflictChecker accepts an inline weighted pool', () => {
    const config = parseRawConfig({ conflictChecker: { 'a:claude': 1, 'b:claude': 1 } });
    expect(config.conflictChecker).toEqual({ 'a:claude': 1, 'b:claude': 1 });
  });
});

describe('selectRoleAccount (synthesizer / checkpointer pool resolution)', () => {
  it('returns undefined when the entry is unset (caller keeps its fallback)', () => {
    expect(selectRoleAccount(undefined)).toBeUndefined();
  });

  it('returns a plain account string unchanged', () => {
    expect(selectRoleAccount('gemini:gemini')).toBe('gemini:gemini');
  });

  it('expands a pool-profile NAME via poolProfiles', () => {
    const picked = selectRoleAccount('fast', { fast: { 'only:claude': 1 } });
    expect(picked).toBe('only:claude');
  });

  it('picks from an inline pool (load distribution)', () => {
    const picked = selectRoleAccount({ 'a:claude': 1, 'b:claude': 1 });
    expect(['a:claude', 'b:claude']).toContain(picked);
  });
});

// ============================================================================
// Codex harness config parsing
// ============================================================================

describe('Codex config parsing', () => {
  it('parseReviewerConfig parses codex reviewer with flag 0', () => {
    const result = parseReviewerConfig('codex-personal:codex:0');
    expect(result).toEqual({
      binary: 'codex-personal',
      harness: 'codex',
      firstIterationPreferred: false,
      noVerdictAsFailure: false,
    });
  });

  it('parseReviewerConfig parses codex reviewer with flag 1', () => {
    const result = parseReviewerConfig('codex-personal:codex:1');
    expect(result).toEqual({
      binary: 'codex-personal',
      harness: 'codex',
      firstIterationPreferred: false,
      noVerdictAsFailure: true,
    });
  });

  it('parseConflictCheckerConfig parses codex conflict checker', () => {
    const result = parseConflictCheckerConfig('codex-personal:codex');
    expect(result).toEqual({
      binary: 'codex-personal',
      harness: 'codex',
      firstIterationPreferred: false,
    });
  });

  it('rejects invalid harness type', () => {
    expect(() => parseImplementerConfig('foo:unknown')).toThrow('Invalid harness type');
    expect(() => parseImplementerConfig('foo:unknown')).toThrow('"codex"');
  });

  it('rejects invalid reviewer flag for codex', () => {
    expect(() => parseReviewerConfig('codex-personal:codex:2')).toThrow('reviewer flag must be 0 or 1');
  });
});

// ============================================================================
// kteam dispatch: outcome mapping + session-per-agent lifecycle (mocked kteam)
// ============================================================================

type LaunchArgs = {
  binary: string;
  promptFile: string;
  logFile: string;
  timeout: number;
  runId: string;
  name: string;
  outputFile?: string;
};
type LaunchResult = {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  model?: string;
  harnessSessionId?: string;
};

/**
 * A fake `kteam` CLI. Records every invocation; `start` returns a SessionView,
 * `wait` returns the scripted terminal status, `logs` returns a line. `onStart`
 * lets a test simulate the agent writing its deliverable file. `daemonDown`
 * makes every call fail with the daemon-unavailable signature.
 */
function makeKteam(opts: {
  status: string;
  model?: string;
  daemonDown?: boolean;
  onStart?: (args: string[]) => void | Promise<void>;
}): { exec: KteamExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: KteamExec = async args => {
    calls.push(args);
    if (opts.daemonDown) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'kteam daemon is unavailable at http://127.0.0.1:7337; run `kteam daemon start`',
      };
    }
    if (args[0] === 'start') {
      if (opts.onStart) await opts.onStart(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ config: { id: 'sess-1', model: opts.model, harnessSessionId: 'harness-1' } }),
        stderr: '',
      };
    }
    // kteam wait --json prints the state as PRETTY-PRINTED (multi-line) JSON —
    // mirror that so the runner's full-stdout parse is exercised (a last-line
    // parse would only ever see the closing brace and hang the poll loop).
    if (args[0] === 'wait')
      return { exitCode: 0, stdout: JSON.stringify({ status: opts.status }, null, 2), stderr: '' };
    if (args[0] === 'logs') return { exitCode: 0, stdout: 'transcript line\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function makeRunner(exec: KteamExec) {
  const config = parseRawConfig({ implementers: { 'claude-auto-x': 1 } });
  const runner = new AgentRunner({} as unknown as import('./deps').StateService, config, undefined, undefined, exec);
  return runner as unknown as { launch(p: LaunchArgs): Promise<LaunchResult> };
}

describe('AgentRunner.launch — kteam outcome mapping', () => {
  async function launchWith(opts: Parameters<typeof makeKteam>[0], outputFile?: string) {
    const dir = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'kloop-launch-'));
    const { exec, calls } = makeKteam(opts);
    const runner = makeRunner(exec);
    const result = await runner.launch({
      binary: 'claude-auto-x',
      promptFile: nodePath.join(dir, 'prompt.txt'),
      logFile: nodePath.join(dir, 'log'),
      timeout: 1,
      runId: 'run1',
      name: 'kloop-run1-1-impl',
      outputFile,
    });
    return { result, calls, dir };
  }

  it('maps kteam completed → exit 0', async () => {
    const { result } = await launchWith({ status: 'completed', model: 'claude-opus-4-8' });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.model).toBe('claude-opus-4-8');
    expect(result.harnessSessionId).toBe('harness-1');
  });

  it('maps kteam failed → exit 1 (crash, retryable)', async () => {
    const { result } = await launchWith({ status: 'failed' });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it('maps kteam stalled → exit 1 + timedOut (kteamd owns stall)', async () => {
    const { result } = await launchWith({ status: 'stalled' });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
  });

  it('maps kteam stopped → exit 124 timeout', async () => {
    const { result } = await launchWith({ status: 'stopped' });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
  });

  it('deliverable on disk trumps a non-completed session verdict', async () => {
    const dir = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'kloop-launch-'));
    const outputFile = nodePath.join(dir, 'verdict.json');
    // The fake agent writes its deliverable during `start`, even though the session ends 'failed'.
    const { exec } = makeKteam({ status: 'failed', onStart: () => fsp.writeFile(outputFile, '{"approved":true}') });
    const runner = makeRunner(exec);
    const result = await runner.launch({
      binary: 'claude-auto-x',
      promptFile: nodePath.join(dir, 'p'),
      logFile: nodePath.join(dir, 'log'),
      timeout: 1,
      runId: 'run1',
      name: 'rev',
      outputFile,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('throws DaemonUnavailableError when the daemon is unreachable', async () => {
    const { exec } = makeKteam({ status: 'completed', daemonDown: true });
    const runner = makeRunner(exec);
    await expect(
      runner.launch({
        binary: 'claude-auto-x',
        promptFile: '/tmp/p',
        logFile: '/tmp/kloop-daemon-down.log',
        timeout: 1,
        runId: 'run1',
        name: 'impl',
      }),
    ).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it('starts a session-per-agent with --mode auto, the kloop label, and the prompt file', async () => {
    const { calls } = await launchWith({ status: 'completed' });
    const start = calls.find(c => c[0] === 'start');
    expect(start).toBeDefined();
    expect(start).toContain('--mode');
    expect(start![start!.indexOf('--mode') + 1]).toBe('auto');
    expect(start).toContain('--label');
    expect(start![start!.indexOf('--label') + 1]).toBe('kloop-run1');
    expect(start).toContain('--prompt-file');
    expect(start).toContain('-a');
    expect(start![start!.indexOf('-a') + 1]).toBe('claude-auto-x');
    // The transcript is mirrored to the log file (kteam logs called).
    expect(calls.some(c => c[0] === 'logs')).toBe(true);
  });
});

// ============================================================================
// Agent validation: gemini dropped + kfleet wrapper existence
// ============================================================================

describe('validateAgentsOrThrow', () => {
  it('rejects a configured gemini-harness agent', () => {
    const config = parseRawConfig({ implementers: { 'gemini-auto:gemini': 1 } });
    expect(() => validateAgentsOrThrow(config, ['claude-auto-x'])).toThrow(/gemini/i);
  });

  it('rejects a fleet-wrapper name that is not installed', () => {
    const config = parseRawConfig({ implementers: { 'claude-auto-missing': 1 } });
    expect(() => validateAgentsOrThrow(config, ['claude-auto-x'])).toThrow(/not installed/i);
  });

  it('passes when configured wrappers are installed', () => {
    const config = parseRawConfig({
      implementers: { 'claude-auto-x': 1 },
      reviewPhases: [['claude-auto-y']],
    });
    expect(() => validateAgentsOrThrow(config, ['claude-auto-x', 'claude-auto-y'])).not.toThrow();
  });

  it('skips the install check when no wrappers are discoverable (dev/test env)', () => {
    const config = parseRawConfig({ implementers: { 'claude-auto-x': 1 } });
    expect(() => validateAgentsOrThrow(config, [])).not.toThrow();
  });

  it('the generated default config validates against its real fleet wrappers', () => {
    // Regression: default `kloop init` must not seed bare non-fleet names that pass
    // kloop validation then fail at `kteam start`. The template now uses real wrappers.
    const config = parseRawConfig(YAML.parse(buildDefaultConfigYaml()));
    expect(() => validateAgentsOrThrow(config, ['claude-auto-liftoff', 'codex-auto-loio'])).not.toThrow();
  });
});

// ============================================================================
// Daemon-unavailable → kautopilot 'unavailable' (not 'crash') contract
// ============================================================================

/**
 * Replica of kautopilot's `devloopVerify` classification
 * (modules/kautopilot-ts/src/core/devloop.ts — which kloop must NOT edit). It reads
 * `kloop status --json` and routes on (exitCode, stdout). Pinned here so kloop's
 * daemon-down emission is proven to land on 'unavailable', not 'crash'.
 */
function devloopVerifyOutcome(exitCode: number, stdout: string): string {
  if (exitCode !== 0) return 'crash';
  try {
    const data = JSON.parse(stdout.trim()) as { status?: string; exitReason?: string };
    const status = String(data.status ?? '');
    if (data.exitReason === 'max_iterations') return 'max_iterations';
    if (status === 'running') return 'running';
    if (status === 'conflict') return 'conflict';
    if (status === 'completed') return 'completed';
    if (status === 'failed' || status === 'cancelled') return 'crash';
    return 'crash';
  } catch {
    return 'unavailable';
  }
}

describe('daemon-unavailable → kautopilot unavailable contract', () => {
  it('kloop status daemon-down line (exit 0, non-JSON) classifies as unavailable — never crash', () => {
    // This is what `kloop status --json` prints for a non-terminal run when kteamd is down.
    expect(() => JSON.parse(DAEMON_UNAVAILABLE_STATUS_LINE)).toThrow(); // deliberately NOT valid JSON
    expect(devloopVerifyOutcome(0, DAEMON_UNAVAILABLE_STATUS_LINE)).toBe('unavailable');
  });

  it('leaves the existing status→outcome contract unchanged', () => {
    expect(devloopVerifyOutcome(0, JSON.stringify({ status: 'completed', exitReason: 'consensus' }))).toBe('completed');
    expect(devloopVerifyOutcome(0, JSON.stringify({ status: 'completed', exitReason: 'max_iterations' }))).toBe(
      'max_iterations',
    );
    expect(devloopVerifyOutcome(0, JSON.stringify({ status: 'conflict' }))).toBe('conflict');
    expect(devloopVerifyOutcome(0, JSON.stringify({ status: 'running' }))).toBe('running');
    expect(devloopVerifyOutcome(0, JSON.stringify({ status: 'failed' }))).toBe('crash');
  });

  it('a run kloop cannot find (nonzero exit) is crash, distinct from daemon-unavailable', () => {
    expect(devloopVerifyOutcome(1, '')).toBe('crash');
  });
});
