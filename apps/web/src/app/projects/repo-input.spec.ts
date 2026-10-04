import { describe, expect, it } from 'vitest';
import { parseRepoInput } from './repo-input';

describe('parseRepoInput', () => {
  it.each([
    ['https://github.com/Maiki02/novagent', 'Maiki02/novagent', null],
    ['  https://github.com/owner/repo  ', 'owner/repo', null],
    ['https://github.com/owner/repo.git', 'owner/repo', null],
    ['https://github.com/owner/repo/', 'owner/repo', null],
    ['https://github.com/owner/my.repo_1-x', 'owner/my.repo_1-x', null],
    ['https://github.com/owner/repo/tree/dev', 'owner/repo', 'dev'],
    ['https://github.com/owner/repo.git/tree/dev/', 'owner/repo', 'dev'],
    ['https://github.com/owner/repo/tree/feature/login-fix', 'owner/repo', 'feature/login-fix'],
    ['https://github.com/owner/repo/tree/release%2F1.0', 'owner/repo', 'release/1.0'],
  ])('accepts %s', (input, slug, branch) => {
    expect(parseRepoInput(input)).toMatchObject({ ok: true, slug, branch });
  });

  it('splits owner and repo', () => {
    expect(parseRepoInput('https://github.com/o/r/tree/dev')).toEqual({
      ok: true,
      owner: 'o',
      repo: 'r',
      slug: 'o/r',
      branch: 'dev',
    });
  });

  it.each([
    '',
    'owner/repo',
    'file:///tmp/repo',
    '/tmp/repo',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo',
    'http://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://github.com:8080/owner/repo',
    'https://user:pw@github.com/owner/repo',
    'https://github.com/owner/repo?x=1',
    'https://github.com/owner/repo#readme',
    'https://github.com/owner',
    'https://github.com/-owner/repo',
    'https://github.com/owner/.repo',
    'https://github.com/owner/repo/blob/main/x.ts',
    'https://github.com/owner/repo/tree',
    'https://github.com/owner/repo/tree/-flag',
    'https://github.com/owner/repo/tree/a..b',
    'https://github.com/owner/repo/tree/a%20b',
    'https://github.com/owner/repo/tree/a.lock',
    'https://github.com/owner/re po',
  ])('rejects %j', (input) => {
    expect(parseRepoInput(input).ok).toBe(false);
  });
});
