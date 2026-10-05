import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Chat, ChatKind, ModelRole, PendingQuestion } from '@agents-panel/shared';
import {
  AgentManager,
  type PilotTurn,
  AlreadyRunningError,
  MaintenanceError,
  SessionLimitError,
} from '../agent/manager.js';
import type { EnvFileRepository } from '../env-files/repo.js';
import { EnvFileError } from '../env-files/validate.js';
import { writeEnvFiles } from '../env-files/write.js';
import type { WorktreeStateTracker } from '../worktrees/state-tracker.js';
import { InvalidModelError, validateModels, type ProjectRepository } from '../projects/repo.js';
import {
  WorktreeError,
  createWorktree,
  removeWorktree,
  validateSlug,
} from '../worktrees/create.js';
import {
  QuestionAnswerError,
  QuestionNotFoundError,
  QuestionNotPendingError,
  type QuestionRepository,
} from './questions-repo.js';
import type { ChatRepository } from './repo.js';
import { POLICY_VERSION, buildPolicy } from '../pilot/policy.js';
import type { AutopilotRunRepository } from '../pilot/runs-repo.js';

export class ChatError extends Error {
  override readonly name = 'ChatError';
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

const FLOW_SKILL: Record<Exclude<ChatKind, 'direct'>, { skill: string; command: string }> = {
  idea: { skill: 'kyro-idea', command: '/kyro:idea' },
  scope: { skill: 'kyro-forge', command: '/kyro:forge' },
  work: { skill: 'kyro-work', command: '/kyro:work' },
};

/**
 * First prompt of a chat. On the VM the Kyro commands are not registered as slash commands for
 * SDK sessions (checked: init reports no kyro commands or skills), so the prompt points the
 * agent at the installed skill instead. The skill is the same one `/kyro:forge` or `/kyro:work`
 * would load.
 */
export function buildInitialPrompt(kind: ChatKind, request: string, home = homedir()): string {
  // A direct request carries no Kyro flow: the agent gets the user's words as they are.
  if (kind === 'direct') return request;
  const { skill, command } = FLOW_SKILL[kind];
  const skillPath = join(home, '.agents', 'skills', skill, 'SKILL.md');
  return [
    `Run the Kyro flow equivalent to \`${command}\` for the request below.`,
    `Read ${skillPath} first and follow it exactly.`,
    '',
    `Request: ${request}`,
  ].join('\n');
}

function titleFrom(prompt: string, slug: string): string {
  const firstLine = prompt.split('\n', 1)[0]?.trim() ?? '';
  return (firstLine === '' ? slug : firstLine).slice(0, 80);
}

export interface ChatServiceDeps {
  chats: ChatRepository;
  projects: ProjectRepository;
  manager: AgentManager;
  questions: QuestionRepository;
  worktreesDir: string;
  /** The project's development .env files, written into every new worktree after setup. */
  envFiles: EnvFileRepository;
  /** Fine state of scopes and works; absent in tests that do not track it. */
  tracker?: WorktreeStateTracker;
  /** Autopilot rows; absent in tests that do not use the pilot. */
  autopilot?: AutopilotRunRepository;
  /** Called once the chat exists and its first turn started, when the autopilot is on. */
  onAutopilotStart?: (chatId: number) => void;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async create(input: {
    projectId: number;
    kind: ChatKind;
    slug: string;
    prompt: string;
    models?: { thinker?: string; executor?: string };
    /** Switch the autopilot on from the start: only a scope or a work can have one. */
    autopilot?: boolean;
  }): Promise<Chat> {
    const { chats, projects, manager, worktreesDir } = this.deps;
    const project = projects.findById(input.projectId);
    if (!project) throw new ChatError('Project not found', 404);
    if (input.autopilot === true && input.kind === 'direct') {
      throw new ChatError('Un pedido directo no admite piloto automático', 400);
    }
    if (input.autopilot === true && input.kind === 'idea') {
      throw new ChatError('Una idea no arranca con piloto: se prende al aprobar el plan', 400);
    }
    // A clone still running (or failed) means an incomplete repo: no worktree, no chat.
    if (project.status !== 'ready') {
      throw new ChatError(`El proyecto todavía no está listo: ${project.status}`, 409);
    }
    // Without Kyro in the repo the scope and work flows have nothing to run on.
    if (input.kind !== 'direct' && !project.hasKyro) {
      throw new ChatError(
        'El proyecto no tiene Kyro: solo admite pedidos directos. Inicializá Kyro para usar scope, work e idea.',
        409,
      );
    }
    try {
      validateSlug(input.slug);
    } catch (error) {
      throw new ChatError(error instanceof Error ? error.message : 'Invalid slug', 400);
    }
    if (chats.list().some((c) => c.projectId === project.id && c.slug === input.slug)) {
      throw new ChatError(`A chat with slug "${input.slug}" already exists in this project`, 409);
    }

    // Override > project > default, resolved now so later project changes do not move this chat.
    // Validated before any worktree exists, so a bad model creates nothing.
    let models;
    try {
      models = validateModels(
        project.models.provider,
        input.models?.thinker ?? project.models.thinker,
        input.models?.executor ?? project.models.executor,
      );
    } catch (error) {
      if (error instanceof InvalidModelError) throw new ChatError(error.message, 400);
      throw error;
    }

    // Fail before touching git during a Kyro update or when there is no room; startTurn re-checks after the awaits below.
    if (manager.inMaintenance) throw new ChatError(new MaintenanceError().message, 409);
    if (!manager.hasCapacity()) throw new ChatError('Too many sessions are running', 409);

    const buffered: { type: string; payload: Record<string, unknown> }[] = [];
    let worktree;
    try {
      worktree = await createWorktree(project, input.slug, worktreesDir, (type, payload) =>
        buffered.push({ type, payload }),
      );
    } catch (error) {
      if (error instanceof WorktreeError) throw new ChatError(error.message, 422);
      throw error;
    }

    try {
      await this.writeEnv(project.id, worktree.path, buffered);
      const chat = chats.create({
        projectId: project.id,
        kind: input.kind,
        slug: input.slug,
        title: titleFrom(input.prompt, input.slug),
        worktreePath: worktree.path,
        branch: worktree.branch,
        status: 'idle',
        models,
      });
      try {
        if (input.autopilot === true) this.deps.autopilot?.create(chat.id);
        for (const event of buffered) chats.appendEvent(chat.id, event.type, event.payload);
        this.deps.tracker?.created(
          chat,
          buffered.map((event) => event.payload),
        );
        // Provisional role rule until the pilot picks one per step: the first turn of a scope or
        // work (init or plan) thinks, everything else executes.
        const initial = buildInitialPrompt(input.kind, input.prompt);
        if (input.autopilot === true) {
          // The pilot's first turn is a planning session: it runs under the same policy as the rest.
          this.startTurn(chat.id, `${initial}\n\n${buildPolicy('plan')}`, 'thinker', {
            step: 'plan',
            policyVersion: POLICY_VERSION,
            sprintN: null,
          });
        } else if (input.kind === 'idea') {
          this.startTurn(chat.id, `${initial}\n\n${buildPolicy('idea')}`, 'thinker');
        } else {
          this.startTurn(chat.id, initial, input.kind === 'direct' ? 'executor' : 'thinker');
        }
      } catch (error) {
        chats.delete(chat.id);
        throw error;
      }
      if (input.autopilot === true) this.deps.onAutopilotStart?.(chat.id);
      return chats.findById(chat.id) ?? chat;
    } catch (error) {
      // Nothing may outlive a failed create: drop the worktree and branch too.
      await removeWorktree(project.repoPath, worktree.path, worktree.branch);
      throw error;
    }
  }

  /**
   * After setup (it may create the folders, e.g. child repos): the agent never starts without its
   * .env files, so any failure, an unreadable file included, aborts the create. Events carry paths only.
   */
  private async writeEnv(
    projectId: number,
    worktreePath: string,
    buffered: { type: string; payload: Record<string, unknown> }[],
  ): Promise<void> {
    const files = this.deps.envFiles.readAll(projectId);
    if (files.length === 0) return;
    try {
      await writeEnvFiles(worktreePath, files);
    } catch (error) {
      if (error instanceof EnvFileError) throw new ChatError(error.message, 422);
      throw error;
    }
    buffered.push({
      type: 'worktree_output',
      payload: { step: 'env', paths: files.map((file) => file.path) },
    });
  }

  sendMessage(chatId: number, text: string): void {
    this.requireChat(chatId);
    this.startTurn(chatId, text);
  }

  cancel(chatId: number): void {
    this.requireChat(chatId);
    if (!this.deps.manager.cancel(chatId)) throw new ChatError('Chat is not running', 409);
  }

  /** Every question the agent of this chat asked, oldest first, answered or not. */
  listQuestions(chatId: number): PendingQuestion[] {
    this.requireChat(chatId);
    return this.deps.questions.listByChat(chatId);
  }

  /**
   * Gives the user's answer to a question of this chat. 404 when the question does not exist or
   * belongs to another chat, 409 when it is already answered or cancelled, 400 when the answer does
   * not match the options.
   */
  answerQuestion(
    chatId: number,
    questionId: number,
    answer: unknown,
    answeredBy: number,
  ): PendingQuestion {
    this.requireChat(chatId);
    const question = this.deps.questions.get(questionId);
    if (question?.chatId !== chatId) throw new ChatError('Question not found', 404);
    try {
      return this.deps.manager.answerQuestion(questionId, answer, answeredBy);
    } catch (error) {
      if (error instanceof QuestionNotFoundError) throw new ChatError('Question not found', 404);
      if (error instanceof QuestionNotPendingError) throw new ChatError(error.message, 409);
      if (error instanceof QuestionAnswerError) throw new ChatError(error.message, 400);
      throw error;
    }
  }

  requireChat(chatId: number): Chat {
    const chat = this.deps.chats.findById(chatId);
    if (!chat) throw new ChatError('Chat not found', 404);
    return chat;
  }

  private startTurn(
    chatId: number,
    text: string,
    role: ModelRole = 'executor',
    pilot?: PilotTurn,
  ): void {
    try {
      this.deps.manager.start(chatId, text, { role, ...(pilot ? { pilot } : {}) });
    } catch (error) {
      if (
        error instanceof AlreadyRunningError ||
        error instanceof SessionLimitError ||
        error instanceof MaintenanceError
      ) {
        throw new ChatError(error.message, 409);
      }
      throw error;
    }
  }
}
