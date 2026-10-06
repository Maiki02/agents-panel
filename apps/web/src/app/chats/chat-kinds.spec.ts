import { describe, expect, it } from 'vitest';
import {
  availableKinds,
  defaultKind,
  effectiveKind,
  kindDescription,
  modelLabel,
  modelOptions,
  newChatInput,
  parseKind,
  pilotSwitch,
} from './chat-kinds';
import { MODEL_CATALOG } from '@agents-panel/shared';

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

describe('newChatInput with pilot and models', () => {
  const project = {
    id: 3,
    hasKyro: true,
    models: { provider: 'claude', thinker: 'claude-opus-5-5', executor: 'claude-sonnet-5-5' },
  } as const;
  const same = { thinker: 'claude-opus-5-5', executor: 'claude-sonnet-5-5' };

  it('sends autopilot true for a scope or work and nothing when it is off', () => {
    for (const kind of ['scope', 'work'] as const) {
      expect(newChatInput(project, kind, 's', 'p', { autopilot: true })).toMatchObject({
        autopilot: true,
      });
      expect('autopilot' in newChatInput(project, kind, 's', 'p', { autopilot: false })).toBe(
        false,
      );
    }
  });

  it('never sends autopilot for an idea or a direct request', () => {
    expect('autopilot' in newChatInput(project, 'idea', 's', 'p', { autopilot: true })).toBe(false);
    expect(
      'autopilot' in
        newChatInput({ ...project, hasKyro: false }, 'work', 's', 'p', { autopilot: true }),
    ).toBe(false);
  });

  it('sends models only for the roles that differ from the project', () => {
    expect('models' in newChatInput(project, 'work', 's', 'p', { models: same })).toBe(false);
    expect(
      newChatInput(project, 'work', 's', 'p', {
        models: { ...same, executor: 'claude-haiku-4-5-20251001' },
      }).models,
    ).toEqual({ executor: 'claude-haiku-4-5-20251001' });
    expect(
      newChatInput(project, 'work', 's', 'p', {
        models: { thinker: 'claude-fable-5-1', executor: 'claude-haiku-4-5-20251001' },
      }).models,
    ).toEqual({ thinker: 'claude-fable-5-1', executor: 'claude-haiku-4-5-20251001' });
  });

  it('offers the catalog with the default of each role marked', () => {
    const options = modelOptions(project);
    expect(options.map((o) => o.id)).toEqual([...MODEL_CATALOG.claude]);
    expect(options.find((o) => o.byDefault.thinker)?.id).toBe('claude-opus-5-5');
    expect(options.find((o) => o.byDefault.executor)?.id).toBe('claude-sonnet-5-5');
    expect(modelLabel('x', true)).toBe('x (por defecto)');
    expect(modelLabel('x', false)).toBe('x');
  });

  it('says why an idea and a direct request have no pilot switch', () => {
    expect(pilotSwitch('scope')).toEqual({ available: true, reason: null });
    expect(pilotSwitch('work').available).toBe(true);
    expect(pilotSwitch('idea')).toMatchObject({ available: false });
    expect(pilotSwitch('idea').reason).toContain('aprobás');
    expect(pilotSwitch('direct').reason).toContain('directo');
  });
});
