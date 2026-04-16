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
  DEFAULT_CONFIG,
  EVENT_TYPES,
} from './types';
import type { Config, ImplementerRetryEvent, ImplementerEndEvent } from './types';
import { DEFAULT_RE_SYNTHESIS_PROMPT, DEFAULT_IMPLEMENTER_PROMPT } from './agents/default-prompts';
import { tryParseJson } from './stream/parse';

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
// Codex stream normalization
// ============================================================================

describe('Codex stream normalization', () => {
  it('normalizes thread.started to system init', () => {
    const event = tryParseJson('{"type":"thread.started","thread_id":"thread_abc123","created_at":1234567890}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('system');
    if (event!.type === 'system') {
      expect(event!.subtype).toBe('init');
      expect(event!.session_id).toBe('thread_abc123');
    }
  });

  it('normalizes item.completed agent_message to assistant', () => {
    const event = tryParseJson('{"type":"item.completed","item_type":"agent_message","content":"hello world"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('assistant');
    if (event!.type === 'assistant') {
      expect(event!.message.content).toEqual([{ type: 'text', text: 'hello world' }]);
    }
  });

  it('normalizes turn.completed to result with tokens', () => {
    const event = tryParseJson(
      '{"type":"turn.completed","turn_id":0,"usage":{"input_tokens":1000,"output_tokens":500,"total_tokens":1500}}',
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('result');
    if (event!.type === 'result') {
      expect(event!.result.input_tokens).toBe(1000);
      expect(event!.result.output_tokens).toBe(500);
    }
  });

  it('normalizes turn.failed to error', () => {
    const event = tryParseJson(
      '{"type":"turn.failed","turn_id":0,"error":{"type":"Error","message":"API rate limited"}}',
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('error');
    if (event!.type === 'error') {
      expect(event!.error.message).toBe('API rate limited');
    }
  });

  it('suppresses item.started events as unknown', () => {
    const event = tryParseJson('{"type":"item.started","item_id":"msg_001","item_type":"agent_message"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('unknown');
  });

  it('suppresses item.updated events as unknown', () => {
    const event = tryParseJson(
      '{"type":"item.updated","item_id":"msg_001","item_type":"agent_message","content":"partial..."}',
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe('unknown');
  });

  it('does not break Claude system events', () => {
    const event = tryParseJson('{"type":"system","message":"hello"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('system');
  });

  it('does not break Gemini init events', () => {
    const event = tryParseJson('{"type":"init","session_id":"gemini-123","model":"gemini-pro"}');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('system');
    if (event!.type === 'system') {
      expect(event!.subtype).toBe('init');
      expect(event!.session_id).toBe('gemini-123');
    }
  });
});
