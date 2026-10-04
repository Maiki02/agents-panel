import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ProjectConflictError, ProjectError, ProjectRepository } from '../src/projects/repo.js';
import {
  ProjectService,
  deriveProjectName,
  type Cloner,
  type KyroInitializer,
} from '../src/projects/service.js';
import { makeGitRepo } from './helpers.js';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

/** A bare repo standing in for GitHub, and a cloner that behaves like `gh repo clone` on it. */
function fakeRemote() {
  const bare = join(tmp('panel-bare-'), 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), bare]);
  const calls: string[] = [];
  const cloner: Cloner = vi.fn((slug: string, dest: string) => {
    calls.push(slug);
    execFileSync('git', ['clone', '-q', bare, dest], { stdio: 'pipe' });
    git(dest, 'remote', 'set-url', 'origin', `https://github.com/${slug}.git`);
    return Promise.resolve();
  });
  return { cloner, calls };
}

function setup(
  options: {
    cloner?: Cloner;
    free?: number;
    minFreeDiskGb?: number;
    kyroInit?: KyroInitializer;
  } = {},
) {
  const projectsDir = tmp('panel-projects-');
  const repo = new ProjectRepository(openDatabase(':memory:'));
  const remote = fakeRemote();
  const cloner = options.cloner ?? remote.cloner;
  const service = new ProjectService({
    repo,
    config: { projectsDir, minFreeDiskGb: options.minFreeDiskGb ?? 10 },
    cloner,
    freeSpace: () => Promise.resolve(options.free ?? 100 * 1024 ** 3),
    kyroInit: options.kyroInit ?? (() => Promise.resolve()),
  });
  return { service, repo, projectsDir, cloner, calls: remote.calls };
}

describe('deriveProjectName', () => {
  it.each([
    ['agents-panel', 'agents-panel'],
    ['Agents_Panel.v2', 'agents-panel-v2'],
    ['_x_', 'x'],
    ['NovaGent', 'novagent'],
  ])('%s -> %s', (input, expected) => {
    expect(deriveProjectName(input)).toBe(expected);
  });
});

describe('concurrent adds of the same repo (debt-3)', () => {
  it('leaves one project and one clone; the other answers "ya existe"', async () => {
    const { service, repo, calls } = setup();
    const results = await Promise.allSettled([
      service.add({ repo: 'Owner/Same', name: 'one' }),
      service.add({ repo: 'owner/same', name: 'two' }),
    ]);
    await service.whenIdle();
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ProjectConflictError);
    expect((rejected?.reason as Error).message).toContain('ya existe');
    expect(repo.list()).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe('add from GitHub', () => {
  it('goes cloning, then ready with the requested origin and an existing base branch', async () => {
    const { service, repo, projectsDir, calls } = setup();
    const created = await service.add({ repo: 'Owner/Cool_Repo' });
    expect(created).toMatchObject({
      name: 'cool-repo',
      status: 'cloning',
      repoUrl: 'https://github.com/Owner/Cool_Repo',
      repoPath: join(projectsDir, 'cool-repo'),
    });
    await service.whenIdle();
    const ready = repo.findById(created.id);
    expect(ready).toMatchObject({ status: 'ready', statusDetail: null, baseBranch: 'main' });
    expect(calls).toEqual(['Owner/Cool_Repo']);
    expect(git(join(projectsDir, 'cool-repo'), 'config', '--get', 'remote.origin.url')).toBe(
      'https://github.com/Owner/Cool_Repo.git',
    );
  });

  it('keeps the explicit name, display name, base branch and setup command', async () => {
    const { service, repo } = setup();
    const created = await service.add({
      repo: 'https://github.com/o/r.git',
      name: 'mi-proyecto',
      displayName: '  Mi Proyecto ',
      baseBranch: 'main',
      setupCommand: 'npm ci',
    });
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({
      name: 'mi-proyecto',
      displayName: 'Mi Proyecto',
      baseBranch: 'main',
      setupCommand: 'npm ci',
      status: 'ready',
    });
  });

  it('rejects invalid input before running anything', async () => {
    const { service, cloner } = setup();
    for (const repo of ['file:///etc/passwd', 'a/b/c', '-x/y', 'https://evil.com/a/b']) {
      await expect(service.add({ repo })).rejects.toBeInstanceOf(ProjectError);
    }
    await expect(service.add({ repo: 'o/r', name: 'Bad Name' })).rejects.toBeInstanceOf(
      ProjectError,
    );
    expect(cloner).not.toHaveBeenCalled();
  });

  it('answers "already exists" when the same repo or name is registered twice', async () => {
    const { service } = setup();
    await service.add({ repo: 'o/r' });
    await service.whenIdle();
    await expect(service.add({ repo: 'o/r' })).rejects.toBeInstanceOf(ProjectConflictError);
    await expect(service.add({ repo: 'O/R' })).rejects.toBeInstanceOf(ProjectConflictError);
    await expect(service.add({ repo: 'other/r' })).rejects.toThrow(/ya existe|already exists/i);
  });
});

describe('failures and retry', () => {
  it('ends in error, removes the folder it created, and retry reaches ready', async () => {
    const remote = fakeRemote();
    let broken = true;
    const cloner: Cloner = (slug, dest) => {
      if (broken) {
        writeFileSync(join(dest, 'partial'), 'x');
        return Promise.reject(new Error('network down'));
      }
      return remote.cloner(slug, dest);
    };
    const { service, repo, projectsDir } = setup({ cloner });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({
      status: 'error',
      statusDetail: 'network down',
    });
    expect(existsSync(join(projectsDir, 'r'))).toBe(false);

    broken = false;
    await service.retry(created.id);
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({ status: 'ready', statusDetail: null });
  });

  it('uses gh stderr as the detail and trims it to 500 characters', async () => {
    const cloner: Cloner = () =>
      Promise.reject(
        Object.assign(new Error('Command failed'), { stderr: `${'e'.repeat(800)}\n` }),
      );
    const { service, repo } = setup({ cloner });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(repo.findById(created.id)?.statusDetail).toBe('e'.repeat(500));
  });

  it('is error (and deletes the folder) when the clone origin is not the requested repo', async () => {
    const bare = join(tmp('panel-bare-'), 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', makeGitRepo(), bare]);
    const cloner: Cloner = (_slug, dest) => {
      execFileSync('git', ['clone', '-q', bare, dest], { stdio: 'pipe' });
      return Promise.resolve();
    };
    const { service, repo, projectsDir } = setup({ cloner });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({ status: 'error' });
    expect(existsSync(join(projectsDir, 'r'))).toBe(false);
  });

  it('is error when the requested base branch does not exist in the clone', async () => {
    const { service, repo, projectsDir } = setup();
    const created = await service.add({ repo: 'o/r', baseBranch: 'dev' });
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({ status: 'error' });
    expect(repo.findById(created.id)?.statusDetail).toContain('dev');
    expect(existsSync(join(projectsDir, 'r'))).toBe(false);
  });

  it('takes the base branch from a /tree/<branch> URL, and an explicit baseBranch wins', async () => {
    const { service, repo } = setup();
    const fromUrl = await service.add({ repo: 'https://github.com/o/r/tree/main' });
    await service.whenIdle();
    expect(repo.findById(fromUrl.id)).toMatchObject({
      status: 'ready',
      baseBranch: 'main',
      repoUrl: 'https://github.com/o/r',
    });

    const explicit = await service.add({
      repo: 'https://github.com/o/s/tree/nope',
      baseBranch: 'main',
    });
    await service.whenIdle();
    expect(repo.findById(explicit.id)).toMatchObject({ status: 'ready', baseBranch: 'main' });
  });

  it('is error when the branch of the URL does not exist in the clone', async () => {
    const { service, repo } = setup();
    const created = await service.add({ repo: 'https://github.com/o/r/tree/dev' });
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({ status: 'error' });
    expect(repo.findById(created.id)?.statusDetail).toContain('dev');
  });

  it('refuses to retry a project that is not in error', async () => {
    const { service } = setup();
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    await expect(service.retry(created.id)).rejects.toBeInstanceOf(ProjectConflictError);
  });
});

describe('folder ownership', () => {
  it('never deletes a folder that appeared before the clone started', async () => {
    const projectsDir = tmp('panel-projects-');
    const repo = new ProjectRepository(openDatabase(':memory:'));
    const cloner = vi.fn<Cloner>(() => Promise.resolve());
    const service = new ProjectService({
      repo,
      config: { projectsDir, minFreeDiskGb: 1 },
      cloner,
      // The folder shows up between the existence check and the clone (the race).
      freeSpace: () => {
        mkdirSync(join(projectsDir, 'r'));
        writeFileSync(join(projectsDir, 'r', 'mine.txt'), 'valuable');
        return Promise.resolve(100 * 1024 ** 3);
      },
      kyroInit: () => Promise.resolve(),
    });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(repo.findById(created.id)).toMatchObject({ status: 'error' });
    expect(repo.findById(created.id)?.statusDetail).toContain('ya existe');
    expect(cloner).not.toHaveBeenCalled();
    expect(readFileSync(join(projectsDir, 'r', 'mine.txt'), 'utf8')).toBe('valuable');
  });

  it('clones into the empty folder it created and removes it if the clone fails', async () => {
    let seenEmpty = false;
    const cloner: Cloner = (_slug, dest) => {
      seenEmpty = existsSync(dest) && readdirSync(dest).length === 0;
      return Promise.reject(new Error('boom'));
    };
    const { service, projectsDir } = setup({ cloner });
    await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(seenEmpty).toBe(true);
    expect(existsSync(join(projectsDir, 'r'))).toBe(false);
  });
});

describe('existing folders', () => {
  function existingClone(projectsDir: string, name: string, origin: string): string {
    const dir = join(projectsDir, name);
    execFileSync('git', ['clone', '-q', makeGitRepo(), dir], { stdio: 'pipe' });
    git(dir, 'remote', 'set-url', 'origin', origin);
    return dir;
  }

  it.each([
    'https://github.com/o/r.git',
    'https://github.com/o/r',
    'git@github.com:o/r.git',
    'ssh://git@github.com/o/r',
  ])('adopts a folder whose origin is %s without cloning', async (origin) => {
    const { service, projectsDir, cloner } = setup();
    existingClone(projectsDir, 'r', origin);
    const project = await service.add({ repo: 'o/r' });
    expect(project).toMatchObject({ status: 'ready', baseBranch: 'main' });
    expect(cloner).not.toHaveBeenCalled();
  });

  it('answers 409 and leaves the folder untouched when the origin is another repo', async () => {
    const { service, repo, projectsDir, cloner } = setup();
    const dir = existingClone(projectsDir, 'r', 'https://github.com/someone/else.git');
    const before = readdirSync(dir).sort();
    await expect(service.add({ repo: 'o/r' })).rejects.toBeInstanceOf(ProjectConflictError);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# test\n');
    expect(repo.list()).toEqual([]);
    expect(cloner).not.toHaveBeenCalled();
  });

  it('answers 409 for a plain folder that is not a git repo, or a subfolder of another repo', async () => {
    const { service, projectsDir } = setup();
    mkdirSync(join(projectsDir, 'r'));
    writeFileSync(join(projectsDir, 'r', 'file.txt'), 'x');
    await expect(service.add({ repo: 'o/r' })).rejects.toBeInstanceOf(ProjectConflictError);

    const { service: nested, projectsDir: outerDir } = setup();
    git(outerDir, 'init', '-q');
    git(outerDir, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    mkdirSync(join(outerDir, 'r'));
    writeFileSync(join(outerDir, 'r', 'file.txt'), 'x');
    await expect(nested.add({ repo: 'o/r' })).rejects.toBeInstanceOf(ProjectConflictError);
  });
});

describe('disk space and restart', () => {
  it('is error "sin espacio" and never calls the cloner below the threshold', async () => {
    const { service, repo, cloner, projectsDir } = setup({
      free: 5 * 1024 ** 3,
      minFreeDiskGb: 10,
    });
    const created = await service.add({ repo: 'o/r' });
    expect(created).toMatchObject({ status: 'error', statusDetail: 'sin espacio' });
    expect(repo.findById(created.id)?.status).toBe('error');
    expect(cloner).not.toHaveBeenCalled();
    expect(existsSync(join(projectsDir, 'r'))).toBe(false);
  });

  it('recoverInterrupted turns cloning into error "interrumpido" and clears the partial folder', async () => {
    // The service creates the folder right before calling the cloner: once the cloner runs, the
    // partial folder exists (creating it from the test raced with the background job).
    let cloning: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (cloning = resolve));
    const { service, repo, projectsDir } = setup({
      cloner: () => {
        cloning();
        return new Promise<void>(() => undefined);
      },
    });
    const created = await service.add({ repo: 'o/r' });
    await started;
    writeFileSync(join(projectsDir, 'r', 'partial'), '');
    expect(repo.findById(created.id)?.status).toBe('cloning');

    const fresh = new ProjectService({
      repo,
      config: { projectsDir, minFreeDiskGb: 10 },
    });
    expect(await fresh.recoverInterrupted()).toBe(1);
    expect(repo.findById(created.id)).toMatchObject({
      status: 'error',
      statusDetail: 'interrumpido',
    });
    expect(existsSync(join(projectsDir, 'r'))).toBe(false);
    expect(await fresh.recoverInterrupted()).toBe(0);
  });
});

describe('suggestedSetup and update', () => {
  it('suggests the command only when scripts/panel-setup.sh exists', async () => {
    const { service } = setup();
    const withScript = makeGitRepo();
    mkdirSync(join(withScript, 'scripts'));
    writeFileSync(join(withScript, 'scripts', 'panel-setup.sh'), '#!/usr/bin/env bash\n');
    expect(await service.suggestedSetup({ repoPath: withScript })).toBe(
      'bash scripts/panel-setup.sh',
    );
    expect(await service.suggestedSetup({ repoPath: makeGitRepo() })).toBeNull();
  });

  it('update changes display name, base branch (it must exist) and setup command', async () => {
    const { service, repo, projectsDir } = setup();
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    git(join(projectsDir, 'r'), 'branch', 'dev');

    const updated = await service.update(created.id, {
      displayName: 'Producto',
      baseBranch: 'dev',
      setupCommand: 'npm ci',
    });
    expect(updated).toMatchObject({
      displayName: 'Producto',
      baseBranch: 'dev',
      setupCommand: 'npm ci',
    });

    await expect(service.update(created.id, { baseBranch: 'nope' })).rejects.toBeInstanceOf(
      ProjectError,
    );
    expect(repo.findById(created.id)?.baseBranch).toBe('dev');

    const cleared = await service.update(created.id, { displayName: '', setupCommand: null });
    expect(cleared).toMatchObject({ displayName: null, setupCommand: null, baseBranch: 'dev' });
  });

  it('update rejects an unknown project', async () => {
    const { service } = setup();
    await expect(service.update(999, { displayName: 'x' })).rejects.toThrow(/not found/i);
  });
});

describe('Kyro initialization', () => {
  /** A cloner whose repo ships (or not) .agents/kyro/, like NovaGent vs a plain repo. */
  function clonerWithKyro(withKyro: boolean): Cloner {
    const source = makeGitRepo();
    if (withKyro) {
      mkdirSync(join(source, '.agents', 'kyro'), { recursive: true });
      writeFileSync(join(source, '.agents', 'kyro', 'project.json'), '{}\n');
      git(source, 'add', '.');
      git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'kyro');
    }
    return (slug, dest) => {
      execFileSync('git', ['clone', '-q', source, dest], { stdio: 'pipe' });
      git(dest, 'remote', 'set-url', 'origin', `https://github.com/${slug}.git`);
      return Promise.resolve();
    };
  }

  it('runs the initializer once, in the repo, when it ships .agents/kyro/', async () => {
    const kyroInit = vi.fn(() => Promise.resolve());
    const { service, repo, projectsDir } = setup({ cloner: clonerWithKyro(true), kyroInit });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(kyroInit).toHaveBeenCalledTimes(1);
    expect(kyroInit).toHaveBeenCalledWith(join(projectsDir, 'r'));
    expect(repo.findById(created.id)).toMatchObject({
      status: 'ready',
      hasKyro: true,
      kyroWarning: null,
    });
  });

  it('does not run anything and reports hasKyro=false without .agents/kyro/', async () => {
    const kyroInit = vi.fn(() => Promise.resolve());
    const { service, repo } = setup({ cloner: clonerWithKyro(false), kyroInit });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    expect(kyroInit).not.toHaveBeenCalled();
    expect(repo.findById(created.id)).toMatchObject({
      status: 'ready',
      hasKyro: false,
      kyroWarning: null,
    });
  });

  it('keeps the project ready and exposes a warning when the initializer fails', async () => {
    const kyroInit = vi.fn(() => Promise.reject(new Error('kyro: command not found')));
    const { service, repo, projectsDir } = setup({ cloner: clonerWithKyro(true), kyroInit });
    const created = await service.add({ repo: 'o/r' });
    await service.whenIdle();
    const project = repo.findById(created.id);
    expect(project).toMatchObject({ status: 'ready', hasKyro: true });
    expect(project?.kyroWarning).toContain('command not found');
    expect(existsSync(join(projectsDir, 'r'))).toBe(true);
  });

  it('also initializes Kyro for an adopted folder', async () => {
    const kyroInit = vi.fn(() => Promise.resolve());
    const { service, projectsDir } = setup({ kyroInit });
    const dir = join(projectsDir, 'r');
    execFileSync('git', ['clone', '-q', makeGitRepo(), dir], { stdio: 'pipe' });
    git(dir, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
    mkdirSync(join(dir, '.agents', 'kyro'), { recursive: true });
    const project = await service.add({ repo: 'o/r' });
    expect(kyroInit).toHaveBeenCalledWith(dir);
    expect(project).toMatchObject({ status: 'ready', hasKyro: true });
  });
});
