import { describe, expect, it } from 'vitest';
import { createdLabel, formatRuntime, runtimeLabel } from './runtime-logic';

describe('runtime formatting', () => {
  it('uses seconds, minutes, or hours and minutes', () => {
    expect(formatRuntime(0)).toBe('0 s');
    expect(formatRuntime(45_000)).toBe('45 s');
    expect(formatRuntime(12 * 60_000 + 20_000)).toBe('12 min');
    expect(formatRuntime(72 * 60_000)).toBe('1 h 12 min');
    expect(formatRuntime(2 * 3_600_000)).toBe('2 h');
    expect(formatRuntime(-5)).toBe('0 s');
  });

  it('prefixes an approximate runtime with ≈', () => {
    expect(runtimeLabel({ runtimeMs: 45_000, runtimeApprox: false })).toBe('45 s');
    expect(runtimeLabel({ runtimeMs: 45_000, runtimeApprox: true })).toBe('≈ 45 s');
  });

  it('formats the creation date as a short local date', () => {
    expect(createdLabel(new Date(2026, 9, 6, 12).getTime())).toMatch(/6.*10.*26/);
  });
});
