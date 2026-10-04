import { describe, expect, it } from 'vitest';
import { parseRepoInput } from './repo-input';

describe('parseRepoInput', () => {
  it.each([
    ['Maiki02/novagent', 'Maiki02/novagent'],
    ['  owner/repo  ', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo/', 'owner/repo'],
    ['owner/my.repo_1-x', 'owner/my.repo_1-x'],
  ])('accepts %s', (input, slug) => {
    expect(parseRepoInput(input)).toEqual({ ok: true, slug });
  });

  it.each([
    '',
    'file:///tmp/repo',
    '/tmp/repo',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com:8080/owner/repo',
    'https://user:pw@github.com/owner/repo',
    'https://github.com/owner/repo?x=1',
    'http://github.com/owner/repo',
    'a/b/c',
    'solo',
    '-owner/repo',
    'owner/.repo',
    'owner/re po',
    'owner//repo',
  ])('rejects %j', (input) => {
    expect(parseRepoInput(input).ok).toBe(false);
  });
});
