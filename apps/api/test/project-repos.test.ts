import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ProjectError, ProjectRepository } from '../src/projects/repo.js';
import { ProjectRepoRepository } from '../src/projects/repos-repo.js';
import { detectRepos, isValidBaseBranch } from '../src/projects/repos.js';
import { ProjectService } from '../src/projects/service.js';
import { makeGitRepo } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    stdio: 'pipe',
  });

/** A root repo on main with: ignored child `be` (on dev), versioned child `sub`, and a plain folder. */
function makeWorkspace(): string {
  const root = makeGitRepo();
  dirs.push(root);
  const child = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    git(join(root, name), 'init', '-q', '-b', 'dev');
  };
  child('be');
  child('sub');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.md'), 'x');
  writeFileSync(join(root, '.gitignore'), 'be/\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore be');
  return root;
}

describe('detectRepos', () => {
  it('returns only the child repos that the root ignores', async () => {
    const root = makeWorkspace();
    expect(await detectRepos(root)).toEqual(['be']);
  });

  it('ignores hidden folders and a missing path', async () => {
    const root = makeWorkspace();
    mkdirSync(join(root, '.hid'));
    git(join(root, '.hid'), 'init', '-q');
    writeFileSync(join(root, '.gitignore'), 'be/\n.hid/\n');
    expect(await detectRepos(root)).toEqual(['be']);
    expect(await detectRepos(join(root, 'nope'))).toEqual([]);
  });
});

describe('isValidBaseBranch', () => {
  it('accepts plain names and rejects options, spaces and ..', () => {
    expect(isValidBaseBranch('dev')).toBe(true);
    expect(isValidBaseBranch('release/1.2')).toBe(true);
    for (const bad of ['', '-x', 'a b', 'a..b', '+dev', 'a:b']) {
      expect(isValidBaseBranch(bad)).toBe(false);
    }
  });
});

describe('ProjectRepoRepository', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const repos = new ProjectRepoRepository(db);
    return { db, projects, repos };
  }

  it('keeps the edited base on re-detection and drops vanished children, never the root', async () => {
    const { projects, repos } = setup();
    const root = makeWorkspace();
    const project = await projects.add({ name: 'ws', repoPath: root, baseBranch: 'main' });

    const first = repos.syncDetected(project.id, 'main', ['be', 'fe']);
    expect(first.map((r) => [r.path, r.baseBranch])).toEqual([
      ['.', 'main'],
      ['be', 'main'],
      ['fe', 'main'],
    ]);
    const be = first.find((r) => r.path === 'be');
    expect(be).toBeDefined();
    repos.updateBase(be?.id ?? 0, 'dev');

    const second = repos.syncDetected(project.id, 'other', ['be']);
    expect(second.map((r) => [r.path, r.baseBranch])).toEqual([
      ['.', 'main'],
      ['be', 'dev'],
    ]);

    const third = repos.syncDetected(project.id, 'main', []);
    expect(third.map((r) => r.path)).toEqual(['.']);
  });

  it('rejects a base that is not a plain branch name', async () => {
    const { projects, repos } = setup();
    const root = makeWorkspace();
    const project = await projects.add({ name: 'ws', repoPath: root, baseBranch: 'main' });
    const [rootRow] = repos.syncDetected(project.id, 'main', []);
    expect(() => repos.updateBase(rootRow?.id ?? 0, '--force')).toThrow(ProjectError);
    expect(() => repos.updateBase(999, 'dev')).toThrow(ProjectError);
  });

  it('is removed with its project (cascade)', async () => {
    const { db, projects, repos } = setup();
    const root = makeWorkspace();
    const project = await projects.add({ name: 'ws', repoPath: root, baseBranch: 'main' });
    repos.syncDetected(project.id, 'main', ['be']);
    projects.deleteWithDependents(project.id);
    expect(db.prepare('SELECT count(*) AS n FROM project_repos').get()).toEqual({ n: 0 });
  });
});

describe('ProjectService repo detection', () => {
  it('creates the root row with the project base and one row per detected child', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const repos = new ProjectRepoRepository(db);
    const service = new ProjectService({
      repo: projects,
      config: { projectsDir: tmpdir(), minFreeDiskGb: 0 },
      projectRepos: repos,
    });
    const root = makeWorkspace();
    const project = await service.adopt({ name: 'ws', repoPath: root, baseBranch: 'main' });
    expect(repos.listByProject(project.id).map((r) => [r.path, r.baseBranch])).toEqual([
      ['.', 'main'],
      ['be', 'main'],
    ]);
  });
});
