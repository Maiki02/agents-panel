import { describe, expect, it } from 'vitest';
import { isNewer, latestLabel, runLabel } from './version-label';

describe('latestLabel', () => {
  it('says unknown when there is no latest (no network)', () => {
    expect(latestLabel('6.1.0', null)).toBe('última: desconocida');
    expect(latestLabel(null, null)).toBe('última: desconocida');
  });

  it('says up to date when installed equals or exceeds latest', () => {
    expect(latestLabel('6.1.0', '6.1.0')).toBe('última: 6.1.0 (al día)');
    expect(latestLabel('6.2.0', '6.1.0')).toBe('última: 6.1.0 (al día)');
  });

  it('flags a newer published version', () => {
    expect(latestLabel('6.1.0', '6.2.0')).toBe('última: 6.2.0 (hay una nueva)');
    expect(latestLabel('6.9.0', '6.10.0')).toBe('última: 6.10.0 (hay una nueva)');
  });
});

describe('isNewer / runLabel', () => {
  it('compares numerically', () => {
    expect(isNewer('6.10.0', '6.9.0')).toBe(true);
    expect(isNewer('6.1.0', '6.1.0')).toBe(false);
  });

  it('shows unknown versions as ?', () => {
    expect(runLabel({ fromVersion: '6.0.0', toVersion: null })).toBe('6.0.0 → ?');
  });
});
