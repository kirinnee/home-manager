import { describe, it, expect } from 'bun:test';
import { writeKloopSpec, writeKloopConfig } from '../devloop';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
    it('writes config yaml to session tmp dir', () => {
      cleanup();
      const configPath = writeKloopConfig('__test_devloop__', {
        maxIterations: 5,
        implementerTimeout: 20,
        reviewerTimeout: 10,
      });
      expect(existsSync(configPath)).toBe(true);
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('maxIterations: 5');
      expect(content).toContain('implementerTimeout: 20');
      expect(content).toContain('reviewerTimeout: 10');
      cleanup();
    });
  });
});
