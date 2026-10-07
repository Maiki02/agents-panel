import { describe, expect, it } from 'vitest';
import { usageTone } from '../src/usage.js';

describe('usageTone', () => {
  it.each([
    [0, 'ok'],
    [69, 'ok'],
    [70, 'warn'],
    [89, 'warn'],
    [90, 'danger'],
    [100, 'danger'],
  ] as const)('%i %% is %s', (utilization, tone) => {
    expect(usageTone({ utilization, status: 'allowed' })).toBe(tone);
  });

  it('rejected is danger whatever the utilization', () => {
    expect(usageTone({ utilization: 5, status: 'rejected' })).toBe('danger');
    expect(usageTone({ utilization: null, status: 'rejected' })).toBe('danger');
  });

  it('without utilization the tone comes from the status', () => {
    expect(usageTone({ utilization: null, status: 'allowed_warning' })).toBe('warn');
    expect(usageTone({ utilization: null, status: 'allowed' })).toBe('ok');
    expect(usageTone({ utilization: null, status: null })).toBe('ok');
  });
});
