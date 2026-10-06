import type { AutopilotRun, AutopilotStep, Chat, ChatEvent, ModelRole } from '@agents-panel/shared';
import {
  AlreadyRunningError,
  SessionLimitError,
  MaintenanceError,
  type AgentManager,
} from '../agent/manager.js';
import type { ChatRepository } from '../chats/repo.js';
import type { AgentSessionRepository } from '../chats/sessions-repo.js';
import type { QuestionRepository } from '../chats/questions-repo.js';
import type { KyroActionResult, KyroReadResult } from '../kyro/reader.js';
import type {
  ScopeSummary,
  AnalyzeFinding,
  KyroScopeState,
  KyroTaskContext,
  KyroWorkState,
} from '../kyro/state.js';
import type { KyroStateReader, WorktreeStateTracker } from '../worktrees/state-tracker.js';
import {
  DEFAULT_MAX_SESSIONS_PER_SPRINT,
  decideNextStep,
  fingerprint,
  needsScopeInit,
  type LastSession,
} from './decide.js';
import { POLICY_VERSION } from './policy.js';
import { APPROVED_VERDICTS, readQaVerdict } from './qa-report.js';
import {
  buildInitPrompt,
  buildMergeDevPrompt,
  buildMergePrompt,
  buildStepPrompt,
  checkCapabilities,
  type CapabilityReader,
  type PromptStep,
} from './prompts.js';
import { realGit, type MergeGit, type PilotGit } from './git-ops.js';
import { realGh, type PilotGh } from './github-cli.js';
import { runMergePhase, type MergePhaseOutcome } from './merge-phase.js';
import type { SecretFinding } from './secrets.js';
import type { AutopilotRunRepository } from './runs-repo.js';

/** Everything the pilot reads from the Kyro CLI. */
export interface PilotKyro extends KyroStateReader, CapabilityReader {
  contextPackTask(
    cwd: string,
    scope: string,
    taskId?: string | null,
  ): Promise<KyroReadResult<KyroTaskContext>>;
  workContextPack(cwd: string, work: string): Promise<KyroReadResult<KyroTaskContext>>;
  analyze(cwd: string, scope: string): Promise<KyroReadResult<AnalyzeFinding[]>>;
  /** Title, objective and closed sprints of a scope, for its PR; without it the PR is plain. */
  scopeSummary?(cwd: string, scope: string): Promise<KyroReadResult<ScopeSummary>>;
  completeScope(
    cwd: string,
    scope: string,
    acceptOpenDebt?: { reason: string },
  ): Promise<KyroActionResult>;
  closeWork(cwd: string, work: string, revision: number, reason: string): Promise<KyroActionResult>;
  /** Unblocks a task of a work when the user resumes the pilot; without it the work stays blocked. */
  unblockWorkTask?(
    cwd: string,
    work: string,
    task: string,
    revision: number,
  ): Promise<KyroActionResult>;
}

export const QUOTA_RETRY_MS = 15 * 60 * 1000;
export const QUEUE_RETRY_MS = 30 * 1000;
/** Times in a row a step may find the chat busy (a user message got in first) before the pilot stops. */
export const MAX_BUSY_RETRIES = 3;

export interface AutopilotDeps {
  chats: ChatRepository;
  runs: AutopilotRunRepository;
  manager: AgentManager;
  kyro: PilotKyro;
  tracker: WorktreeStateTracker;
  questions: QuestionRepository;
  /** Git operations the pilot runs itself; the real ones by default. */
  git?: PilotGit & MergeGit;
  /** `gh` for the PRs of the merge phase; the real one by default. */
  gh?: PilotGh;
  /** Base branch and validate command of the chat's project (R14, the push and merge checks). */
  projectOf?: (chat: Chat) => { baseBranch: string; validateCommand: string | null } | undefined;
  /** Secrets scan of a worktree; the real one by default, replaced by tests. */
  scan?: (cwd: string, base: string) => Promise<SecretFinding[]>;
  /** Longest the project's validate command may run in the merge phase. */
  validateTimeoutMs?: number;
  /** Sessions of every chat; needed to resume an interrupted step after a restart. */
  sessions?: AgentSessionRepository;
  maxSessionsPerSprint?: number;
  now?: () => number;
  /** Runs `fn` after `ms`; injectable so tests do not wait 15 minutes. */
  schedule?: (fn: () => void, ms: number) => void;
}

/** Short prompt for a step that a restart cut: the policy was already given in its session. */
const CONTINUE_PROMPT = [
  'The panel restarted while you were working on this step and your session was interrupted.',
  'Continue the same step where it stopped: re-read "kyro context-pack --kyro-scope <scope> --task --json" (or "kyro work context-pack" for a work) to see where Kyro is, and keep following the autopilot policy you were given. Do not start over.',
].join('\n');

interface PendingResume {
  role: ModelRole;
  step: AutopilotStep;
  sprintN: number | null;
  policyVersion: number;
}

interface AfterClose {
  closedBefore: number;
  sprintN: number | null;
  /** HEAD and local base branch before the closing session, to prove it committed and left the base alone. */
  headBefore: string | null;
  baseBefore: string | null;
  fromSeq: number;
}

const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Tool calls of the assistant events: `{ name, input }` of each tool_use block. */
function toolUses(events: ChatEvent[]): { name: string; input: Record<string, unknown> }[] {
  const uses: { name: string; input: Record<string, unknown> }[] = [];
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const message = (event.payload as { message?: { content?: unknown } } | null)?.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content as Record<string, unknown>[]) {
      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const input = block['input'];
        uses.push({
          name: block['name'],
          input:
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
        });
      }
    }
  }
  return uses;
}

/**
 * True when the session loaded the skill: the Skill tool with that name, or a Read of its
 * `skills/<skill>/SKILL.md`, which is how the pilot's prompts tell the agent to use a skill.
 */
export function usedSkill(events: ChatEvent[], skill: string): boolean {
  const skillFile = `/skills/${skill}/SKILL.md`;
  return toolUses(events).some(
    (use) =>
      (use.name === 'Skill' && text(use.input['skill']).includes(skill)) ||
      (use.name === 'Read' && text(use.input['file_path']).endsWith(skillFile)),
  );
}

/** True when the SDK reported the usage limit: a rejected rate-limit event or a limit error result. */
export function hitUsageLimit(events: ChatEvent[]): boolean {
  return events.some((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    if (event.type === 'rate_limit_event') {
      const info = payload?.['rate_limit_info'] as { status?: unknown } | undefined;
      return info?.status === 'rejected' || payload?.['status'] === 'rejected';
    }
    return (
      event.type.startsWith('result:') &&
      payload?.['is_error'] === true &&
      /usage limit|limit reached|rate limit/i.test(text(payload['result']))
    );
  });
}

/**
 * The pilot: takes a scope or work with the autopilot on to the end of its Kyro route, one new SDK
 * session per step. Every choice comes from Kyro's signals (decideNextStep); the agent's text is
 * never read. It never changes the permission mode of a session.
 */
export class Autopilot {
  private readonly loops = new Map<number, Promise<void>>();
  /** Steps interrupted by a restart, to reopen in their SDK session on the next pass of the loop. */
  private readonly pendingResume = new Map<number, PendingResume>();
  /**
   * Chats whose pilot the user just resumed or switched on: that is the signal they solved what
   * stopped it, so a task Kyro holds as blocked is unblocked once, at the next decision.
   */
  private readonly resumedByUser = new Set<number>();
  private readonly max: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: AutopilotDeps) {
    this.max = deps.maxSessionsPerSprint ?? DEFAULT_MAX_SESSIONS_PER_SPRINT;
    this.now = deps.now ?? Date.now;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref();
      });
  }

  /** The user resumed or switched on the pilot: like kick, and a blocked task gets unblocked once. */
  resumeByUser(chatId: number): void {
    this.resumedByUser.add(chatId);
    this.kick(chatId);
  }

  /** Starts (or continues) the loop of a chat in the background. */
  kick(chatId: number): void {
    void this.drive(chatId);
  }

  /** Same as kick, resolving when the loop leaves the active state; the tests await it. */
  drive(chatId: number): Promise<void> {
    const existing = this.loops.get(chatId);
    if (existing) return existing;
    const loop = this.loop(chatId)
      .catch((error: unknown) => {
        this.crashed(chatId, error);
      })
      .finally(() => {
        this.loops.delete(chatId);
        this.drainQueue();
      });
    this.loops.set(chatId, loop);
    return loop;
  }

  /** Starts the queued runs while there are free sessions. */
  drainQueue(): void {
    const { runs, manager } = this.deps;
    for (const run of runs.listByStatus('queued')) {
      if (!manager.hasCapacity()) break;
      if (this.loops.has(run.chatId)) continue;
      runs.dequeue(run.chatId);
      this.kick(run.chatId);
    }
  }

  private async loop(chatId: number): Promise<void> {
    const { chats, runs, manager, kyro, questions } = this.deps;
    let last: LastSession | null = null;
    let afterClose: AfterClose | null = null;
    let busy = 0;
    /** Why the task was blocked before the user resumed it; goes into the next prompt once. */
    let unblockedNote: string | null = null;
    for (;;) {
      let run = runs.get(chatId);
      const chat = chats.findById(chatId);
      if (!run || !chat) return;
      if (run.status === 'queued') run = runs.dequeue(chatId);
      if (run.status !== 'active') {
        this.leave(chat, run);
        return;
      }

      // A turn in progress (the first one, a manual message, a question) ends before the pilot acts.
      await manager.waitForIdle(chatId);
      run = runs.get(chatId) ?? run;
      if (run.status !== 'active') {
        this.leave(chat, run);
        return;
      }

      const cwd = chat.worktreePath;
      const blocked = await checkCapabilities(kyro, cwd);
      if (blocked?.kind === 'stop') {
        this.stop(chat, blocked);
        return;
      }
      const read =
        chat.kind === 'scope'
          ? await kyro.readScope(cwd, chat.slug)
          : await kyro.readWork(cwd, undefined, { preferred: chat.slug, since: chat.createdAt });

      // A session cut by a restart goes on in its own SDK session. When it was the plan or the init
      // (what creates the scope or work), Kyro has nothing to read yet and that is not a block.
      const resume = this.pendingResume.get(chatId);
      if (resume !== undefined && (read.ok || resume.step === 'plan' || resume.step === 'init')) {
        this.pendingResume.delete(chatId);
        const resumed = await this.resumeStep(chat, resume, read.ok ? read.state : null);
        if (resumed === null) return;
        if (resumed === 'busy') {
          if (this.tooBusy(chat, ++busy)) return;
          continue;
        }
        busy = 0;
        last = resumed.last;
        afterClose = resumed.afterClose;
        continue;
      }

      if (!read.ok) {
        // The scope of an approved idea is created by the pilot's first session.
        if (chat.kind === 'scope' && run.seedPath !== null && needsScopeInit(read.error, run)) {
          const initial = await this.openInit(chat, run.seedPath);
          if (initial === 'exit') return;
          last = initial;
          continue;
        }
        this.stop(chat, {
          state: 'bloqueado',
          blockedReason: 'kyro_bloqueado',
          detail: read.error.message,
        });
        return;
      }
      const state = read.state;

      // A completed work goes to the PR: the phase is stored, so a restart takes it up again.
      if (run.phase === 'merge') {
        await this.mergePhase(chat, state);
        return;
      }

      // Closing a sprint without having run QA is never accepted (R8).
      if (afterClose !== null) {
        const events = chats.allEventsAfter(chatId, afterClose.fromSeq);
        const closed = state.kind === 'scope' ? (state.sprint.closed ?? 0) : 0;
        if (closed > afterClose.closedBefore && !usedSkill(events, 'kyro-qa')) {
          this.stop(chat, {
            state: 'bloqueado',
            blockedReason: 'qa_sin_correr',
            detail: 'La sesión de cierre cerró el sprint sin correr kyro-qa',
          });
          return;
        }
        if (closed > afterClose.closedBefore && state.kind === 'scope') {
          const qa = await readQaVerdict(cwd, state.scope, afterClose.sprintN ?? closed);
          const verdict = qa.ok ? qa.verdict : qa.detail;
          if (!qa.ok || !APPROVED_VERDICTS.includes(qa.verdict)) {
            this.stop(chat, {
              state: 'bloqueado',
              blockedReason: 'qa_sin_aprobar',
              detail: `El QA del sprint no quedó aprobado: ${verdict}`,
            });
            return;
          }
        }
        if (closed > afterClose.closedBefore && state.kind === 'scope') {
          if (!(await this.pushAfterSprint(chat, afterClose))) return;
        }
        afterClose = null;
      }

      const decision = decideNextStep(state, run, last, { maxSessionsPerSprint: this.max });
      const userResumed = this.resumedByUser.delete(chatId);
      if (
        userResumed &&
        decision.kind === 'stop' &&
        decision.blockedReason === 'tarea_bloqueada' &&
        state.kind === 'work' &&
        state.nextTaskId !== null
      ) {
        const note = await this.unblock(chat, state);
        if (note === null) return;
        unblockedNote = note;
        continue;
      }
      if (decision.kind === 'complete') {
        if (!(await this.complete(chat, state))) return;
        last = { result: 'idle', answeredQuestion: false };
        continue;
      }
      if (decision.kind === 'finished') {
        // The agent closed it by itself: nobody committed, pushed or opened the PR yet, so the
        // merge phase still runs (it is what ends in `pr_lista` and the notification). A run
        // already in the merge phase returned above.
        runs.setPhase(chatId, 'merge');
        await this.mergePhase(chat, state);
        return;
      }
      if (decision.kind === 'stop') {
        this.stop(chat, decision);
        return;
      }

      let step: PromptStep;
      let findings: string[] = [];
      if (decision.kind === 'check_quality' && state.kind === 'scope') {
        const analysis = await kyro.analyze(cwd, state.scope);
        if (!analysis.ok) {
          this.stop(chat, {
            state: 'bloqueado',
            blockedReason: 'kyro_bloqueado',
            detail: `kyro analyze falló: ${analysis.error.message}`,
          });
          return;
        }
        const blocking = analysis.state.filter((f) => BLOCKING_SEVERITIES.has(f.severity));
        step = blocking.length > 0 ? 'fix' : 'close';
        findings = blocking.map((f) => `${f.severity} ${f.id} (${f.category}): ${f.detail}`);
      } else if (decision.kind === 'session') {
        step = decision.step;
      } else {
        return;
      }

      const task = await this.taskContext(chat, state);
      if (!task.ok) {
        this.stop(chat, {
          state: 'bloqueado',
          blockedReason: 'kyro_bloqueado',
          detail: task.error.message,
        });
        return;
      }
      const role = step === 'plan' ? 'thinker' : 'executor';
      const prompt = buildStepPrompt(step, {
        task: task.state,
        findings,
        ...(unblockedNote !== null ? { unblocked: unblockedNote } : {}),
      });
      unblockedNote = null;
      const sprintN = state.kind === 'scope' ? state.sprint.current : null;
      const fromSeq = chats.lastSeq(chatId);
      const answeredBefore = questions.listByChat(chatId, 'answered').length;
      const before =
        step === 'close' ? await this.gitMarks(chat) : { headBefore: null, baseBefore: null };
      try {
        this.deps.manager.start(chatId, prompt, {
          role,
          freshSession: true,
          pilot: { step: step, policyVersion: POLICY_VERSION, sprintN },
        });
      } catch (error) {
        if (error instanceof SessionLimitError || error instanceof MaintenanceError) {
          this.queue(chat);
          return;
        }
        if (error instanceof AlreadyRunningError) {
          // The user's message got in first: their turn wins, and the step is decided again after it.
          if (this.tooBusy(chat, ++busy)) return;
          continue;
        }
        throw error;
      }
      busy = 0;
      runs.beginSession(chatId, {
        step: step,
        sprintN,
        fingerprint: fingerprint(state),
        policyVersion: POLICY_VERSION,
      });
      if (step === 'close' && state.kind === 'scope') {
        afterClose = {
          closedBefore: state.sprint.closed ?? 0,
          sprintN,
          fromSeq,
          ...before,
        };
      }

      const settled = await this.settle(chat, fromSeq, answeredBefore);
      if (settled === 'exit') return;
      last = settled;
      this.drainQueue();
    }
  }

  /** HEAD and local base branch right now; null where git cannot say. */
  private async gitMarks(
    chat: Chat,
  ): Promise<{ headBefore: string | null; baseBefore: string | null }> {
    const git = this.deps.git ?? realGit;
    const base = this.deps.projectOf?.(chat)?.baseBranch;
    try {
      return {
        headBefore: await git.head(chat.worktreePath),
        baseBefore: base === undefined ? null : await git.branchHead(chat.worktreePath, base),
      };
    } catch {
      return { headBefore: null, baseBefore: null };
    }
  }

  /**
   * After a closing session that closed the sprint: the branch got a commit, the local base did
   * not move, and the branch goes to origin (never forced). False when the pilot stopped.
   */
  private async pushAfterSprint(chat: Chat, close: AfterClose): Promise<boolean> {
    const git = this.deps.git ?? realGit;
    const cwd = chat.worktreePath;
    try {
      if (close.headBefore !== null && (await git.head(cwd)) === close.headBefore) {
        throw new Error('La sesión de cierre no dejó ningún commit nuevo en la rama');
      }
      const base = this.deps.projectOf?.(chat)?.baseBranch;
      if (
        base !== undefined &&
        close.baseBefore !== null &&
        (await git.branchHead(cwd, base)) !== close.baseBefore
      ) {
        throw new Error(`La rama base ${base} cambió durante el cierre`);
      }
    } catch (error) {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'git',
        detail:
          error instanceof Error ? error.message : 'No se pudo comprobar el commit del cierre',
      });
      return false;
    }
    return this.push(chat);
  }

  /** `git push -u origin <branch>` of the chat's branch; a failure stops with `git` and the output. */
  private async push(chat: Chat): Promise<boolean> {
    try {
      await (this.deps.git ?? realGit).push(chat.worktreePath, chat.branch);
      this.deps.chats.appendEvent(chat.id, 'git_push', { branch: chat.branch, remote: 'origin' });
      return true;
    } catch (error) {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'git',
        detail: error instanceof Error ? error.message : 'El push falló',
      });
      return false;
    }
  }

  /**
   * The panel completes the scope or closes the work through the CLI and commits what Kyro wrote
   * under `.agents/kyro/` (R18); false when the pilot stopped.
   */
  private async complete(chat: Chat, state: KyroScopeState | KyroWorkState): Promise<boolean> {
    const { kyro, tracker } = this.deps;
    const cwd = chat.worktreePath;
    const name = state.kind === 'scope' ? state.scope : state.work;
    tracker.pilotMark(chat, {
      state: 'cerrando',
      reason: state.kind === 'scope' ? 'El piloto completa el scope' : 'El piloto cierra el work',
      data: { step: 'complete' },
    });
    const done =
      state.kind === 'scope'
        ? await kyro.completeScope(cwd, state.scope)
        : await kyro.closeWork(cwd, state.work, state.revision, 'Trabajo completado por el piloto');
    if (!done.ok) {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'kyro_bloqueado',
        detail: `Kyro no pudo cerrar ${name}: ${done.error.message}`,
      });
      return false;
    }
    if (!(await this.commitCompletion(chat, state))) return false;
    this.deps.runs.setPhase(chat.id, 'merge');
    return true;
  }

  /**
   * The merge phase (R14): the project's merge-dev skill or the generic merge, until the PRs are
   * open. Ends the loop either way: the run finishes with the PR ready, or it stops with a reason.
   */
  private async mergePhase(chat: Chat, state: KyroScopeState | KyroWorkState): Promise<void> {
    const { runs, tracker, chats } = this.deps;
    const project = this.deps.projectOf?.(chat);
    if (project === undefined) {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'otro',
        detail: 'No se encontró el proyecto del trabajo para armar el merge',
      });
      return;
    }
    const name = state.kind === 'scope' ? state.scope : state.work;
    const pr = await this.prText(chat, state);
    const outcome: MergePhaseOutcome = await runMergePhase(
      {
        git: this.deps.git ?? realGit,
        gh: this.deps.gh ?? realGh,
        mark: (markState, reason, extra) => {
          tracker.pilotMark(chat, {
            state: markState,
            reason,
            ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
            ...(extra?.data ? { data: extra.data } : {}),
            ...(extra?.record ? { record: true } : {}),
          });
        },
        record: (type, payload) => {
          chats.appendEvent(chat.id, type, payload);
        },
        session: (step, prompt) => this.mergeSession(chat, step, prompt),
        conflictPrompt: (conflicts) =>
          buildMergePrompt({ base: project.baseBranch, conflicts, name }),
        ...(this.deps.validateTimeoutMs !== undefined
          ? { validateTimeoutMs: this.deps.validateTimeoutMs }
          : {}),
        ...(this.deps.scan ? { scan: this.deps.scan } : {}),
      },
      {
        chat,
        base: project.baseBranch,
        project: { validateCommand: project.validateCommand },
        name,
        pr,
        mergeDevPrompt: buildMergeDevPrompt({
          worktree: chat.worktreePath,
          base: project.baseBranch,
          name,
        }),
      },
    );
    if (outcome.kind === 'exit') return;
    if (outcome.kind === 'stop') {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: outcome.blockedReason,
        detail: outcome.detail,
      });
      return;
    }
    runs.setPrUrls(chat.id, outcome.prUrls);
    runs.finish(chat.id);
  }

  /** Title and body of the PR: the scope's objective and the sprints it closed. */
  private async prText(
    chat: Chat,
    state: KyroScopeState | KyroWorkState,
  ): Promise<{ title: string; body: string }> {
    const footer = 'Abierta por el piloto del panel. Revisá los cambios antes de mergear.';
    if (state.kind === 'work') {
      return {
        title: `Work ${state.work}`,
        body: `Work \`${state.work}\` completado.\n\n${footer}`,
      };
    }
    const summary = await this.deps.kyro.scopeSummary?.(chat.worktreePath, state.scope);
    if (!summary?.ok)
      return { title: `Scope ${state.scope}`, body: `Scope \`${state.scope}\`.\n\n${footer}` };
    const { title, objective, sprints } = summary.state;
    return {
      title: title === '' ? `Scope ${state.scope}` : title,
      body: [
        objective === '' ? `Scope \`${state.scope}\`.` : objective,
        '',
        '## Sprints cerrados',
        ...(sprints.length === 0 ? ['- ninguno'] : sprints.map((sprint) => `- ${sprint}`)),
        '',
        footer,
      ].join('\n'),
    };
  }

  /** The executor session of the merge phase; 'exit' when the loop must stop. */
  private async mergeSession(
    chat: Chat,
    step: 'merge' | 'merge_dev',
    prompt: string,
  ): Promise<'done' | 'exit'> {
    const { chats, runs, questions } = this.deps;
    const fromSeq = chats.lastSeq(chat.id);
    const answeredBefore = questions.listByChat(chat.id, 'answered').length;
    try {
      this.deps.manager.start(chat.id, prompt, {
        role: 'executor',
        freshSession: true,
        pilot: { step, policyVersion: POLICY_VERSION, sprintN: null },
      });
    } catch (error) {
      if (error instanceof SessionLimitError || error instanceof MaintenanceError) {
        this.queue(chat);
        return 'exit';
      }
      throw error;
    }
    runs.beginSession(chat.id, {
      step,
      sprintN: null,
      fingerprint: {},
      policyVersion: POLICY_VERSION,
    });
    const settled = await this.settle(chat, fromSeq, answeredBefore);
    return settled === 'exit' ? 'exit' : 'done';
  }

  /** Commits the `.agents/kyro/` changes of the completion; a git failure stops the pilot. */
  private async commitCompletion(
    chat: Chat,
    state: KyroScopeState | KyroWorkState,
  ): Promise<boolean> {
    const message =
      state.kind === 'scope'
        ? `chore(kyro): completar scope ${state.scope}`
        : `chore(kyro): cerrar work ${state.work}`;
    try {
      await (this.deps.git ?? realGit).commitKyro(chat.worktreePath, message);
      return await this.push(chat);
    } catch (error) {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'git',
        detail: error instanceof Error ? error.message : 'El commit de cierre falló',
      });
      return false;
    }
  }

  /** Opens the session that creates the scope from the approved idea; 'exit' when the loop stops. */
  private async openInit(chat: Chat, seedPath: string): Promise<LastSession | 'exit'> {
    const { chats, runs, questions } = this.deps;
    const fromSeq = chats.lastSeq(chat.id);
    const answeredBefore = questions.listByChat(chat.id, 'answered').length;
    try {
      this.deps.manager.start(chat.id, buildInitPrompt({ scope: chat.slug, seedPath }), {
        role: 'thinker',
        freshSession: true,
        pilot: { step: 'init', policyVersion: POLICY_VERSION, sprintN: null },
      });
    } catch (error) {
      if (error instanceof SessionLimitError || error instanceof MaintenanceError) {
        this.queue(chat);
        return 'exit';
      }
      throw error;
    }
    runs.beginSession(chat.id, {
      step: 'init',
      sprintN: null,
      fingerprint: {},
      policyVersion: POLICY_VERSION,
    });
    const settled = await this.settle(chat, fromSeq, answeredBefore);
    if (settled === 'exit') return 'exit';
    this.drainQueue();
    return settled;
  }

  /** Waits for the session to end and reads how it ended; 'exit' when the loop must stop. */
  private async settle(
    chat: Chat,
    fromSeq: number,
    answeredBefore: number,
  ): Promise<LastSession | 'exit'> {
    const { chats, runs, manager, questions } = this.deps;
    await manager.waitForIdle(chat.id);
    const ended = chats.findById(chat.id);
    const events = chats.allEventsAfter(chat.id, fromSeq);
    if (hitUsageLimit(events)) {
      this.waitForQuota(chat);
      return 'exit';
    }
    if (ended?.status === 'cancelled') {
      // The user cancelled the turn: the pilot waits for them instead of opening the next step.
      runs.pause(chat.id);
      this.leave(chat, runs.get(chat.id));
      return 'exit';
    }
    if (ended?.status === 'error') {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'otro',
        detail: 'La sesión del agente terminó con error',
      });
      return 'exit';
    }
    this.drainQueue();
    return {
      result: 'idle',
      answeredQuestion: questions.listByChat(chat.id, 'answered').length > answeredBefore,
    };
  }

  /**
   * After a restart: takes up again every run that was moving. A step that had an SDK session is
   * resumed with `resume` and a short continuation prompt (no message from the user); a run between
   * steps decides again from Kyro. Paused and switched-off runs stay as they are, and a run waiting
   * for the usage limit keeps its `retry_at`.
   */
  resumeAll(): void {
    const { runs, chats, sessions } = this.deps;
    const interrupted = new Map(
      chats
        .list()
        .map((chat) => [chat.id, sessions?.lastOpen(chat.id)] as const)
        .filter(([, open]) => open !== undefined),
    );
    // Nothing of the old process is still running: its open sessions ended with the restart.
    sessions?.closeOpen('interrupted');

    for (const run of runs.listByStatus('waiting_quota')) {
      const wait = Math.max(0, (run.retryAt ?? 0) - this.now());
      this.schedule(() => {
        try {
          runs.retryAfterQuota(run.chatId);
        } catch {
          return; // Paused or switched off while waiting.
        }
        this.kick(run.chatId);
      }, wait);
    }
    for (const run of runs.listByStatus('active')) {
      const open = interrupted.get(run.chatId);
      if (open !== undefined && open.step !== 'manual') {
        if (run.sessionsInSprint >= this.max) {
          const chat = chats.findById(run.chatId);
          if (chat) {
            this.stop(chat, {
              state: 'bloqueado',
              blockedReason: 'tope_de_sesiones',
              detail: `El sprint llegó al tope de ${String(this.max)} sesiones`,
            });
          }
          continue;
        }
        this.pendingResume.set(run.chatId, {
          role: open.role,
          step: open.step,
          sprintN: open.sprintN,
          policyVersion: open.policyVersion ?? POLICY_VERSION,
        });
      }
      this.kick(run.chatId);
    }
    this.drainQueue();
  }

  /** Reopens the interrupted step in its SDK session; null when the loop must stop. */
  private async resumeStep(
    chat: Chat,
    resume: PendingResume,
    /** null while Kyro has no scope or work to read yet (the plan or init session was cut). */
    state: KyroScopeState | KyroWorkState | null,
  ): Promise<{ last: LastSession; afterClose: AfterClose | null } | 'busy' | null> {
    const { chats, runs, manager, questions } = this.deps;
    const fromSeq = chats.lastSeq(chat.id);
    const answeredBefore = questions.listByChat(chat.id, 'answered').length;
    try {
      manager.start(chat.id, CONTINUE_PROMPT, {
        role: resume.role,
        pilot: {
          step: resume.step,
          policyVersion: resume.policyVersion,
          sprintN: resume.sprintN,
        },
      });
    } catch (error) {
      if (error instanceof SessionLimitError || error instanceof MaintenanceError) {
        this.queue(chat);
        this.pendingResume.set(chat.id, resume);
        return null;
      }
      if (error instanceof AlreadyRunningError) {
        this.pendingResume.set(chat.id, resume);
        return 'busy';
      }
      throw error;
    }
    runs.countSession(chat.id);
    const settled = await this.settle(chat, fromSeq, answeredBefore);
    if (settled === 'exit') return null;
    // The QA check covers the whole step, so it counts from where the interrupted session began.
    const afterClose =
      resume.step === 'close' && state?.kind === 'scope'
        ? {
            closedBefore: state.sprint.closed ?? 0,
            sprintN: resume.sprintN,
            fromSeq: this.stepStartSeq(chat.id),
            // The session began before the restart: there is no mark to compare against.
            headBefore: null,
            baseBefore: null,
          }
        : null;
    return { last: settled, afterClose };
  }

  /** True (and the pilot stops) when the chat was busy `count` times in a row. */
  private tooBusy(chat: Chat, count: number): boolean {
    if (count <= MAX_BUSY_RETRIES) return false;
    this.stop(chat, {
      state: 'bloqueado',
      blockedReason: 'otro',
      detail: `El chat siguió ocupado por mensajes del usuario tras ${String(MAX_BUSY_RETRIES)} intentos`,
    });
    return true;
  }

  /** Seq just before the latest `session_started` event of the chat. */
  private stepStartSeq(chatId: number): number {
    const started = this.deps.chats
      .allEventsAfter(chatId, 0)
      .filter((event) => event.type === 'session_started');
    return Math.max(0, (started.at(-2)?.seq ?? 1) - 1);
  }

  /**
   * Takes the blocked task of a work out of `blocked` because the user resumed the pilot. Returns
   * the old blocker for the next prompt, or null when Kyro refused (the pilot stopped).
   */
  private async unblock(chat: Chat, state: KyroWorkState): Promise<string | null> {
    const task = state.nextTaskId ?? '';
    const reason = state.blockedReason ?? 'sin motivo';
    const done = this.deps.kyro.unblockWorkTask
      ? await this.deps.kyro.unblockWorkTask(chat.worktreePath, state.work, task, state.revision)
      : {
          ok: false as const,
          error: { kind: 'cli_failed' as const, message: 'unblock no disponible' },
        };
    if (!done.ok) {
      this.stop(chat, {
        state: 'bloqueado',
        blockedReason: 'kyro_bloqueado',
        detail: `No se pudo desbloquear ${task}: ${done.error.message}`,
      });
      return null;
    }
    this.deps.tracker.pilotMark(chat, {
      state: 'escribiendo_codigo',
      reason: `Reanudado por el usuario: el piloto desbloqueó ${task} en Kyro`,
      detail: reason,
      data: { unblocked: task },
      record: true,
    });
    return `Task ${task} was blocked with: "${reason}". The user resumed the pilot, which means they solved it, and the panel unblocked the task in Kyro. Retry it now. If it still cannot be done, say exactly what is missing before blocking it again.`;
  }

  private taskContext(
    chat: Chat,
    state: KyroScopeState | KyroWorkState,
  ): Promise<KyroReadResult<KyroTaskContext>> {
    return state.kind === 'scope'
      ? this.deps.kyro.contextPackTask(chat.worktreePath, state.scope, state.nextTaskId)
      : this.deps.kyro.workContextPack(chat.worktreePath, state.work);
  }

  /** The pilot stops on purpose: the Timeline and the run both carry the reason. */
  private stop(
    chat: Chat,
    stop: {
      state: Parameters<WorktreeStateTracker['pilotMark']>[1]['state'];
      blockedReason: Parameters<WorktreeStateTracker['pilotMark']>[1]['blockedReason'];
      detail: string | null;
      data?: Record<string, unknown>;
    },
  ): undefined {
    const reason = stop.detail ?? stop.blockedReason ?? stop.state;
    // A resume is consumed by the first decision; a stop before it must not unblock anything later.
    this.resumedByUser.delete(chat.id);
    this.deps.tracker.pilotMark(chat, {
      state: stop.state,
      reason: `El piloto frenó: ${reason}`,
      detail: stop.detail,
      blockedReason: stop.blockedReason ?? null,
      ...(stop.data ? { data: stop.data, record: true } : {}),
    });
    try {
      this.deps.runs.stop(chat.id, reason);
    } catch {
      // The run was paused or switched off at the same moment: that choice wins.
    }
    return undefined;
  }

  private queue(chat: Chat): undefined {
    this.deps.runs.queue(chat.id);
    this.deps.tracker.pilotMark(chat, {
      state: 'en_cola',
      reason: 'No hay sesiones libres: el trabajo espera en cola',
    });
    this.schedule(() => {
      this.drainQueue();
    }, QUEUE_RETRY_MS);
    return undefined;
  }

  private waitForQuota(chat: Chat): undefined {
    const retryAt = this.now() + QUOTA_RETRY_MS;
    this.deps.runs.waitForQuota(chat.id, retryAt);
    this.deps.tracker.pilotMark(chat, {
      state: 'sin_cupo_de_uso',
      reason: 'Se alcanzó el límite de uso: reintenta cada 15 minutos',
      data: { retryAt },
    });
    this.schedule(() => {
      try {
        this.deps.runs.retryAfterQuota(chat.id);
      } catch {
        return; // Paused or switched off while waiting.
      }
      this.kick(chat.id);
    }, QUOTA_RETRY_MS);
    return undefined;
  }

  /** The loop ended because the user paused or switched the pilot off. */
  private leave(chat: Chat, run: AutopilotRun | undefined): undefined {
    if (run?.status === 'paused') {
      this.deps.tracker.pilotMark(chat, { state: 'pausado', reason: 'Piloto en pausa' });
    }
    return undefined;
  }

  private crashed(chatId: number, error: unknown): void {
    const chat = this.deps.chats.findById(chatId);
    if (!chat) return;
    this.stop(chat, {
      state: 'bloqueado',
      blockedReason: 'otro',
      detail: error instanceof Error ? error.message : 'Falló el piloto',
    });
  }
}
