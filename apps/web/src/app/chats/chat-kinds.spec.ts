import { describe, expect, it } from 'vitest';
import { availableKinds, defaultKind, effectiveKind, parseKind } from './chat-kinds';

describe('chat kinds by project', () => {
  it('offers scope, work and direct when the project has Kyro', () => {
    expect(availableKinds({ hasKyro: true }).map((o) => o.kind)).toEqual([
      'work',
      'scope',
      'direct',
    ]);
    expect(defaultKind({ hasKyro: true })).toBe('work');
  });

  it('offers only the direct request without Kyro', () => {
    expect(availableKinds({ hasKyro: false }).map((o) => o.kind)).toEqual(['direct']);
    expect(defaultKind({ hasKyro: false })).toBe('direct');
  });

  it('falls back to the default when the chosen kind is not offered', () => {
    expect(effectiveKind({ hasKyro: false }, 'scope')).toBe('direct');
    expect(effectiveKind({ hasKyro: false }, 'work')).toBe('direct');
    expect(effectiveKind({ hasKyro: true }, 'scope')).toBe('scope');
    expect(effectiveKind({ hasKyro: true }, 'direct')).toBe('direct');
  });

  it('parses the select value, defaulting to work', () => {
    expect(parseKind('scope')).toBe('scope');
    expect(parseKind('direct')).toBe('direct');
    expect(parseKind('anything')).toBe('work');
  });
});
