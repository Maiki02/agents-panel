import { describe, expect, it } from 'vitest';
import type { UsageWindow } from '@agents-panel/shared';
import {
  formatAgo,
  formatPercent,
  formatReset,
  headlinePercent,
  headlineTone,
  sortWindows,
  toneClasses,
  windowLabel,
  windowTone,
} from './usage-logic';

const win = (window: string, utilization: number | null, status: UsageWindow['status'] = null) =>
  ({ window, utilization, status, resetsAt: null, source: 'event', observedAt: 0 }) as UsageWindow;

describe('formatAgo', () => {
  const now = 10_000_000;
  it('says now under a minute', () => {
    expect(formatAgo(now - 30_000, now)).toBe('ahora');
    expect(formatAgo(now + 5_000, now)).toBe('ahora');
  });
  it('uses minutes, hours and days', () => {
    expect(formatAgo(now - 3 * 60_000, now)).toBe('hace 3 min');
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('hace 2 h');
    expect(formatAgo(now - 49 * 3_600_000, now)).toBe('hace 2 d');
  });
});

describe('sortWindows', () => {
  it('puts 5 h, weekly, then per-model weekly, then unknown ones by name', () => {
    const sorted = sortWindows([
      win('zeta', 1),
      win('seven_day_sonnet', 1),
      win('seven_day', 1),
      win('alfa', 1),
      win('five_hour', 1),
      win('seven_day_opus', 1),
    ]);
    expect(sorted.map((w) => w.window)).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_opus',
      'seven_day_sonnet',
      'alfa',
      'zeta',
    ]);
  });
  it('does not mutate its input', () => {
    const input = [win('seven_day', 1), win('five_hour', 1)];
    sortWindows(input);
    expect(input[0]?.window).toBe('seven_day');
  });
});

describe('tone by threshold (usageTone of shared)', () => {
  it('maps utilization and status to ok, warn and danger', () => {
    expect(windowTone(win('five_hour', 10))).toBe('ok');
    expect(windowTone(win('five_hour', 80))).toBe('warn');
    expect(windowTone(win('five_hour', 97))).toBe('danger');
    expect(windowTone(win('five_hour', 10, 'rejected'))).toBe('danger');
    expect(windowTone(win('five_hour', null, 'allowed_warning'))).toBe('warn');
  });
  it('maps tones to classes, with a neutral one without data', () => {
    expect(toneClasses('danger').text).toBe('text-danger');
    expect(toneClasses(null).bar).toBe('bg-border');
  });
});

describe('headline of the icon', () => {
  it('is the 5 h window, or nothing without data', () => {
    const windows = [win('seven_day', 90), win('five_hour', 42.4)];
    expect(headlinePercent(windows)).toBe(42.4);
    expect(headlineTone(windows)).toBe('ok');
    expect(headlinePercent([win('seven_day', 90)])).toBeNull();
    expect(headlineTone([])).toBeNull();
    expect(formatPercent(42.4)).toBe('42 %');
    expect(formatPercent(null)).toBe('–');
  });
});

describe('labels and reset time', () => {
  it('names known windows and keeps unknown ones', () => {
    expect(windowLabel('five_hour')).toBe('5 horas');
    expect(windowLabel('seven_day_opus')).toBe('Semanal (Opus)');
    expect(windowLabel('weird')).toBe('weird');
  });
  it('shows only the time for today and the weekday for another day', () => {
    const now = new Date(2026, 9, 6, 10, 0).getTime();
    const sameDay = formatReset(new Date(2026, 9, 6, 14, 30).getTime(), now);
    expect(sameDay).toMatch(/^14:30$/);
    const other = formatReset(new Date(2026, 9, 9, 14, 30).getTime(), now);
    expect(other).toMatch(/14:30$/);
    expect(other.length).toBeGreaterThan(sameDay.length);
  });
});
