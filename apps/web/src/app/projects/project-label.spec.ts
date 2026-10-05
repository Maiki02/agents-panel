import { describe, expect, it } from 'vitest';
import { kyroPendingNotice, projectLabel, repoDisplay } from './project-label';

describe('projectLabel', () => {
  it('prefers the display name', () => {
    expect(projectLabel({ name: 'novagent', displayName: 'NovaGent' })).toBe('NovaGent');
  });

  it('falls back to the internal name when there is none or it is blank', () => {
    expect(projectLabel({ name: 'agents-panel', displayName: null })).toBe('agents-panel');
    expect(projectLabel({ name: 'agents-panel', displayName: '   ' })).toBe('agents-panel');
  });
});

describe('repoDisplay', () => {
  it('shows the full GitHub URL as a link, with the base branch', () => {
    expect(
      repoDisplay({ repoUrl: 'https://github.com/o/r', repoPath: '/x/r', baseBranch: 'dev' }),
    ).toEqual({ url: 'https://github.com/o/r', text: 'https://github.com/o/r', branch: 'dev' });
  });

  it('falls back to the local path without a link, and hides an empty branch', () => {
    expect(repoDisplay({ repoUrl: null, repoPath: '/x/r', baseBranch: '' })).toEqual({
      url: null,
      text: '/x/r',
      branch: null,
    });
  });
});

describe('kyroPendingNotice', () => {
  it("warns only while Kyro's files are modified in the clone", () => {
    expect(kyroPendingNotice({ kyroPendingCommit: true })).toContain('Kyro actualizado en el clon');
    expect(kyroPendingNotice({ kyroPendingCommit: true })).toContain(
      'no a mano sobre el clon base',
    );
    expect(kyroPendingNotice({ kyroPendingCommit: false })).toBeNull();
    expect(kyroPendingNotice({})).toBeNull();
  });
});
