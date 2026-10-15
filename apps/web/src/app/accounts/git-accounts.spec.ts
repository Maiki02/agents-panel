import type { GitAccount } from '@agents-panel/shared';
import { describe, expect, it } from 'vitest';
import { prCardTexts } from '../chats/approval-logic';
import { providerTexts } from '../projects/project-label';
import { kyroInitView, pullSummary } from '../projects/repo-actions';
import { pullRowView } from '../projects/repos-logic';
import {
  accountProblem,
  accountsFor,
  canLinkAccount,
  defaultAccountId,
  defaultHost,
  gitAccountLabel,
  gitlabHosts,
  newAccountBody,
  projectHost,
  projectsUsing,
  unlinkWarning,
} from './git-accounts-logic';

function account(id: number, provider: 'github' | 'gitlab', host: string): GitAccount {
  return {
    id,
    provider,
    name: `cuenta ${String(id)}`,
    host,
    username: `user${String(id)}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

const accounts = [
  account(1, 'github', 'github.com'),
  account(2, 'gitlab', 'gitlab.com'),
  account(3, 'gitlab', 'git.acme.io'),
  account(4, 'gitlab', 'git.acme.io'),
];

describe('accountsFor', () => {
  it('filters by provider and host', () => {
    expect(accountsFor(accounts, 'gitlab', 'git.acme.io').map((a) => a.id)).toEqual([3, 4]);
    expect(accountsFor(accounts, 'gitlab', 'GitLab.com').map((a) => a.id)).toEqual([2]);
    expect(accountsFor(accounts, 'github', 'github.com').map((a) => a.id)).toEqual([1]);
    expect(accountsFor(accounts, 'github', 'gitlab.com')).toEqual([]);
  });
});

describe('gitlabHosts', () => {
  it('lists each GitLab host once', () => {
    expect(gitlabHosts(accounts)).toEqual(['gitlab.com', 'git.acme.io']);
  });
});

describe('accountProblem', () => {
  const gitlab = accountsFor(accounts, 'gitlab', 'git.acme.io');
  it('GitHub never needs an account', () => {
    expect(accountProblem('github', [], null, 'github.com')).toBeNull();
  });
  it('GitLab asks to link one when the host has none', () => {
    expect(accountProblem('gitlab', [], null, 'git.other.io')).toContain('git.other.io');
  });
  it('GitLab asks to choose, and accepts only an account of the host', () => {
    expect(accountProblem('gitlab', gitlab, null, 'git.acme.io')).toContain('Elegí');
    expect(accountProblem('gitlab', gitlab, 2, 'git.acme.io')).toContain('Elegí');
    expect(accountProblem('gitlab', gitlab, 3, 'git.acme.io')).toBeNull();
  });
});

describe('defaultAccountId', () => {
  it('picks the only account, never guesses between several', () => {
    expect(defaultAccountId([account(9, 'gitlab', 'gitlab.com')])).toBe(9);
    expect(defaultAccountId(accounts)).toBeNull();
    expect(defaultAccountId([])).toBeNull();
  });
});

describe('link form', () => {
  const base = {
    busy: false,
    provider: 'gitlab' as const,
    name: 'Trabajo',
    host: 'git.acme.io',
    token: 'glpat-x',
  };
  it('needs name, token and (GitLab) host', () => {
    expect(canLinkAccount(base)).toBe(true);
    expect(canLinkAccount({ ...base, name: ' ' })).toBe(false);
    expect(canLinkAccount({ ...base, token: '' })).toBe(false);
    expect(canLinkAccount({ ...base, host: '' })).toBe(false);
    expect(canLinkAccount({ ...base, provider: 'github', host: '' })).toBe(true);
    expect(canLinkAccount({ ...base, busy: true })).toBe(false);
  });
  it('sends the host only for GitLab, trimmed and lowercased', () => {
    expect(newAccountBody({ ...base, host: ' Git.Acme.io ', name: ' Trabajo ' }, '123456')).toEqual(
      {
        provider: 'gitlab',
        name: 'Trabajo',
        host: 'git.acme.io',
        token: 'glpat-x',
        totp: '123456',
      },
    );
    expect(newAccountBody({ ...base, provider: 'github' }, '123456')).not.toHaveProperty('host');
  });
  it('defaults the host by provider', () => {
    expect(defaultHost('gitlab')).toBe('gitlab.com');
    expect(defaultHost('github')).toBe('github.com');
  });
});

describe('list text', () => {
  it('shows the user the provider returned and no token field exists', () => {
    const linked = account(3, 'gitlab', 'git.acme.io');
    expect(gitAccountLabel(linked)).toBe('cuenta 3 (user3@git.acme.io)');
    expect(Object.keys(linked)).not.toContain('token');
  });
});

describe('unlink warning', () => {
  const projects = [
    { name: 'a', displayName: null, gitAccountId: 3 },
    { name: 'b', displayName: 'Be', gitAccountId: 3 },
    { name: 'c', displayName: null, gitAccountId: null },
  ];
  it('names the projects that use the account', () => {
    const using = projectsUsing({ id: 3 }, projects);
    expect(using).toEqual(['a', 'Be']);
    expect(unlinkWarning({ name: 'x' }, using)).toContain('2 proyecto(s): a, Be');
  });
  it('has no extra warning when nothing uses it', () => {
    expect(unlinkWarning({ name: 'x' }, [])).not.toContain('proyecto(s)');
  });
});

describe('projectHost', () => {
  it('reads the host of the repo URL, github.com without one', () => {
    expect(projectHost({ repoUrl: 'https://git.acme.io/a/b' })).toBe('git.acme.io');
    expect(projectHost({ repoUrl: null })).toBe('github.com');
  });
});

describe('texts by provider', () => {
  it('GitHub keeps its words, GitLab says GitLab and MR', () => {
    expect(providerTexts({ gitProvider: 'github' })).toMatchObject({ name: 'GitHub', pr: 'PR' });
    expect(providerTexts(null)).toMatchObject({ name: 'GitHub', thePr: 'la PR' });
    expect(providerTexts({ gitProvider: 'gitlab' })).toMatchObject({
      name: 'GitLab',
      pr: 'MR',
      thePr: 'el MR',
    });
  });

  it('pull summaries name the provider', () => {
    const result = { status: 'up_to_date' as const, commits: 0, ahead: 1 };
    expect(pullSummary(result)).toContain('GitHub');
    expect(pullSummary(result, providerTexts({ gitProvider: 'gitlab' }))).toBe(
      'Ya está al día con GitLab. Hay 1 commit(s) locales que GitLab no tiene.',
    );
    const row = pullRowView(
      { path: '.', error: null, result },
      providerTexts({ gitProvider: 'gitlab' }),
    );
    expect(row.detail).toContain('GitLab no tiene');
  });

  it('the Kyro init steps talk about the MR on GitLab and keep the PR on GitHub', () => {
    const base = {
      hasKyro: false,
      status: 'ready' as const,
      baseBranch: 'dev',
      kyroInit: { branch: 'chore/kyro-init', path: '/x', pushed: false, prUrl: null },
    };
    const gitlab = kyroInitView({ ...base, gitProvider: 'gitlab' }).steps.join(' ');
    expect(gitlab).toContain('GitLab');
    expect(gitlab).toContain('el MR');
    expect(gitlab).not.toContain('GitHub');
    const github = kyroInitView(base).steps.join(' ');
    expect(github).toContain('GitHub');
    expect(github).toContain('la PR');
  });

  it('the approval card says MR on GitLab', () => {
    expect(prCardTexts('gitlab').heading).toContain('MR');
    expect(prCardTexts('github').heading).toBe('La PR está lista para revisar');
    expect(prCardTexts(undefined).label).toBe('Pull request');
  });
});
