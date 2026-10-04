import { describe, expect, it } from 'vitest';
import { projectLabel } from './project-label';

describe('projectLabel', () => {
  it('prefers the display name', () => {
    expect(projectLabel({ name: 'novagent', displayName: 'NovaGent' })).toBe('NovaGent');
  });

  it('falls back to the internal name when there is none or it is blank', () => {
    expect(projectLabel({ name: 'agents-panel', displayName: null })).toBe('agents-panel');
    expect(projectLabel({ name: 'agents-panel', displayName: '   ' })).toBe('agents-panel');
  });
});
