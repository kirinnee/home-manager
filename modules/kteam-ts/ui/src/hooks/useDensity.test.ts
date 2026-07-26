import { describe, expect, test } from 'bun:test';
import { DENSITY_OPTIONS, implicitDensity } from './useDensity';

describe('density preference', () => {
  test('uses the approved phone and desktop defaults', () => {
    expect(implicitDensity(true)).toBe('compact');
    expect(implicitDensity(false)).toBe('full');
  });

  test('offers all three visible levels in the approved order', () => {
    expect(DENSITY_OPTIONS.map(option => option.id)).toEqual(['full', 'compact', 'minimal']);
    expect(DENSITY_OPTIONS.find(option => option.id === 'minimal')?.description).toContain('Name and task only');
  });
});
