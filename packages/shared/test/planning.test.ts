import { describe, expect, it } from 'vitest';
import { planningLabel, planningTarget } from '../src/index.js';

const planning = (over: Partial<Parameters<typeof planningTarget>[1] & object> = {}) => ({
  state: 'planificando' as const,
  sprintCurrent: null,
  sprintClosed: null,
  ...over,
});

describe('planningTarget', () => {
  it('is null when the chat has no state or is not planning', () => {
    expect(planningTarget('scope', null)).toBeNull();
    expect(planningTarget('scope', undefined)).toBeNull();
    expect(planningTarget('scope', planning({ state: 'escribiendo_codigo' }))).toBeNull();
  });

  it('is general for a work and for a request that is not a scope', () => {
    expect(planningTarget('work', planning())).toEqual({ target: 'general', sprint: null });
    expect(planningTarget('direct', planning({ sprintClosed: 2 }))).toEqual({
      target: 'general',
      sprint: null,
    });
  });

  it('is the scope while Kyro has not reported any sprint', () => {
    expect(planningTarget('scope', planning())).toEqual({ target: 'scope', sprint: null });
  });

  it('is the next sprint after the closed ones, or the active one', () => {
    expect(planningTarget('scope', planning({ sprintClosed: 0 }))).toEqual({
      target: 'sprint',
      sprint: 1,
    });
    expect(planningTarget('scope', planning({ sprintClosed: 2 }))).toEqual({
      target: 'sprint',
      sprint: 3,
    });
    expect(planningTarget('scope', planning({ sprintCurrent: 4, sprintClosed: 3 }))).toEqual({
      target: 'sprint',
      sprint: 4,
    });
  });
});

describe('planningLabel', () => {
  it('names what is being planned', () => {
    expect(planningLabel(null)).toBe('Planificando');
    expect(planningLabel({ target: 'general', sprint: null })).toBe('Planificando');
    expect(planningLabel({ target: 'scope', sprint: null })).toBe('Planificando scope');
    expect(planningLabel({ target: 'sprint', sprint: 3 })).toBe('Planificando sprint 3');
  });

  it('falls back to the plain label when a sprint has no number', () => {
    expect(planningLabel({ target: 'sprint', sprint: null })).toBe('Planificando');
  });
});
