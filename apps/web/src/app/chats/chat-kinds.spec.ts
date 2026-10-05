import { describe, expect, it } from 'vitest';
import {
  availableKinds,
  defaultKind,
  effectiveKind,
  kindDescription,
  newChatInput,
  parseKind,
} from './chat-kinds';

describe('chat kinds by project', () => {
  it('offers work, scope, idea and direct when the project has Kyro', () => {
    expect(availableKinds({ hasKyro: true }).map((o) => o.kind)).toEqual([
      'work',
      'scope',
      'idea',
      'direct',
    ]);
    expect(defaultKind({ hasKyro: true })).toBe('work');
  });

  it('does not offer an idea without Kyro', () => {
    expect(availableKinds({ hasKyro: false }).map((o) => o.kind)).not.toContain('idea');
    expect(effectiveKind({ hasKyro: false }, 'idea')).toBe('direct');
    expect(effectiveKind({ hasKyro: true }, 'idea')).toBe('idea');
  });

  it('describes every kind it offers, the idea included', () => {
    for (const option of availableKinds({ hasKyro: true })) {
      expect(option.description.length, option.kind).toBeGreaterThan(10);
      expect(kindDescription(option.kind)).toBe(option.description);
    }
    expect(kindDescription('idea')).toMatch(/aprobás/);
  });

  it('creates an idea without an autopilot switch', () => {
    const input = newChatInput({ id: 3, hasKyro: true }, 'idea', 'mi-idea', '  Una idea \n');
    expect(input).toEqual({ projectId: 3, kind: 'idea', slug: 'mi-idea', prompt: 'Una idea' });
    expect('autopilot' in input).toBe(false);
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
    expect(parseKind('idea')).toBe('idea');
    expect(parseKind('anything')).toBe('work');
  });
});
