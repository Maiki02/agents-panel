import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentManager } from '../src/agent/manager.js';
import { buildQueryOptions } from '../src/agent/sdk-runner.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase, type Db } from '../src/db/index.js';
import {
  GIT_ASKPASS_SCRIPT,
  GitCredentialError,
  GitCredentialResolver,
  NO_AUTH,
  agentCredentialEnv,
  authForPath,
  credentialEnv,
  processAuth,
  setGitCredentialLookup,
  type GitCredential,
} from '../src/git-accounts/credentials.js';
import { GitAccountRepository } from '../src/git-accounts/repo.js';
import { createGit, type Exec } from '../src/pilot/git-ops.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ProjectService, type CloneSource } from '../src/projects/service.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';

const TOKEN = 'glpat-' + 'S3NT1NEL_TOKEN_9f2c0000';
const CREDENTIAL: GitCredential = { host: 'gitlab.example.com', username: 'ana', token: TOKEN };

afterEach(() => {
  setGitCredentialLookup(null);
});

function askpass(prompt: string, env: Record<string, string>) {
  credentialEnv(CREDENTIAL); // restores the exec bit of the script if a checkout lost it
  return spawnSync(GIT_ASKPASS_SCRIPT, [prompt], { env, encoding: 'utf8' });
}

describe('git-askpass.sh', () => {
  it('is a bash script with LF endings and strict mode', () => {
    const text = readFileSync(GIT_ASKPASS_SCRIPT, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(text).not.toContain('\r');
    credentialEnv(CREDENTIAL); // gives the exec bit back if the checkout lost it
    expect(statSync(GIT_ASKPASS_SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('answers the user and the token of the environment to git prompts', () => {
    const env = { PANEL_GIT_USERNAME: 'ana', PANEL_GIT_TOKEN: TOKEN };
    const user = askpass("Username for 'https://gitlab.example.com': ", env);
    expect(user.status).toBe(0);
    expect(user.stdout).toBe('ana\n');
    const password = askpass("Password for 'https://ana@gitlab.example.com': ", env);
    expect(password.status).toBe(0);
    expect(password.stdout).toBe(`${TOKEN}\n`);
  });

  it('answers nothing when the variables are missing or the prompt is unknown', () => {
    for (const prompt of ["Username for 'https://x.com': ", "Password for 'https://u@x.com': "]) {
      const out = askpass(prompt, {});
      expect(out.status).toBe(0);
      expect(out.stdout).toBe('');
    }
    const other = askpass('Something else: ', {
      PANEL_GIT_USERNAME: 'ana',
      PANEL_GIT_TOKEN: TOKEN,
    });
    expect(other.stdout).toBe('');
  });
});

describe('process auth', () => {
  it('leaves a project without account with today environment', () => {
    expect(processAuth(null)).toBe(NO_AUTH);
    expect(NO_AUTH).toEqual({ configArgs: [], env: undefined });
  });

  it('with an account adds askpass, no prompts and the helper override for its host only', () => {
    const auth = processAuth(CREDENTIAL, { PATH: '/bin' });
    expect(auth.configArgs).toEqual(['-c', 'credential.https://gitlab.example.com.helper=']);
    expect(auth.env).toMatchObject({
      PATH: '/bin',
      GIT_ASKPASS: GIT_ASKPASS_SCRIPT,
      GIT_TERMINAL_PROMPT: '0',
      PANEL_GIT_USERNAME: 'ana',
      PANEL_GIT_TOKEN: TOKEN,
    });
    expect(auth.env).not.toHaveProperty('GH_TOKEN');
    expect(auth.configArgs.join(' ')).not.toContain(TOKEN);
  });

  it('sets GH_TOKEN only for github.com', () => {
    expect(credentialEnv({ ...CREDENTIAL, host: 'github.com' })).toMatchObject({ GH_TOKEN: TOKEN });
    expect(credentialEnv(CREDENTIAL)).not.toHaveProperty('GH_TOKEN');
  });
});

/** Panel database with one project; the account is attached with `attach`. */
async function withProject() {
  const db: Db = openDatabase(':memory:');
  const accounts = new GitAccountRepository(db, Buffer.alloc(32, 7));
  const repoPath = makeGitRepo();
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath,
    baseBranch: 'main',
  });
  const worktreesDir = mkdtempSync(join(tmpdir(), 'panel-wt-'));
  const resolver = new GitCredentialResolver(db, accounts, worktreesDir);
  const attach = () => {
    const account = accounts.create({
      provider: 'gitlab',
      name: 'gl',
      host: 'gitlab.example.com',
      username: 'ana',
      token: TOKEN,
    });
    db.prepare('UPDATE projects SET git_account_id = ? WHERE id = ?').run(account.id, project.id);
    return account;
  };
  return { db, accounts, project, repoPath, worktreesDir, resolver, attach };
}

describe('GitCredentialResolver', () => {
  it('finds nothing for a project without account', async () => {
    const { resolver, repoPath, project } = await withProject();
    expect(resolver.forProject(project.id)).toBeNull();
    expect(resolver.forPath(repoPath)).toBeNull();
  });

  it('finds the account from the project, its clone and its worktrees', async () => {
    const { resolver, repoPath, worktreesDir, project, attach } = await withProject();
    attach();
    expect(resolver.forProject(project.id)).toEqual(CREDENTIAL);
    expect(resolver.forPath(repoPath)).toEqual(CREDENTIAL);
    expect(resolver.forPath(join(repoPath, 'child'))).toEqual(CREDENTIAL);
    expect(resolver.forPath(join(worktreesDir, 'demo', 'work-1'))).toEqual(CREDENTIAL);
    expect(resolver.forPath(join(worktreesDir, 'other', 'work-1'))).toBeNull();
    expect(resolver.forPath(tmpdir())).toBeNull();
  });

  it('fails clearly when the token can no longer be read', async () => {
    const { db, resolver, project, attach } = await withProject();
    const account = attach();
    db.prepare("UPDATE git_accounts SET tag = x'00' WHERE id = ?").run(account.id);
    expect(() => resolver.forProject(project.id)).toThrow(GitCredentialError);
  });
});

describe('git helpers with an account', () => {
  function recorder() {
    const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const exec: Exec = (_file, args, options) => {
      calls.push({ args, env: options.env });
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    return { calls, git: createGit(exec) };
  }

  it('push, pull and remote delete carry the credential only in the environment', async () => {
    const { resolver, repoPath, attach } = await withProject();
    attach();
    setGitCredentialLookup(resolver);
    const { calls, git } = recorder();
    await git.push(repoPath, 'feature/x');
    await git.pullBranch(repoPath, 'main');
    await git.deleteRemoteBranch(repoPath, 'feature/x', 'main');
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args.slice(0, 3)).toEqual([
        '-c',
        'credential.https://gitlab.example.com.helper=',
        '-C',
      ]);
      expect(call.env).toMatchObject({
        GIT_ASKPASS: GIT_ASKPASS_SCRIPT,
        GIT_TERMINAL_PROMPT: '0',
        PANEL_GIT_TOKEN: TOKEN,
      });
      expect(call.args.join(' ')).not.toContain(TOKEN);
    }
  });

  it('a project without account runs git exactly as before', async () => {
    const { resolver, repoPath } = await withProject();
    setGitCredentialLookup(resolver);
    const { calls, git } = recorder();
    await git.push(repoPath, 'feature/x');
    expect(calls[0]?.args).toEqual(['-C', repoPath, 'push', '-u', 'origin', 'feature/x']);
    expect(calls[0]?.env).toBeUndefined();
    expect(authForPath(repoPath)).toBe(NO_AUTH);
  });
});

describe('clone of a project with an account', () => {
  it('passes the url without credentials and the credential for the cloner', async () => {
    const { db, accounts, attach } = await withProject();
    const resolver = new GitCredentialResolver(db, accounts, tmpdir());
    const repo = new ProjectRepository(db);
    const projectsDir = mkdtempSync(join(tmpdir(), 'panel-projects-'));
    const sources: (CloneSource | undefined)[] = [];
    const service = new ProjectService({
      repo,
      config: { projectsDir, minFreeDiskGb: 0 },
      credentials: resolver,
      freeSpace: () => Promise.resolve(1e12),
      cloner: (_slug, _dest, source) => {
        sources.push(source);
        return Promise.reject(new Error('stop here'));
      },
    });
    const failed = repo.insertGithub({
      name: 'gl-proj',
      displayName: null,
      repoUrl: 'https://github.com/acme/widgets',
      repoPath: join(projectsDir, 'gl-proj'),
      baseBranch: 'main',
      setupCommand: null,
      status: 'error',
      statusDetail: 'x',
    });
    // Without account: the cloner gets no source (today's `gh repo clone`).
    await service.retry(failed.id);
    await service.whenIdle();
    expect(sources).toEqual([undefined]);

    const account = attach();
    db.prepare('UPDATE projects SET git_account_id = ?, status = ? WHERE id = ?').run(
      account.id,
      'error',
      failed.id,
    );
    await service.retry(failed.id);
    await service.whenIdle();
    expect(sources[1]?.url).toBe('https://github.com/acme/widgets.git');
    expect(sources[1]?.credential).toEqual(CREDENTIAL);
    expect(sources[1]?.url).not.toContain(TOKEN);
  });
});

describe('agent turn', () => {
  it('gives the environment of the account to the turn of its project and nothing otherwise', async () => {
    const { db, accounts, project, attach } = await withProject();
    const resolver = new GitCredentialResolver(db, accounts, tmpdir());
    const chats = new ChatRepository(db);
    const runner = new FakeRunner();
    const manager = new AgentManager(
      chats,
      runner,
      new ChatEventBus(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (projectId) => {
        const credential = resolver.forProject(projectId);
        return credential ? agentCredentialEnv(credential) : undefined;
      },
    );
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug: 'a',
      title: 'a',
      worktreePath: '/tmp/wt/a',
      branch: 'feature/a',
      status: 'idle',
    });
    manager.start(chat.id, 'hola');
    await manager.waitForIdle(chat.id);
    expect(runner.calls[0]?.gitEnv).toBeUndefined();

    attach();
    manager.start(chat.id, 'otra vez');
    await manager.waitForIdle(chat.id);
    expect(runner.calls[1]?.gitEnv).toMatchObject({
      GIT_ASKPASS: GIT_ASKPASS_SCRIPT,
      GIT_TERMINAL_PROMPT: '0',
      PANEL_GIT_TOKEN: TOKEN,
      GIT_CONFIG_KEY_0: 'credential.https://gitlab.example.com.helper',
    });
  });

  it('puts the credential in the SDK env only when the turn carries it', () => {
    const base = {
      cwd: '/tmp/wt/a',
      prompt: 'x',
      model: 'm',
      role: 'executor' as const,
      signal: new AbortController().signal,
      canUseTool: () => Promise.resolve({ behavior: 'allow' as const }),
    };
    const without = buildQueryOptions(base, new AbortController());
    expect(without.env?.['PANEL_GIT_TOKEN']).toBeUndefined();
    const withEnv = buildQueryOptions(
      { ...base, gitEnv: agentCredentialEnv(CREDENTIAL) },
      new AbortController(),
    );
    expect(withEnv.env?.['PANEL_GIT_TOKEN']).toBe(TOKEN);
    expect(withEnv.env?.['GIT_ASKPASS']).toBe(GIT_ASKPASS_SCRIPT);
  });
});
