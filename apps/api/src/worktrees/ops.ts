import { basename } from 'node:path';
import type {
  Chat,
  CommitOutcome,
  Project,
  ProjectRepo,
  PullOutcome,
  PushOutcome,
  RepoOpOutcome,
  RepoOpResult,
  RepoStatus,
  WorktreeStatus,
} from '@agents-panel/shared';
import type { AgentManager } from '../agent/manager.js';
import { writeProjectEnv } from '../chats/service.js';
import type { EnvFileRepository } from '../env-files/repo.js';
import type { MergeGit, PilotGit, RepoGit } from '../pilot/git-ops.js';
import { realGit } from '../pilot/git-ops.js';
import { childRepos } from '../pilot/merge-phase.js';
import type { AutopilotRunRepository } from '../pilot/runs-repo.js';
import type { ProjectRepository } from '../projects/repo.js';
import type { ProjectRepoRepository } from '../projects/repos-repo.js';
import { runSetup, type WorktreeLog } from './create.js';
import type { WorktreeStateRepository } from './state-repo.js';

/** Statuses of the pilot run in which it resumes by itself: manual operations would race it. */
const PILOT_BUSY = ['active', 'queued', 'waiting_quota'] as const;

/** Lockfiles whose change after a pull means the dependencies must be installed again (D22). */
export const LOCKFILES = [
  'package-lock.json',
  'go.sum',
  'uv.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

/** The Timeline keeps at most this much output of an operation. */
export const OUTPUT_LIMIT = 8000;

const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\s][^()]*\))?!?: \S/;

export class WorktreeOpsError extends Error {
  override readonly name = 'WorktreeOpsError';
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

export type OpName = 'status' | 'commit' | 'pull_base' | 'pull_branch' | 'push' | 'reinstall';

export type { CommitOutcome, PullOutcome, RepoOpOutcome, RepoOpResult, RepoStatus, WorktreeStatus };

export interface WorktreeOpsDeps {
  chats: { findById(id: number): Chat | undefined };
  projects: Pick<ProjectRepository, 'findById'>;
  projectRepos: Pick<ProjectRepoRepository, 'listByProject'>;
  manager: Pick<AgentManager, 'isRunning' | 'inMaintenance'>;
  autopilot?: Pick<AutopilotRunRepository, 'get'>;
  state: Pick<WorktreeStateRepository, 'get' | 'transition'>;
  envFiles: Pick<EnvFileRepository, 'readAll'>;
  git?: PilotGit & MergeGit & RepoGit;
  /** The project's setup; the real one by default, replaceable in tests. */
  setup?: typeof runSetup;
}

interface RepoTarget {
  path: string;
  cwd: string;
  baseBranch: string;
}

function trim(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (recortado)` : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The manual git operations of a work (D19, D26): per repo status, commit of chosen files, pulls,
 * push and dependency reinstall. Everything is refused while the agent or the pilot could be
 * working on the same files, and every operation is recorded in the Timeline with actor `user`.
 */
export class WorktreeOps {
  private readonly busy = new Set<number>();
  private readonly git: PilotGit & MergeGit & RepoGit;
  private readonly setup: typeof runSetup;

  constructor(private readonly deps: WorktreeOpsDeps) {
    this.git = deps.git ?? realGit;
    this.setup = deps.setup ?? runSetup;
  }

  /** Read only: no guard besides the work existing. */
  async status(chatId: number): Promise<WorktreeStatus> {
    const { targets } = await this.resolve(chatId);
    const repos: RepoStatus[] = [];
    for (const target of targets) {
      try {
        const status = await this.git.status(target.cwd);
        repos.push({
          path: target.path,
          baseBranch: target.baseBranch,
          branch: status.branch,
          files: status.files,
          ahead: status.ahead,
          behind: status.behind,
          error: null,
        });
      } catch (error) {
        repos.push({
          path: target.path,
          baseBranch: target.baseBranch,
          branch: '',
          files: [],
          ahead: null,
          behind: null,
          error: message(error),
        });
      }
    }
    return { chatId, repos };
  }

  commit(chatId: number, repo: string, files: string[], text: string): Promise<CommitOutcome> {
    return this.guarded(chatId, async ({ chat, targets }) => {
      const target = this.pick(targets, repo);
      const warning = CONVENTIONAL.test(text.split('\n', 1)[0] ?? '')
        ? undefined
        : 'El mensaje no sigue Conventional Commits (por ejemplo "feat(api): ..."); se commiteó igual.';
      let outcome: CommitOutcome;
      try {
        await this.git.commitFiles(target.cwd, files, text);
        outcome = {
          path: target.path,
          result: 'ok',
          output: `Commit de ${String(files.length)} archivo(s): ${files.join(', ')}`,
          ...(warning ? { warning } : {}),
        };
      } catch (error) {
        outcome = {
          path: target.path,
          result: 'error',
          output: message(error),
          ...(warning ? { warning } : {}),
        };
      }
      this.record(chat, 'commit', target.path, outcome.result, outcome.output, {
        files,
        ...(warning ? { warning } : {}),
      });
      return outcome;
    });
  }

  pullBase(chatId: number, repo?: string): Promise<PullOutcome> {
    return this.pull(chatId, repo, 'pull_base');
  }

  pullBranch(chatId: number, repo?: string): Promise<PullOutcome> {
    return this.pull(chatId, repo, 'pull_branch');
  }

  push(chatId: number, repo?: string): Promise<PushOutcome> {
    return this.guarded(chatId, async ({ chat, targets }) => {
      const repos: RepoOpOutcome[] = [];
      for (const target of this.select(targets, repo)) {
        let outcome: RepoOpOutcome;
        try {
          const branch = await this.workBranch(chat, target);
          // Never forced, never retried: a remote that is ahead answers with git's own output.
          await this.git.push(target.cwd, branch);
          outcome = { path: target.path, result: 'ok', output: `Push de ${branch} a origin` };
        } catch (error) {
          outcome = { path: target.path, result: 'error', output: message(error) };
        }
        this.record(chat, 'push', target.path, outcome.result, outcome.output);
        repos.push(outcome);
      }
      return { repos };
    });
  }

  reinstall(chatId: number): Promise<RepoOpOutcome> {
    return this.guarded(chatId, ({ chat, project }) =>
      this.doReinstall(chat, project, 'reinstall'),
    );
  }

  // --- internals -----------------------------------------------------------------------------

  private pull(chatId: number, repo: string | undefined, op: 'pull_base' | 'pull_branch') {
    return this.guarded(chatId, async ({ chat, project, targets }): Promise<PullOutcome> => {
      const repos: RepoOpOutcome[] = [];
      for (const target of this.select(targets, repo)) {
        const outcome = await this.pullOne(chat, target, op);
        this.record(chat, op, target.path, outcome.result, outcome.output, {
          ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
          ...(outcome.lockfileChanged ? { lockfileChanged: true } : {}),
        });
        repos.push(outcome);
      }
      // D22: a changed lockfile in any repo reinstalls once, by itself.
      const reinstall = repos.some((r) => r.lockfileChanged)
        ? await this.doReinstall(chat, project, 'reinstall')
        : null;
      return { repos, reinstall };
    });
  }

  private async pullOne(
    chat: Chat,
    target: RepoTarget,
    op: 'pull_base' | 'pull_branch',
  ): Promise<RepoOpOutcome> {
    const { git } = this;
    try {
      const branch = op === 'pull_base' ? target.baseBranch : await this.workBranch(chat, target);
      const before = await git.head(target.cwd);
      const pulled = await git.pull(target.cwd, branch);
      if (!pulled.ok) {
        if (await git.mergeInProgress(target.cwd)) {
          const conflicts = await git.unmergedPaths(target.cwd);
          await git.abortMerge(target.cwd);
          return {
            path: target.path,
            result: 'conflict',
            output: pulled.output,
            conflicts,
            askAgent: true,
          };
        }
        return { path: target.path, result: 'error', output: pulled.output };
      }
      const changed = await git.changedFiles(target.cwd, before, 'HEAD');
      const lockfileChanged = changed.some((file) =>
        (LOCKFILES as readonly string[]).includes(basename(file)),
      );
      return {
        path: target.path,
        result: 'ok',
        output: pulled.output,
        ...(lockfileChanged ? { lockfileChanged } : {}),
      };
    } catch (error) {
      return { path: target.path, result: 'error', output: message(error) };
    }
  }

  private async doReinstall(chat: Chat, project: Project, op: 'reinstall'): Promise<RepoOpOutcome> {
    const buffered: { type: string; payload: Record<string, unknown> }[] = [];
    const log: WorktreeLog = (type, payload) => buffered.push({ type, payload });
    let outcome: RepoOpOutcome;
    try {
      await this.setup(project, chat.worktreePath, log);
      // Same order as creating the work: the panel's .env files go after the setup and win.
      await writeProjectEnv(this.deps.envFiles, project.id, chat.worktreePath, buffered);
      const text = buffered
        .map((e) => [e.payload['stdout'], e.payload['stderr']])
        .flat()
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .join('\n');
      outcome = {
        path: '.',
        result: 'ok',
        output: text === '' ? 'Dependencias y .env al día' : text,
      };
    } catch (error) {
      outcome = { path: '.', result: 'error', output: message(error) };
    }
    this.record(chat, op, '.', outcome.result, outcome.output);
    return outcome;
  }

  /** Runs `fn` only if the work exists, nothing is working on it and no other operation is. */
  private async guarded<T>(
    chatId: number,
    fn: (ctx: Awaited<ReturnType<WorktreeOps['resolve']>>) => Promise<T>,
  ): Promise<T> {
    const ctx = await this.resolve(chatId);
    this.assertIdle(chatId);
    this.busy.add(chatId);
    try {
      return await fn(ctx);
    } finally {
      this.busy.delete(chatId);
    }
  }

  private assertIdle(chatId: number): void {
    const { manager, autopilot } = this.deps;
    if (manager.isRunning(chatId)) {
      throw new WorktreeOpsError('El agente de este trabajo está corriendo', 409);
    }
    if (manager.inMaintenance) {
      throw new WorktreeOpsError('Hay una actualización de Kyro en curso', 409);
    }
    const run = autopilot?.get(chatId);
    if (run && (PILOT_BUSY as readonly string[]).includes(run.status)) {
      throw new WorktreeOpsError(
        `El piloto automático está ${run.status}: pausalo para operar a mano`,
        409,
      );
    }
    if (this.busy.has(chatId)) {
      throw new WorktreeOpsError('Ya hay una operación en curso en este trabajo', 409);
    }
  }

  private async resolve(chatId: number) {
    const chat = this.deps.chats.findById(chatId);
    if (!chat?.worktreePath) throw new WorktreeOpsError('El chat no tiene worktree', 404);
    const project = this.deps.projects.findById(chat.projectId);
    if (!project) throw new WorktreeOpsError('Project not found', 404);
    const bases = new Map<string, ProjectRepo>(
      this.deps.projectRepos.listByProject(project.id).map((r) => [r.path, r]),
    );
    const root: RepoTarget = {
      path: '.',
      cwd: chat.worktreePath,
      baseBranch: bases.get('.')?.baseBranch ?? project.baseBranch,
    };
    const children: RepoTarget[] = (await childRepos(chat.worktreePath)).map((dir) => {
      const name = basename(dir);
      return {
        path: name,
        cwd: dir,
        baseBranch: bases.get(name)?.baseBranch ?? project.baseBranch,
      };
    });
    return { chat, project, targets: [root, ...children] };
  }

  private pick(targets: RepoTarget[], repo: string): RepoTarget {
    const target = targets.find((t) => t.path === repo);
    if (!target) throw new WorktreeOpsError(`El repo no es parte del trabajo: ${repo}`, 404);
    return target;
  }

  private select(targets: RepoTarget[], repo: string | undefined): RepoTarget[] {
    return repo === undefined ? targets : [this.pick(targets, repo)];
  }

  /**
   * The branch to push or pull: the work's own. For the root it must be the chat's branch; a child
   * uses its current branch. Never the repo's base and never a detached HEAD.
   */
  private async workBranch(chat: Chat, target: RepoTarget): Promise<string> {
    const current = await this.git.currentBranch(target.cwd);
    if (current === '') throw new Error(`${target.path}: HEAD suelto, no hay rama para operar`);
    if (current === target.baseBranch) {
      throw new Error(`${target.path}: está en la rama base (${current}), no en la del trabajo`);
    }
    if (target.path === '.' && current !== chat.branch) {
      throw new Error(`La raíz está en ${current}, no en la rama del trabajo (${chat.branch})`);
    }
    return current;
  }

  /** Timeline entry that keeps the work's fine state as it is (same state, same detail). */
  private record(
    chat: Chat,
    op: OpName,
    repo: string,
    result: RepoOpResult,
    output: string,
    extra: Record<string, unknown> = {},
  ): void {
    const current = this.deps.state.get(chat.id);
    if (!current) return; // no fine state yet: nothing to preserve, nothing to annotate
    this.deps.state.transition(chat.id, {
      state: current.state,
      actor: 'user',
      reason: `Git: ${op} en ${repo} (${result})`,
      detail: current.detail,
      phase: current.phase,
      sprintCurrent: current.sprintCurrent,
      sprintClosed: current.sprintClosed,
      sprintTotal: current.sprintTotal,
      taskDone: current.taskDone,
      taskTotal: current.taskTotal,
      openDebt: current.openDebt,
      blockedReason: current.blockedReason,
      role: current.role,
      model: current.model,
      record: true,
      data: { op, repo, result, output: trim(output), ...extra },
    });
  }
}
