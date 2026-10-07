import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  MANUAL_STEPS,
  type Chat,
  type ManualStep,
  type StepOutcome,
  type StepRequest,
} from '@agents-panel/shared';
import {
  AlreadyRunningError,
  MaintenanceError,
  SessionLimitError,
  type AgentManager,
} from '../agent/manager.js';
import { onlyKeys } from '../http/only-keys.js';
import type { KyroReadResult } from '../kyro/reader.js';
import type { KyroScopeState, KyroTaskContext, KyroWorkState } from '../kyro/state.js';
import type { PilotKyro } from '../pilot/autopilot.js';
import {
  MERGE_DEV_SKILL,
  afterAnalyze,
  buildMergeDevPrompt,
  buildStepPrompt,
  stepRole,
  type PromptStep,
} from '../pilot/prompts.js';
import type { ProjectRepository } from '../projects/repo.js';
import { WorktreeOpsError, type WorktreeOps } from '../worktrees/ops.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const stepBody = {
  type: 'object',
  required: ['step'],
  additionalProperties: false,
  properties: { step: { type: 'string', enum: [...MANUAL_STEPS] } },
} as const;

export interface StepServiceDeps {
  chats: { findById(id: number): Chat | undefined };
  projects: Pick<ProjectRepository, 'findById'>;
  manager: Pick<AgentManager, 'start'>;
  kyro: Pick<
    PilotKyro,
    | 'readScope'
    | 'readWork'
    | 'contextPackTask'
    | 'workContextPack'
    | 'analyze'
    | 'completeScope'
    | 'closeWork'
  >;
  /** The action service: guards of the `user` actor, Timeline entries and the Kyro commit. */
  ops: Pick<WorktreeOps, 'assertIdle' | 'markStep' | 'commitKyro'>;
  states: Pick<WorktreeStateRepository, 'get'>;
}

function fail(message: string, status: 400 | 404 | 409 | 422 = 409): never {
  throw new WorktreeOpsError(message, status);
}

/**
 * The manual version of the steps the pilot runs (D26): the same prompt, the same role and the same
 * verbs, asked for by a person. Nothing here decides what comes next: the pilot has to be paused and
 * the agent idle (the guards of the `user` actor), and each request leaves a Timeline entry.
 */
export class StepService {
  constructor(private readonly deps: StepServiceDeps) {}

  async run(chatId: number, step: ManualStep): Promise<StepOutcome> {
    const chat = this.deps.chats.findById(chatId);
    if (!chat?.worktreePath) fail('El chat no tiene worktree', 404);
    if (chat.kind !== 'scope' && chat.kind !== 'work') {
      fail('Los pasos del agente solo existen en un scope o un work', 409);
    }
    if (this.deps.states.get(chatId)?.state === 'archivado') {
      fail('El trabajo está archivado: es de solo lectura', 409);
    }
    this.deps.ops.assertIdle(chatId);

    const state = await this.readState(chat);
    switch (step) {
      case 'plan':
      case 'execute':
      case 'fix':
      case 'close':
        return this.launch(chat, state, step, step, []);
      case 'qa':
        return this.qa(chat, state);
      case 'merge_dev':
        return this.mergeDev(chat, state);
      case 'complete':
        return this.complete(chat, state);
    }
  }

  private async readState(chat: Chat): Promise<KyroScopeState | KyroWorkState> {
    const { kyro } = this.deps;
    const read =
      chat.kind === 'scope'
        ? await kyro.readScope(chat.worktreePath, chat.slug)
        : await kyro.readWork(chat.worktreePath, undefined, {
            preferred: chat.slug,
            since: chat.createdAt,
          });
    if (!read.ok) fail(`Kyro no pudo leer el trabajo: ${read.error.message}`);
    return read.state;
  }

  private taskContext(
    chat: Chat,
    state: KyroScopeState | KyroWorkState,
  ): Promise<KyroReadResult<KyroTaskContext>> {
    return state.kind === 'scope'
      ? this.deps.kyro.contextPackTask(chat.worktreePath, state.scope)
      : this.deps.kyro.workContextPack(chat.worktreePath, state.work);
  }

  /** Opens the session of `step` with the prompt the pilot would build for it. */
  private async launch(
    chat: Chat,
    state: KyroScopeState | KyroWorkState,
    requested: ManualStep,
    step: PromptStep,
    findings: string[],
  ): Promise<StepOutcome> {
    const task = await this.taskContext(chat, state);
    if (!task.ok) fail(`Kyro no pudo leer la tarea: ${task.error.message}`);
    const prompt = buildStepPrompt(step, { task: task.state, findings });
    this.start(chat, prompt, step);
    this.deps.ops.markStep(chat.id, requested, 'user', step === requested ? undefined : step);
    return { step: requested, launched: step, ...(findings.length > 0 ? { findings } : {}) };
  }

  private async qa(chat: Chat, state: KyroScopeState | KyroWorkState): Promise<StepOutcome> {
    if (state.kind !== 'scope') fail('El QA con kyro analyze solo existe en un scope', 409);
    const analysis = await this.deps.kyro.analyze(chat.worktreePath, state.scope);
    if (!analysis.ok) fail(`kyro analyze falló: ${analysis.error.message}`);
    const next = afterAnalyze(analysis.state);
    return this.launch(chat, state, 'qa', next.step, next.findings);
  }

  private async mergeDev(chat: Chat, state: KyroScopeState | KyroWorkState): Promise<StepOutcome> {
    try {
      await access(join(chat.worktreePath, MERGE_DEV_SKILL));
    } catch {
      fail('El proyecto no trae la skill merge-dev (.claude/skills/merge-dev/SKILL.md)');
    }
    const project = this.deps.projects.findById(chat.projectId);
    if (!project) fail('Project not found', 404);
    const name = state.kind === 'scope' ? state.scope : state.work;
    const prompt = buildMergeDevPrompt({
      worktree: chat.worktreePath,
      base: project.baseBranch,
      name,
    });
    this.start(chat, prompt, 'merge_dev');
    this.deps.ops.markStep(chat.id, 'merge_dev', 'user');
    return { step: 'merge_dev', launched: 'merge_dev' };
  }

  /** The Kyro verb that completes a scope or closes a work, and the commit of what it wrote. */
  private async complete(chat: Chat, state: KyroScopeState | KyroWorkState): Promise<StepOutcome> {
    const { kyro, ops } = this.deps;
    const done =
      state.kind === 'scope'
        ? await kyro.completeScope(chat.worktreePath, state.scope)
        : await kyro.closeWork(
            chat.worktreePath,
            state.work,
            state.revision,
            'Trabajo completado desde el panel',
          );
    if (!done.ok) fail(`Kyro no pudo cerrar el trabajo: ${done.error.message}`, 422);
    const text =
      state.kind === 'scope'
        ? `chore(kyro): completar scope ${state.scope}`
        : `chore(kyro): cerrar work ${state.work}`;
    const commit = await ops.commitKyro(chat.id, text, 'user');
    ops.markStep(chat.id, 'complete', 'user', commit.output);
    if (commit.result !== 'ok')
      fail(`Kyro cerró el trabajo pero el commit falló: ${commit.output}`, 422);
    return { step: 'complete', launched: null, output: commit.output };
  }

  private start(chat: Chat, prompt: string, step: PromptStep | 'merge_dev'): void {
    try {
      // A manual turn: no `pilot` option, so the agent (not the pilot) owns its Timeline entries.
      this.deps.manager.start(chat.id, prompt, {
        role: step === 'merge_dev' ? 'executor' : stepRole(step),
        freshSession: true,
      });
    } catch (error) {
      if (
        error instanceof AlreadyRunningError ||
        error instanceof SessionLimitError ||
        error instanceof MaintenanceError
      ) {
        fail(error.message, 409);
      }
      throw error;
    }
  }
}

/** POST /api/chats/:id/steps (D26): session and CSRF through the global guard. */
export function registerStepRoutes(app: FastifyInstance, deps: { steps: StepService }): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorktreeOpsError) {
      return reply.code(error.status).send({ error: error.message });
    }
    return reply.send(error);
  });

  app.post<{ Params: { id: number }; Body: StepRequest }>(
    '/api/chats/:id/steps',
    { schema: { params: idParams, body: stepBody }, preValidation: onlyKeys(['step']) },
    (request) => deps.steps.run(request.params.id, request.body.step),
  );
}
