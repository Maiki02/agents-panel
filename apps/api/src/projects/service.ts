import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, realpath, rm, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Project } from '@agents-panel/shared';
import type { Config } from '../config.js';
import { KyroLock } from '../maintenance/lock.js';
import { normalizeOrigin, parseGithubRepo, type GithubRepo } from './github.js';
import {
  PROJECT_NAME_RE,
  ProjectConflictError,
  ProjectError,
  ProjectNotFoundError,
  type ProjectRepository,
} from './repo.js';

const execFileAsync = promisify(execFile);

const DETAIL_MAX = 500;
const GB = 1024 ** 3;
const SETUP_SCRIPT = 'scripts/panel-setup.sh';

/** Clones `slug` (owner/repo, already validated) into `dest`. Rejects when the clone fails. */
export type Cloner = (slug: string, dest: string) => Promise<void>;
export type FreeSpace = (path: string) => Promise<number>;

/** Default cloner: `gh repo clone owner/repo dest` through execFile (no shell). */
export const ghCloner: Cloner = async (slug, dest) => {
  await execFileAsync('gh', ['repo', 'clone', slug, dest]);
};

/** Initializes Kyro in a repo that already ships `.agents/kyro/`; rejects when it fails. */
export type KyroInitializer = (repoPath: string) => Promise<void>;

/**
 * Same command the VM runbook uses with the global CLI (verified in T1.1): creates the
 * git-ignored local.json and refreshes the global runtime; a second run changes nothing relevant.
 */
export const kyroInstall: KyroInitializer = async (repoPath) => {
  await execFileAsync('kyro', ['install', '--scope', 'workspace', '--init-workspace', '--yes'], {
    cwd: repoPath,
  });
  await linkKyroSkills();
};

/** `scripts/vm/06-kyro-skills.sh`: the repo's own script, two levels above apps/api. */
export const KYRO_SKILLS_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/vm/06-kyro-skills.sh', import.meta.url),
);

/**
 * `kyro install` refreshes the global skills in ~/.agents/skills, which Claude Code does not read;
 * the script links them into ~/.claude/skills (idempotent, global to the VM, not per project).
 * Best effort: the skills are already linked from earlier runs, so a failure here must not undo
 * an install that worked.
 */
export async function linkKyroSkills(script = KYRO_SKILLS_SCRIPT): Promise<void> {
  try {
    await execFileAsync('bash', [script]);
  } catch {
    // Already-linked skills keep working; the update script reports this step on its own.
  }
}

export const diskFreeBytes: FreeSpace = async (path) => {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
};

export interface AdoptProjectInput {
  name: string;
  repoPath: string;
  baseBranch: string;
  setupCommand?: string | undefined;
}

export interface AddProjectInput {
  repo: string;
  name?: string | undefined;
  displayName?: string | undefined;
  baseBranch?: string | undefined;
  setupCommand?: string | undefined;
}

export interface UpdateProjectInput {
  /** null or '' clears it. */
  displayName?: string | null | undefined;
  baseBranch?: string | undefined;
  /** null or '' clears it. */
  setupCommand?: string | null | undefined;
}

export interface ProjectServiceDeps {
  repo: ProjectRepository;
  config: Pick<Config, 'projectsDir' | 'minFreeDiskGb'>;
  cloner?: Cloner;
  freeSpace?: FreeSpace;
  kyroInit?: KyroInitializer;
  /** Shared with the Kyro updater so `kyro install` and `kyro update` never overlap. */
  kyroLock?: KyroLock;
}

function trimDetail(text: string): string {
  return text.trim().slice(0, DETAIL_MAX);
}

function failureDetail(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') return trimDetail(stderr);
    return trimDetail(error.message);
  }
  return trimDetail(String(error));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

/** Kebab-case internal name from a repo name: `Agents_Panel.v2` -> `agents-panel-v2`. */
export function deriveProjectName(repo: string): string {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

function cleanText(
  value: string | null | undefined,
  max: number,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  const text = (value ?? '').trim();
  if (text.length > max)
    throw new ProjectError(`${label} is too long (max ${String(max)} characters)`);
  return text === '' ? null : text;
}

/**
 * Registers projects from GitHub: adopts a folder that already holds the repo, or clones it in the
 * background. A project is `ready` only once origin and base branch were verified.
 */
export class ProjectService {
  private readonly repo: ProjectRepository;
  private readonly config: Pick<Config, 'projectsDir' | 'minFreeDiskGb'>;
  private readonly cloner: Cloner;
  private readonly freeSpace: FreeSpace;
  private readonly kyroInit: KyroInitializer;
  private readonly kyroLock: KyroLock;
  private readonly pending = new Map<number, Promise<void>>();

  constructor(deps: ProjectServiceDeps) {
    this.repo = deps.repo;
    this.config = deps.config;
    this.cloner = deps.cloner ?? ghCloner;
    this.freeSpace = deps.freeSpace ?? diskFreeBytes;
    this.kyroInit = deps.kyroInit ?? kyroInstall;
    this.kyroLock = deps.kyroLock ?? new KyroLock();
  }

  /**
   * Registers a folder that is already cloned (CLI `project:add`): same checks as ProjectRepository.add
   * (git repo, base branch exists, kebab-case name), project `ready` right away.
   */
  adopt(input: AdoptProjectInput): Promise<Project> {
    return this.repo.add(input);
  }

  /** Resolves when every clone in flight has finished (tests wait on this instead of sleeping). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending.values()]);
  }

  /** Returns the project right away: `cloning` for a new clone, `ready` for an adopted folder. */
  async add(input: AddProjectInput): Promise<Project> {
    const github = parseGithubRepo(input.repo);
    const name = input.name ?? deriveProjectName(github.repo);
    if (!PROJECT_NAME_RE.test(name)) {
      throw new ProjectError('Project name must be kebab-case (max 50 characters)');
    }
    const displayName = cleanText(input.displayName, 100, 'Display name') ?? null;
    const setupCommand = cleanText(input.setupCommand, 500, 'Setup command') ?? null;
    // An explicit baseBranch wins; otherwise the branch of a /tree/<branch> URL, if any.
    const baseBranch = cleanText(input.baseBranch, 200, 'Base branch') ?? github.branch;

    if (this.repo.findByName(name) ?? this.repo.findByRepoUrl(github.httpsUrl)) {
      throw new ProjectConflictError(`El proyecto ya existe: ${name}`);
    }
    const dest = join(this.config.projectsDir, name);

    if (await this.exists(dest)) {
      const branch = await this.verifyExisting(dest, github, baseBranch);
      const adopted = this.repo.insertGithub({
        name,
        displayName,
        repoUrl: github.httpsUrl,
        repoPath: dest,
        baseBranch: branch,
        setupCommand,
        status: 'ready',
        statusDetail: null,
      });
      await this.initKyro(adopted);
      return this.require(adopted.id);
    }

    const project = this.repo.insertGithub({
      name,
      displayName,
      repoUrl: github.httpsUrl,
      repoPath: dest,
      baseBranch: baseBranch ?? '',
      setupCommand,
      status: 'cloning',
      statusDetail: null,
    });
    return this.begin(project, github);
  }

  /** Clones again a project that ended in `error`. */
  async retry(id: number): Promise<Project> {
    const project = this.require(id);
    if (project.status !== 'error') {
      throw new ProjectConflictError(`Project is not in error: ${project.name}`);
    }
    if (project.repoUrl === null) throw new ProjectError('Project has no GitHub repository');
    const github = parseGithubRepo(project.repoUrl);
    if (await this.exists(project.repoPath)) {
      // Not created by this attempt: never delete it, only try to adopt it.
      try {
        const branch = await this.verifyExisting(
          project.repoPath,
          github,
          project.baseBranch === '' ? null : project.baseBranch,
        );
        this.repo.setStatus(id, 'ready', null, branch);
        await this.initKyro(this.require(id));
      } catch (error) {
        this.repo.setStatus(id, 'error', failureDetail(error));
      }
      return this.require(id);
    }
    this.repo.setStatus(id, 'cloning', null);
    return this.begin(this.require(id), github);
  }

  /** At startup: clones that were running when the panel stopped can never finish. */
  async recoverInterrupted(): Promise<number> {
    const stuck = this.repo.listByStatus('cloning');
    for (const project of stuck) {
      // A `cloning` row always means the panel created the folder, so the leftovers are its own.
      await this.removeOwnFolder(project.repoPath);
      this.repo.setStatus(project.id, 'error', 'interrumpido');
    }
    return stuck.length;
  }

  async update(id: number, input: UpdateProjectInput): Promise<Project> {
    const project = this.require(id);
    const displayName = cleanText(input.displayName, 100, 'Display name');
    const setupCommand = cleanText(input.setupCommand, 500, 'Setup command');
    let baseBranch: string | undefined;
    if (input.baseBranch !== undefined) {
      baseBranch = input.baseBranch.trim();
      if (project.status !== 'ready') {
        throw new ProjectConflictError(`Project is not ready: ${project.name}`);
      }
      await this.assertBranch(project.repoPath, baseBranch);
    }
    this.repo.updateFields(id, {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(setupCommand !== undefined ? { setupCommand } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
    });
    return this.require(id);
  }

  /** The setup command to propose when registering: only if the repo ships the script. */
  async suggestedSetup(project: Pick<Project, 'repoPath'>): Promise<string | null> {
    return (await this.exists(join(project.repoPath, SETUP_SCRIPT)))
      ? `bash ${SETUP_SCRIPT}`
      : null;
  }

  private require(id: number): Project {
    const project = this.repo.findById(id);
    if (!project) throw new ProjectNotFoundError(`Project not found: ${String(id)}`);
    return project;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Adopts an existing folder only if it is a git repo root whose origin is the requested repo. */
  private async verifyExisting(
    dest: string,
    github: GithubRepo,
    wantedBranch: string | null,
  ): Promise<string> {
    const conflict = (): never => {
      throw new ProjectConflictError(
        `The folder ${dest} already exists and is not a clone of ${github.slug}`,
      );
    };
    let origin: string;
    try {
      const top = await git(dest, ['rev-parse', '--show-toplevel']);
      if ((await realpath(top)) !== (await realpath(dest))) return conflict();
      origin = await git(dest, ['config', '--get', 'remote.origin.url']);
    } catch {
      return conflict();
    }
    if (normalizeOrigin(origin) !== normalizeOrigin(github.httpsUrl)) return conflict();
    return this.resolveBranch(dest, wantedBranch);
  }

  /** The requested base branch, or the clone's current one; it must exist locally. */
  private async resolveBranch(repoPath: string, wanted: string | null): Promise<string> {
    let branch = wanted;
    if (branch === null) {
      try {
        branch = await git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
      } catch {
        throw new ProjectError('Could not tell the base branch (detached HEAD): pass baseBranch');
      }
    }
    await this.assertBranch(repoPath, branch);
    return branch;
  }

  private async assertBranch(repoPath: string, branch: string): Promise<void> {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      throw new ProjectError(`Base branch not found: ${branch}`);
    }
  }

  /** Checks disk space, then clones in the background. The returned project is `cloning` or `error`. */
  private async begin(project: Project, github: GithubRepo): Promise<Project> {
    try {
      await mkdir(this.config.projectsDir, { recursive: true });
      const free = await this.freeSpace(this.config.projectsDir);
      if (free < this.config.minFreeDiskGb * GB) {
        this.repo.setStatus(project.id, 'error', 'sin espacio');
        return this.require(project.id);
      }
    } catch (error) {
      this.repo.setStatus(project.id, 'error', failureDetail(error));
      return this.require(project.id);
    }
    const run = this.runClone(project, github).finally(() => {
      this.pending.delete(project.id);
    });
    this.pending.set(project.id, run);
    return project;
  }

  private async runClone(project: Project, github: GithubRepo): Promise<void> {
    const dest = project.repoPath;
    // Created here (non-recursive mkdir fails with EEXIST), so only a folder we made is ever deleted.
    let created = false;
    try {
      try {
        await mkdir(dest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ProjectError(`La carpeta ${dest} ya existe: no se clona sobre ella`);
        }
        throw error;
      }
      created = true;
      await this.cloner(github.slug, dest);
      const origin = await git(dest, ['config', '--get', 'remote.origin.url']);
      if (normalizeOrigin(origin) !== normalizeOrigin(github.httpsUrl)) {
        throw new ProjectError(`El origin del clon no es ${github.slug}`);
      }
      const branch = await this.resolveBranch(
        dest,
        project.baseBranch === '' ? null : project.baseBranch,
      );
      this.repo.setStatus(project.id, 'ready', null, branch);
    } catch (error) {
      if (created) await this.removeOwnFolder(dest);
      this.repo.setStatus(project.id, 'error', failureDetail(error));
      return;
    }
    await this.initKyro(project);
  }

  /**
   * Initializes Kyro only when the repo ships `.agents/kyro/` (never adds Kyro files to other repos).
   * A failure never reverts the project: it stays ready with the warning in status_detail.
   */
  private async initKyro(project: Project): Promise<void> {
    if (!existsSync(join(project.repoPath, '.agents', 'kyro'))) return;
    try {
      await this.kyroLock.run(() => this.kyroInit(project.repoPath));
    } catch (error) {
      this.repo.setStatus(
        project.id,
        'ready',
        `Kyro: ${failureDetail(error)}`.slice(0, DETAIL_MAX),
      );
    }
  }

  /** Deletes a folder this service created, never anything outside the projects directory. */
  private async removeOwnFolder(path: string): Promise<void> {
    const target = resolve(path);
    const rel = relative(resolve(this.config.projectsDir), target);
    if (rel === '' || rel.startsWith('..') || rel.includes(sep)) return;
    await rm(target, { recursive: true, force: true });
  }
}
