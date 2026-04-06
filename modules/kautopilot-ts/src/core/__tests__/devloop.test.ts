import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeKloopSpec, writeKloopConfig } from '../devloop';
import { existsSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let origHome: string;
let tempHome: string;
beforeAll(() => {
  origHome = process.env.HOME!;
  tempHome = mkdtempSync(join(tmpdir(), 'kautopilot-devloop-test-'));
  process.env.HOME = tempHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe('devloop helpers', () => {
  const testDir = join(process.env.HOME!, '.kautopilot', '__test_devloop__');

  // Clean up before and after
  const cleanup = () => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  };

  describe('writeKloopSpec', () => {
    it('writes spec file to session tmp dir', () => {
      cleanup();
      const specPath = writeKloopSpec('__test_devloop__', '# Test Spec\nHello');
      expect(existsSync(specPath)).toBe(true);
      expect(readFileSync(specPath, 'utf-8')).toBe('# Test Spec\nHello');
      expect(specPath).toContain('__test_devloop__/tmp/kloop-spec.md');
      cleanup();
    });

    it('supports custom filename', () => {
      cleanup();
      const specPath = writeKloopSpec('__test_devloop__', 'content', 'plan-1-spec.md');
      expect(specPath).toContain('plan-1-spec.md');
      cleanup();
    });
  });

  describe('writeKloopConfig', () => {
    it('writes full config yaml to session tmp dir', () => {
      cleanup();
      const configPath = writeKloopConfig('__test_devloop__', {
        implementers: { claude: 1 },
        reviewPhases: [['claude']],
        maxIterations: 5,
        implementerTimeout: 20,
        reviewerTimeout: 10,
        conflictCheckThreshold: 2,
        firstLoopFullReview: false,
        previousReviewPropagation: 0,
        reviewerFailureLimit: 2,
      });
      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('maxIterations: 5');
      expect(content).toContain('implementerTimeout: 20');
      expect(content).toContain('reviewerTimeout: 10');
      expect(content).toContain('conflictCheckThreshold: 2');
      expect(content).toContain('firstLoopFullReview: false');
      expect(content).toContain('previousReviewPropagation: 0');
      cleanup();
    });

    it('passes prompts when configured', () => {
      cleanup();
      const configPath = writeKloopConfig('__test_devloop__', {
        implementers: { claude: 1 },
        reviewPhases: [['claude']],
        maxIterations: 10,
        implementerTimeout: 30,
        reviewerTimeout: 15,
        conflictCheckThreshold: 2,
        firstLoopFullReview: false,
        previousReviewPropagation: 0,
        prompts: {
          implementer: 'Custom implementer prompt',
          reviewer: 'Custom reviewer prompt',
        },
      });
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('Custom implementer prompt');
      expect(content).toContain('Custom reviewer prompt');
      cleanup();
    });
  });
});
