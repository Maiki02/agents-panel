import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newPrLink } from '@agents-panel/shared';
import { GitlabForge, mapMrState, parseMrUrl } from '../src/forge/gitlab-api.js';
import { ForgeRegistry, githubForge } from '../src/forge/provider.js';
import { MR_BODY_MAX } from '../src/pilot/pr-body.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { makeGitRepo } from './helpers.js';
import { fakeGitlab } from './fake-gitlab.js';

const HOST = 'gitlab.example.com';
const TOKEN = 'glpat-supersecret123';
const PATH = 'group/sub/repo';

function forge(fetchImpl = fakeGitlab(HOST, TOKEN)) {
  const provider = new GitlabForge(
    { host: HOST, projectPath: PATH, token: () => TOKEN },
    fetchImpl.fetchImpl,
  );
  return { provider, ...fetchImpl };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

function bodyFile(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'panel-mr-')), 'body.md');
  writeFileSync(file, text);
  return file;
}

describe('GitlabForge', () => {
  it('opens a MR, finds it by branch and lists it in every state', async () => {
    const { provider, calls } = forge();
    expect(await provider.openPr('/x', 'feature/x', 'main')).toBeNull();
    const url = await provider.createPr('/x', {
      base: 'main',
      head: 'feature/x',
      title: 'feat: uno',
      bodyFile: bodyFile('Cuerpo'),
    });
    expect(url).toBe(`https://${HOST}/${PATH}/-/merge_requests/1`);
    expect(await provider.openPr('/x', 'feature/x', 'main')).toBe(url);
    expect(await provider.openPr('/x', 'feature/x', 'dev')).toBeNull();
    expect(await provider.openPrsOf('/x', 'feature/x')).toEqual([url]);
    expect(await provider.allPrsOf('/x', 'feature/x')).toEqual([url]);
    // The project id is the URL-encoded path.
    expect(calls[0]?.url).toContain('/projects/group%2Fsub%2Frepo/merge_requests?');
    expect(calls[0]?.url).toContain('source_branch=feature%2Fx');
    expect(calls[0]?.url).toContain('state=opened');
    expect(calls[1]?.body).toEqual({
      source_branch: 'feature/x',
      target_branch: 'main',
      title: 'feat: uno',
      description: 'Cuerpo',
    });
  });

  it('reads the state of a MR and maps opened/locked/merged/closed', async () => {
    const { provider, mrs } = forge();
    const url = await provider.createPr('/x', {
      base: 'main',
      head: 'b',
      title: 't',
      bodyFile: bodyFile(''),
    });
    expect(await provider.prStateOf('/x', url)).toBe('OPEN');
    const mr = mrs[0];
    if (!mr) throw new Error('no mr');
    mr.state = 'locked';
    expect(await provider.prStateOf('/x', url)).toBe('OPEN');
    mr.state = 'merged';
    expect(await provider.prStateOf('/x', url)).toBe('MERGED');
    mr.state = 'closed';
    expect(await provider.prStateOf('/x', url)).toBe('CLOSED');
    expect(mapMrState('whatever')).toBeNull();
  });

  it('rejects URLs of another host or that are not a MR, without calling the API', async () => {
    const { provider, calls } = forge();
    const bad = [
      `https://other.example.com/${PATH}/-/merge_requests/1`,
      `http://${HOST}/${PATH}/-/merge_requests/1`,
      `https://${HOST}/${PATH}/-/issues/1`,
      `https://${HOST}/${PATH}/merge_requests/1`,
      `https://${HOST}/${PATH}/-/merge_requests/1/diffs`,
      `https://${HOST}/${PATH}/-/merge_requests/abc`,
      `https://${HOST}/${PATH}/-/merge_requests/1?x=1`,
      `https://user:pw@${HOST}/${PATH}/-/merge_requests/1`,
      `https://${HOST}/../-/merge_requests/1`,
      `https://evil.com/?https://${HOST}/${PATH}/-/merge_requests/1`,
      '--flag',
      '',
    ];
    for (const url of bad) {
      await expect(provider.prStateOf('/x', url)).rejects.toThrow(/No es la URL de una MR/);
    }
    expect(calls).toEqual([]);
    expect(parseMrUrl(`https://${HOST}/${PATH}/-/merge_requests/9`, HOST)).toEqual({
      projectPath: PATH,
      iid: 9,
    });
  });

  it('sends the token only in the PRIVATE-TOKEN header, with timeout and no redirects', async () => {
    const { provider, calls } = forge();
    await provider.openPr('/x', 'b', 'main');
    await provider.createPr('/x', { base: 'main', head: 'b', title: 't', bodyFile: bodyFile('') });
    for (const call of calls) {
      expect(call.token).toBe(TOKEN);
      expect(call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.body ?? '')).not.toContain(TOKEN);
      expect(call.redirect).toBe('error');
      expect(call.hasSignal).toBe(true);
    }
  });

  it('keeps the token out of the errors (bad token echoed by the API, network failure)', async () => {
    const wrong = new GitlabForge(
      { host: HOST, projectPath: PATH, token: () => 'glpat-wrongwrong' },
      fakeGitlab(HOST, TOKEN).fetchImpl,
    );
    const error = await rejection(wrong.openPr('/x', 'b', 'main'));
    expect(error.message).toMatch(/401/);
    expect(error.message).not.toContain('glpat-wrongwrong');

    const leaky = new GitlabForge({ host: HOST, projectPath: PATH, token: () => TOKEN }, () =>
      Promise.reject(new Error(`connect failed with ${TOKEN}`)),
    );
    const network = await rejection(leaky.openPr('/x', 'b', 'main'));
    expect(network.message).toMatch(/falló/);
    expect(network.message).not.toContain(TOKEN);
  });

  it('cuts a body over the limit before sending it', async () => {
    const { provider, mrs } = forge();
    await provider.createPr('/x', {
      base: 'main',
      head: 'b',
      title: 't'.repeat(400),
      bodyFile: bodyFile('x\n'.repeat(MR_BODY_MAX)),
    });
    expect((mrs[0]?.description.length ?? 0) <= MR_BODY_MAX).toBe(true);
    expect(mrs[0]?.title.length).toBe(255);
  });
});

describe('ForgeRegistry', () => {
  it('uses gh for GitHub projects and the REST API with the account token for GitLab ones', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const common = {
      displayName: null,
      baseBranch: 'main',
      setupCommand: null,
      status: 'ready' as const,
      statusDetail: null,
    };
    const hub = projects.insertGithub({
      ...common,
      name: 'hub',
      repoUrl: 'https://github.com/o/r',
      repoPath: makeGitRepo(),
    });
    const lab = projects.insertGithub({
      ...common,
      name: 'lab',
      repoUrl: `https://${HOST}/${PATH}`,
      gitProvider: 'gitlab',
      repoPath: makeGitRepo(),
    });
    const gitlab = fakeGitlab(HOST, TOKEN);
    const registry = new ForgeRegistry({
      projects,
      credentials: {
        forProject: (id) => (id === lab.id ? { host: HOST, username: 'u', token: TOKEN } : null),
      },
      fetch: gitlab.fetchImpl,
    });
    expect(registry.forProject(hub.id)).toBe(githubForge);
    const url = await registry
      .forProject(lab.id)
      .createPr('/x', { base: 'main', head: 'b', title: 't', bodyFile: bodyFile('') });
    expect(url).toBe(`https://${HOST}/${PATH}/-/merge_requests/1`);
    expect(gitlab.mrs[0]?.project).toBe(PATH);
  });

  it('fails clearly, without a token in the message, when the GitLab project has no account', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const lab = projects.insertGithub({
      name: 'lab',
      displayName: null,
      repoUrl: `https://${HOST}/${PATH}`,
      gitProvider: 'gitlab',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
      setupCommand: null,
      status: 'ready',
      statusDetail: null,
    });
    const registry = new ForgeRegistry({
      projects,
      credentials: { forProject: () => null },
      fetch: fakeGitlab(HOST, TOKEN).fetchImpl,
    });
    await expect(registry.forProject(lab.id).openPr('/x', 'b', 'main')).rejects.toThrow(
      /no tiene una cuenta de GitLab/,
    );
  });
});

describe('newPrLink', () => {
  it('points GitHub to pull/new and GitLab to merge_requests/new', () => {
    expect(newPrLink('github', 'https://github.com/o/r', 'feature/x')).toBe(
      'https://github.com/o/r/pull/new/feature/x',
    );
    expect(newPrLink('gitlab', `https://${HOST}/${PATH}`, 'feature/x')).toBe(
      `https://${HOST}/${PATH}/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx`,
    );
  });
});
