import { describe, expect, it } from 'vitest';
import { normalizeOrigin, parseGithubRepo } from '../src/projects/github.js';
import { ProjectError } from '../src/projects/repo.js';

const expected = {
  owner: 'Maiki02',
  repo: 'agents-panel',
  slug: 'Maiki02/agents-panel',
  httpsUrl: 'https://github.com/Maiki02/agents-panel',
};

describe('parseGithubRepo', () => {
  it.each([
    'Maiki02/agents-panel',
    '  Maiki02/agents-panel  ',
    'Maiki02/agents-panel.git',
    'Maiki02/agents-panel/',
    'https://github.com/Maiki02/agents-panel',
    'https://github.com/Maiki02/agents-panel.git',
    'https://github.com/Maiki02/agents-panel/',
    'https://github.com/Maiki02/agents-panel.git/',
  ])('accepts %j and gives the same result', (input) => {
    expect(parseGithubRepo(input)).toEqual(expected);
  });

  it('accepts dots, underscores and a leading underscore in the repo', () => {
    expect(parseGithubRepo('a-b/_my.repo_1').slug).toBe('a-b/_my.repo_1');
  });

  it('accepts the 39-char owner and 100-char repo limits', () => {
    expect(() => parseGithubRepo(`${'a'.repeat(39)}/${'r'.repeat(100)}`)).not.toThrow();
  });

  it.each([
    '',
    '   ',
    'a',
    'a/b/c',
    'https://github.com/a/b/c',
    'https://github.com/a',
    '-flag/repo',
    '--upload-pack=x/repo',
    'owner/-flag',
    'owner/..',
    'owner/.',
    'owner/.hidden',
    '../b',
    'a/..',
    '/a/b',
    'a//b',
    'owner/.git',
    'a b/c',
    'a/b c',
    'a/b\nc',
    '-a/b',
    `${'a'.repeat(40)}/repo`,
    `owner/${'r'.repeat(101)}`,
    '-/repo',
    'file:///etc/passwd',
    'file:///home/ubuntu/proyectos/ventas',
    '/home/ubuntu/proyectos/ventas',
    'git@github.com:a/b.git',
    'ssh://git@github.com/a/b.git',
    'http://github.com/a/b',
    'https://evil.com/a/b',
    'https://github.com.evil.com/a/b',
    'https://www.github.com/a/b',
    'https://user:pass@github.com/a/b',
    'https://token@github.com/a/b',
    'https://github.com:8443/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#frag',
    'github.com/a/b',
    'a/b:c',
    'a@b/c',
  ])('rejects %j with ProjectError', (input) => {
    expect(() => parseGithubRepo(input)).toThrow(ProjectError);
  });
});

describe('normalizeOrigin', () => {
  it.each([
    'https://github.com/Maiki02/agents-panel',
    'https://github.com/Maiki02/agents-panel.git',
    'https://github.com/maiki02/agents-panel/',
    'https://x-access-token:abc@github.com/Maiki02/agents-panel.git',
    'git@github.com:Maiki02/agents-panel.git',
    'git@github.com:Maiki02/agents-panel',
    'ssh://git@github.com/Maiki02/agents-panel.git',
  ])('normalizes %j to the same form', (input) => {
    expect(normalizeOrigin(input)).toBe('https://github.com/maiki02/agents-panel');
  });

  it('matches what parseGithubRepo produces', () => {
    expect(normalizeOrigin(parseGithubRepo('Maiki02/agents-panel').httpsUrl)).toBe(
      normalizeOrigin('git@github.com:Maiki02/agents-panel.git'),
    );
  });

  it.each([
    '',
    'https://gitlab.com/a/b',
    'git@gitlab.com:a/b.git',
    'https://github.com.evil.com/a/b',
    'https://github.com/a/b/c',
    '/home/ubuntu/proyectos/ventas',
    'file:///tmp/x',
    'not a url',
  ])('returns null for %j', (input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });
});
