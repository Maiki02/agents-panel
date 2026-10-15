import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  Actor,
  Chat,
  CommitOutcome,
  CreatePrOutcome,
  CreatePrRepoRequest,
  DeletePreview,
  DeleteRepoPreview,
  DeleteWorkOutcome,
  DiffAgainst,
  PrPreview,
  PrRepoOutcome,
  PrRepoPreview,
  Project,
  ProjectRepo,
  PullOutcome,
  PushOutcome,
  RepoOpOutcome,
  RepoDiff,
  RepoOpResult,
  RepoStatus,
  WorktreeStatus,
} from '@agents-panel/shared';
import type { AgentManager } from '../agent/manager.js';
import { writeProjectEnv } from '../chats/service.js';
import type { EnvFileRepository } from '../env-files/repo.js';
import type { MergeGit, PilotGit, RepoGit } from '../pilot/git-ops.js';
import { GitInputError, realGit } from '../pilot/git-ops.js';
import { realGh, type PilotGh } from '../pilot/github-cli.js';
import { openOrReusePr } from '../pilot/merge.js';
import { childRepos, MERGE_DEV_SKILL } from '../pilot/merge-phase.js';
import { readPrText, type PrDataReader } from '../pilot/pr-body.js';
import type { KyroStateReader } from './state-tracker.js';
import { describeSecrets, scanWorktreeSecrets, type SecretFinding } from '../pilot/secrets.js';
import type { AutopilotRunRepository } from '../pilot/runs-repo.js';
import type { ProjectRepository } from '../projects/repo.js';
import type { ProjectRepoRepository } from '../projects/repos-repo.js';
import { removeWorktreeStrict, runSetup, type WorktreeLog } from './create.js';
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

/** Characters of patch kept per file in a diff, and when one file is asked for alone ("ver más"). */
export const DIFF_PATCH_LIMIT = 20_000;
export const DIFF_FILE_PATCH_LIMIT = 400_000;

/** A PR title stays on one line and short. */
const TITLE_LIMIT = 200;

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

export type OpName =
  | 'status'
  | 'commit'
  | 'commit_kyro'
  | 'discard'
  | 'pull_base'
  | 'pull_branch'
  | 'push'
  | 'open_pr'
  | 'create_pr'
  | 'reinstall';

/** Who runs an action: the person at the web, the pilot, or the agent's own step (D26). */
export type OpActor = Extract<Actor, 'user' | 'pilot' | 'agent'>;

/** What the pilot needs from the service for the deterministic steps it runs itself. */
export type PilotActions = Pick<WorktreeOps, 'pushBranch' | 'commitKyro' | 'openPr'>;

/** Branch a PR goes to and its text. */
export interface PrDraft {
  base: string;
  title: string;
  body: string;
}

export type { CommitOutcome, PullOutcome, RepoOpOutcome, RepoOpResult, RepoStatus, WorktreeStatus };

export interface WorktreeOpsDeps {
  chats: {
    findById(id: number): Chat | undefined;
    appendEvent?(chatId: number, type: string, payload: unknown): unknown;
  };
  projects: Pick<ProjectRepository, 'findById'>;
  projectRepos: Pick<ProjectRepoRepository, 'listByProject'>;
  manager: Pick<AgentManager, 'isRunning' | 'inMaintenance'>;
  autopilot?: Pick<AutopilotRunRepository, 'get'> &
    Partial<Pick<AutopilotRunRepository, 'turnOff'>>;
  state: Pick<WorktreeStateRepository, 'get' | 'transition'>;
  envFiles: Pick<EnvFileRepository, 'readAll'>;
  git?: PilotGit & MergeGit & RepoGit;
  /** `gh` for the PRs; the real one by default. */
  gh?: PilotGh;
  /** Looks for secrets in what a repo would push; the real scan by default. */
  scan?: (cwd: string, base: string) => Promise<SecretFinding[]>;
  /** Reads the Kyro state for the preloaded PR body; without it the body lists the commits. */
  kyro?: Partial<KyroStateReader> & Partial<PrDataReader>;
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

/** `feat(<slug>): <title>` of the scope or work, on one line. */
function prefillTitle(chat: Chat): string {
  const scope = chat.slug.replace(/[()\s]/g, '');
  const title = chat.title.replace(/\s+/g, ' ').trim() || chat.slug;
  return `feat(${scope}): ${title}`.slice(0, TITLE_LIMIT);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The action service of a work (D19, D26): per repo status, commit of chosen files, pulls, push,
 * dependency reinstall and the steps the pilot runs itself (push of the branch, commit of Kyro,
 * PR). The pilot and the API both go through it, and every action is recorded in the Timeline with
 * the actor that ran it. The refusals while the agent or the pilot could be working on the same
 * files apply to the `user` actor only: the pilot is the one running. The lock per chat applies to
 * everyone.
 */
export class WorktreeOps {
  private readonly busy = new Set<number>();
  private readonly git: PilotGit & MergeGit & RepoGit;
  private readonly gh: PilotGh;
  private readonly setup: typeof runSetup;
  private readonly scan: NonNullable<WorktreeOpsDeps['scan']>;

  constructor(private readonly deps: WorktreeOpsDeps) {
    this.git = deps.git ?? realGit;
    this.gh = deps.gh ?? realGh;
    this.setup = deps.setup ?? runSetup;
    this.scan = deps.scan ?? scanWorktreeSecrets;
  }

  /**
   * The service for a caller that only runs the pilot's own steps (push, commit of Kyro, PR):
   * those never read the project, the repos or the agent, so those dependencies are not needed.
   */
  static forPilot(deps: {
    chats: WorktreeOpsDeps['chats'];
    state?: WorktreeOpsDeps['state'];
    git?: PilotGit & MergeGit;
    gh?: PilotGh;
  }): WorktreeOps {
    const unused = {} as never; // never read by pushBranch, commitKyro or openPr
    return new WorktreeOps({
      chats: deps.chats,
      projects: unused,
      projectRepos: unused,
      manager: unused,
      envFiles: unused,
      state: deps.state ?? { get: () => undefined, transition: () => undefined as never },
      ...(deps.git ? { git: deps.git as PilotGit & MergeGit & RepoGit } : {}),
      ...(deps.gh ? { gh: deps.gh } : {}),
    });
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

  /**
   * Read only (D27): the changes of one repo, never the ignored files. The agent may be running:
   * nothing is written. Each patch is cut at `DIFF_PATCH_LIMIT`; with `file` that file alone is
   * returned up to `DIFF_FILE_PATCH_LIMIT`. A bad, absolute or ignored `file` is a 400.
   */
  async diff(chatId: number, repo: string, against: DiffAgainst, file?: string): Promise<RepoDiff> {
    const { targets } = await this.resolve(chatId);
    const target = this.pick(targets, repo);
    try {
      const { files, moreFiles } = await this.git.diff(target.cwd, {
        against,
        base: target.baseBranch,
        ...(file === undefined ? {} : { file }),
        patchLimit: file === undefined ? DIFF_PATCH_LIMIT : DIFF_FILE_PATCH_LIMIT,
      });
      return { repo: target.path, against, baseBranch: target.baseBranch, files, moreFiles };
    } catch (error) {
      if (error instanceof GitInputError) throw new WorktreeOpsError(error.message, 400);
      throw new WorktreeOpsError(message(error), 422);
    }
  }

  commit(
    chatId: number,
    repo: string,
    files: string[],
    text: string,
    actor: OpActor = 'user',
  ): Promise<CommitOutcome> {
    return this.guarded(chatId, actor, async ({ chat, targets }) => {
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
      this.record(chat, actor, 'commit', target.path, outcome.result, outcome.output, {
        files,
        ...(warning ? { warning } : {}),
      });
      return outcome;
    });
  }

  /**
   * Discards the changes of chosen files (D28): always a manual action. An invalid path (absolute,
   * `..`, outside, ignored, unchanged) is a 400 and nothing is touched.
   */
  discard(
    chatId: number,
    repo: string,
    files: string[],
    actor: OpActor = 'user',
  ): Promise<RepoOpOutcome> {
    return this.guarded(chatId, actor, async ({ chat, targets }) => {
      const target = this.pick(targets, repo);
      try {
        await this.git.discardFiles(target.cwd, files);
      } catch (error) {
        if (error instanceof GitInputError) throw new WorktreeOpsError(error.message, 400);
        const outcome: RepoOpOutcome = {
          path: target.path,
          result: 'error',
          output: message(error),
        };
        this.record(chat, actor, 'discard', target.path, 'error', outcome.output, { files });
        return outcome;
      }
      const outcome: RepoOpOutcome = {
        path: target.path,
        result: 'ok',
        output: `Descartados ${String(files.length)} archivo(s): ${files.join(', ')}`,
      };
      this.record(chat, actor, 'discard', target.path, 'ok', outcome.output, { files });
      return outcome;
    });
  }

  pullBase(chatId: number, repo?: string, actor: OpActor = 'user'): Promise<PullOutcome> {
    return this.pull(chatId, repo, 'pull_base', actor);
  }

  pullBranch(chatId: number, repo?: string, actor: OpActor = 'user'): Promise<PullOutcome> {
    return this.pull(chatId, repo, 'pull_branch', actor);
  }

  push(chatId: number, repo?: string, actor: OpActor = 'user'): Promise<PushOutcome> {
    return this.guarded(chatId, actor, async ({ chat, targets }) => {
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
        this.record(chat, actor, 'push', target.path, outcome.result, outcome.output);
        repos.push(outcome);
      }
      return { repos };
    });
  }

  /**
   * Pushes the work's own branch (never forced) and keeps the `git_push` event. The root only: it
   * is the step the pilot runs after a sprint and after completing.
   */
  pushBranch(chatId: number, actor: OpActor = 'user'): Promise<RepoOpOutcome> {
    return this.locked(chatId, actor, async (chat) => {
      let outcome: RepoOpOutcome;
      try {
        await this.git.push(chat.worktreePath, chat.branch);
        this.deps.chats.appendEvent?.(chat.id, 'git_push', {
          branch: chat.branch,
          remote: 'origin',
        });
        outcome = { path: '.', result: 'ok', output: `Push de ${chat.branch} a origin` };
      } catch (error) {
        outcome = { path: '.', result: 'error', output: message(error) };
      }
      this.record(chat, actor, 'push', '.', outcome.result, outcome.output);
      return outcome;
    });
  }

  /** Commits what Kyro wrote under `.agents/kyro/` (the completion of a scope or work). */
  commitKyro(chatId: number, text: string, actor: OpActor = 'user'): Promise<RepoOpOutcome> {
    return this.locked(chatId, actor, async (chat) => {
      let outcome: RepoOpOutcome;
      try {
        const { committed } = await this.git.commitKyro(chat.worktreePath, text);
        outcome = {
          path: '.',
          result: 'ok',
          output: committed ? text : 'Sin cambios en .agents/kyro para commitear',
        };
      } catch (error) {
        outcome = { path: '.', result: 'error', output: message(error) };
      }
      this.record(chat, actor, 'commit_kyro', '.', outcome.result, outcome.output);
      return outcome;
    });
  }

  /** Opens the PR of the work's branch or reuses the one already open; `output` is its URL. */
  openPr(chatId: number, pr: PrDraft, actor: OpActor = 'user'): Promise<RepoOpOutcome> {
    return this.locked(chatId, actor, async (chat) => {
      let outcome: RepoOpOutcome;
      try {
        const url = await openOrReusePr(this.gh, {
          cwd: chat.worktreePath,
          branch: chat.branch,
          ...pr,
        });
        outcome = { path: '.', result: 'ok', output: url };
      } catch (error) {
        outcome = { path: '.', result: 'error', output: message(error) };
      }
      this.record(chat, actor, 'open_pr', '.', outcome.result, outcome.output, { base: pr.base });
      return outcome;
    });
  }

  /**
   * The detailed PR body of a work or scope (objective and tasks), or null for a direct request or
   * when Kyro cannot be read: the preview then lists the commits as before.
   */
  private async detailedPrBody(chat: Chat): Promise<string | null> {
    const kyro = this.deps.kyro;
    if (kyro === undefined || (chat.kind !== 'work' && chat.kind !== 'scope')) return null;
    try {
      let name: string;
      if (chat.kind === 'scope') {
        const read = await kyro.readScope?.(chat.worktreePath, chat.slug);
        if (!read?.ok) return null;
        name = read.state.scope;
      } else {
        const read = await kyro.readWork?.(chat.worktreePath, undefined, {
          preferred: chat.slug,
          since: chat.createdAt,
        });
        if (!read?.ok) return null;
        name = read.state.work;
      }
      return (await readPrText(kyro, chat.worktreePath, { kind: chat.kind, name }))?.body ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Read only: the repos of the work with commits outside their base (the candidates for a PR),
   * each with its open PR if any and the prefilled title and body (D25).
   */
  async prPreview(chatId: number): Promise<PrPreview> {
    const { chat, targets } = await this.resolve(chatId);
    const detailed = await this.detailedPrBody(chat);
    const repos: PrRepoPreview[] = [];
    for (const target of targets) {
      try {
        const commits = await this.git.commitsOutside(target.cwd, target.baseBranch);
        if (commits === 0) continue;
        const branch = await this.workBranch(chat, target);
        const subjects = await this.git.subjectsOutside(target.cwd, target.baseBranch);
        let openPrUrl: string | null = null;
        try {
          openPrUrl = await this.gh.openPr(target.cwd, branch, target.baseBranch);
        } catch {
          // gh unavailable or not logged in: the preview still works, the PR step reports it.
        }
        repos.push({
          path: target.path,
          baseBranch: target.baseBranch,
          branch,
          commits,
          openPrUrl,
          title: prefillTitle(chat),
          body: detailed ?? subjects.map((subject) => `- ${subject}`).join('\n'),
        });
      } catch {
        // A repo git cannot read is not a candidate; the status shows its error.
      }
    }
    return {
      chatId,
      hasMergeDev: existsSync(join(chat.worktreePath, MERGE_DEV_SKILL)),
      repos,
    };
  }

  /**
   * Per requested repo: brings the base in (a conflict is aborted and listed, and the next repo
   * goes on), looks for secrets, pushes the work's branch (never forced) and opens the PR into the
   * repo's base, or answers the one already open (the push updated it). Every repo leaves its entry
   * in the Timeline with the link. No validation runs here (D25).
   */
  createPr(
    chatId: number,
    actor: OpActor,
    requests: CreatePrRepoRequest[],
  ): Promise<CreatePrOutcome> {
    return this.guarded(chatId, actor, async ({ chat, targets }) => {
      const picked = requests.map((request) => ({
        target: this.pick(targets, request.repo),
        title: request.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT),
        body: request.body,
      }));
      if (picked.some((p) => p.title === '')) {
        throw new WorktreeOpsError('El título de la PR no puede estar vacío', 400);
      }
      const repos: PrRepoOutcome[] = [];
      for (const { target, title, body } of picked) {
        const outcome = await this.createOnePr(chat, target, title, body);
        this.record(chat, actor, 'create_pr', target.path, outcome.result, outcome.output, {
          base: target.baseBranch,
          title,
          ...(outcome.url ? { url: outcome.url, existing: outcome.existing === true } : {}),
          ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
          ...(outcome.secrets ? { secrets: outcome.secrets } : {}),
        });
        repos.push(outcome);
      }
      return { repos };
    });
  }

  private async createOnePr(
    chat: Chat,
    target: RepoTarget,
    title: string,
    body: string,
  ): Promise<PrRepoOutcome> {
    try {
      const branch = await this.workBranch(chat, target);
      const pulled = await this.pullOne(chat, target, 'pull_base');
      if (pulled.result !== 'ok') return pulled;
      const secrets = await this.scan(target.cwd, target.baseBranch);
      if (secrets.length > 0) {
        return {
          path: target.path,
          result: 'error',
          output: `Hay secretos en los cambios, no se pusheó ni se abrió la PR: ${describeSecrets(secrets)}`,
          secrets: [...new Set(secrets.map((s) => s.file))],
        };
      }
      await this.git.push(target.cwd, branch);
      const existing = await this.gh.openPr(target.cwd, branch, target.baseBranch);
      const url =
        existing ??
        (await openOrReusePr(this.gh, {
          cwd: target.cwd,
          branch,
          base: target.baseBranch,
          title,
          body,
        }));
      return { path: target.path, result: 'ok', output: url, url, existing: existing !== null };
    } catch (error) {
      return { path: target.path, result: 'error', output: message(error) };
    }
  }

  /** Timeline entry of a step of the agent asked for by `actor` (the step itself runs elsewhere). */
  markStep(chatId: number, step: string, actor: OpActor = 'user', detail?: string): void {
    const chat = this.deps.chats.findById(chatId);
    if (!chat) return;
    this.mark(chat, actor, `Paso pedido: ${step}`, {
      op: 'step',
      step,
      ...(detail === undefined ? {} : { detail: trim(detail) }),
    });
  }

  /**
   * Read only (D28): what deleting the work would lose, per repo: its branch, whether origin has
   * it, the commits no remote has and the files that are not committed.
   */
  async deletePreview(chatId: number): Promise<DeletePreview> {
    const { chat, targets } = await this.resolve(chatId);
    const repos: DeleteRepoPreview[] = [];
    for (const target of targets) {
      const entry: DeleteRepoPreview = {
        path: target.path,
        branch: null,
        remoteExists: false,
        unpushedCommits: 0,
        uncommittedFiles: [],
        error: null,
      };
      try {
        entry.uncommittedFiles = (await this.git.status(target.cwd)).files.map((f) => f.path);
        entry.branch = await this.deletableBranch(chat, target);
        if (entry.branch !== null) {
          entry.unpushedCommits = await this.git.unpushedCommits(target.cwd, entry.branch);
          try {
            entry.remoteExists = await this.git.remoteBranchExists(target.cwd, entry.branch);
          } catch (error) {
            entry.error = `No se pudo consultar origin: ${message(error)}`;
          }
        }
      } catch (error) {
        entry.error = message(error);
      }
      repos.push(entry);
    }
    return { chatId, worktreePath: chat.worktreePath, repos };
  }

  /**
   * Deletes the work (D28): the worktree and the local branches (root and children), and in origin
   * the work's branches only with `deleteRemote`. Never the base. The agent must be idle and the
   * pilot not busy (409); the pilot's run is switched off. The work goes through `limpiando` to
   * `archivado` (read only, final); a failure halfway leaves it in `revisar` with the detail.
   */
  deleteWork(
    chatId: number,
    deleteRemote: boolean,
    actor: OpActor = 'user',
  ): Promise<DeleteWorkOutcome> {
    return this.guarded(chatId, actor, async ({ chat, project, targets }) => {
      const steps: string[] = [];
      try {
        // Off before anything is touched: a paused or stopped pilot must not wake up on a ghost.
        try {
          this.deps.autopilot?.turnOff?.(chat.id);
        } catch {
          // Already off, finished or without a run: nothing to switch off.
        }
        this.moveTo(chat, 'limpiando', actor, 'Borrar trabajo', null, { deleteRemote });
        const branches: { target: RepoTarget; branch: string }[] = [];
        for (const target of targets) {
          const branch = await this.deletableBranch(chat, target);
          if (branch !== null) branches.push({ target, branch });
        }
        if (deleteRemote) {
          // Before the folder goes: the children are clones that only live inside it.
          for (const { target, branch } of branches) {
            if (!(await this.git.remoteBranchExists(target.cwd, branch))) continue;
            await this.git.deleteRemoteBranch(target.cwd, branch, target.baseBranch);
            steps.push(`Rama remota borrada en ${target.path}: ${branch}`);
          }
        }
        const root = targets.find((t) => t.path === '.');
        steps.push(
          ...(await removeWorktreeStrict(
            project.repoPath,
            chat.worktreePath,
            chat.branch,
            root?.baseBranch ?? project.baseBranch,
          )),
        );
        for (const { target, branch } of branches) {
          if (target.path !== '.') steps.push(`Rama local borrada en ${target.path}: ${branch}`);
        }
      } catch (error) {
        const detail = `${message(error)}${steps.length > 0 ? ` (hecho: ${steps.join('; ')})` : ''}`;
        this.moveTo(chat, 'revisar', actor, 'El borrado del trabajo falló', detail, { steps });
        throw new WorktreeOpsError(`El borrado falló: ${trim(detail)}`, 422);
      }
      this.moveTo(chat, 'archivado', actor, 'Trabajo borrado', null, { deleteRemote, steps });
      return { chatId: chat.id, state: 'archivado', steps };
    });
  }

  reinstall(chatId: number, actor: OpActor = 'user'): Promise<RepoOpOutcome> {
    return this.guarded(chatId, actor, ({ chat, project }) =>
      this.doReinstall(chat, project, 'reinstall', actor),
    );
  }

  // --- internals -----------------------------------------------------------------------------

  private pull(
    chatId: number,
    repo: string | undefined,
    op: 'pull_base' | 'pull_branch',
    actor: OpActor,
  ) {
    return this.guarded(chatId, actor, async ({ chat, project, targets }): Promise<PullOutcome> => {
      const repos: RepoOpOutcome[] = [];
      for (const target of this.select(targets, repo)) {
        const outcome = await this.pullOne(chat, target, op);
        this.record(chat, actor, op, target.path, outcome.result, outcome.output, {
          ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
          ...(outcome.lockfileChanged ? { lockfileChanged: true } : {}),
        });
        repos.push(outcome);
      }
      // D22: a changed lockfile in any repo reinstalls once, by itself.
      const reinstall = repos.some((r) => r.lockfileChanged)
        ? await this.doReinstall(chat, project, 'reinstall', actor)
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

  private async doReinstall(
    chat: Chat,
    project: Project,
    op: 'reinstall',
    actor: OpActor,
  ): Promise<RepoOpOutcome> {
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
    this.record(chat, actor, op, '.', outcome.result, outcome.output);
    return outcome;
  }

  /** Runs `fn` only if the work exists and the guards of the actor pass (see `hold`). */
  private async guarded<T>(
    chatId: number,
    actor: OpActor,
    fn: (ctx: Awaited<ReturnType<WorktreeOps['resolve']>>) => Promise<T>,
  ): Promise<T> {
    const ctx = await this.resolve(chatId);
    return this.hold(chatId, actor, () => fn(ctx));
  }

  /** Like `guarded` for the steps that only need the chat (no repos, no project). */
  private async locked<T>(
    chatId: number,
    actor: OpActor,
    fn: (chat: Chat) => Promise<T>,
  ): Promise<T> {
    const chat = this.deps.chats.findById(chatId);
    if (!chat?.worktreePath) throw new WorktreeOpsError('El chat no tiene worktree', 404);
    this.assertNotArchived(chatId);
    return this.hold(chatId, actor, () => fn(chat));
  }

  /**
   * The agent and pilot guards apply to the user only: the pilot is the one running, and the
   * agent's steps are launched by it. The per-chat lock applies to everyone.
   */
  private async hold<T>(chatId: number, actor: OpActor, fn: () => Promise<T>): Promise<T> {
    if (actor === 'user') this.assertIdle(chatId);
    if (this.busy.has(chatId)) {
      throw new WorktreeOpsError('Ya hay una operación en curso en este trabajo', 409);
    }
    this.busy.add(chatId);
    try {
      return await fn();
    } finally {
      this.busy.delete(chatId);
    }
  }

  /**
   * Throws 409 when a manual action could race the agent, a Kyro update or the pilot (the guards
   * of the `user` actor); the manual steps of the agent check it before launching it.
   */
  assertIdle(chatId: number): void {
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
  }

  /** An archived work has no worktree left: it is read only and no operation applies (409). */
  private assertNotArchived(chatId: number): void {
    if (this.deps.state.get(chatId)?.state === 'archivado') {
      throw new WorktreeOpsError('El trabajo está archivado: es de solo lectura', 409);
    }
  }

  private async resolve(chatId: number) {
    const chat = this.deps.chats.findById(chatId);
    if (!chat?.worktreePath) throw new WorktreeOpsError('El chat no tiene worktree', 404);
    this.assertNotArchived(chatId);
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

  /**
   * The branch of the work in a repo that deleting removes: the chat's own for the root, the
   * current one for a child. Null when a child sits on its base or detached (nothing of the work to
   * delete); a root whose work branch is its base is refused. Never the base.
   */
  private async deletableBranch(chat: Chat, target: RepoTarget): Promise<string | null> {
    if (target.path === '.') {
      if (chat.branch === target.baseBranch) {
        throw new Error(`La rama del trabajo es la base (${chat.branch}): no se borra`);
      }
      return chat.branch;
    }
    const current = await this.git.currentBranch(target.cwd);
    return current === '' || current === target.baseBranch ? null : current;
  }

  /** Moves the work to a state keeping its progress, with a Timeline entry. */
  private moveTo(
    chat: Chat,
    state: 'limpiando' | 'revisar' | 'archivado',
    actor: OpActor,
    reason: string,
    detail: string | null,
    data: Record<string, unknown>,
  ): void {
    const current = this.deps.state.get(chat.id);
    this.deps.state.transition(chat.id, {
      state,
      actor,
      reason,
      detail,
      phase: current?.phase ?? null,
      sprintCurrent: current?.sprintCurrent ?? null,
      sprintClosed: current?.sprintClosed ?? null,
      sprintTotal: current?.sprintTotal ?? null,
      taskDone: current?.taskDone ?? null,
      taskTotal: current?.taskTotal ?? null,
      openDebt: current?.openDebt ?? null,
      role: current?.role ?? null,
      model: current?.model ?? null,
      record: true,
      data: { op: 'delete', ...data },
    });
  }

  /** Timeline entry of a git operation (see `mark`). */
  private record(
    chat: Chat,
    actor: OpActor,
    op: OpName,
    repo: string,
    result: RepoOpResult,
    output: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.mark(chat, actor, `Git: ${op} en ${repo} (${result})`, {
      op,
      repo,
      result,
      output: trim(output),
      ...extra,
    });
  }

  /** Timeline entry that keeps the work's fine state as it is (same state, same detail). */
  private mark(chat: Chat, actor: OpActor, reason: string, data: Record<string, unknown>): void {
    const current = this.deps.state.get(chat.id);
    if (!current) return; // no fine state yet: nothing to preserve, nothing to annotate
    this.deps.state.transition(chat.id, {
      state: current.state,
      actor,
      reason,
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
      data,
    });
  }
}
