import type { FastifyInstance } from 'fastify';
import type { AutopilotAction, AutopilotInfo } from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { ChatError, type ChatService } from '../chats/service.js';
import type { DebtAcceptance } from './accept-debt.js';
import type { PrLookup } from './pr-lookup.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';
import { AutopilotTransitionError, type AutopilotRunRepository } from './runs-repo.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const actionBody = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { enum: ['on', 'pause', 'resume', 'off', 'accept_debt'] },
    reason: { type: 'string', maxLength: 2000 },
  },
} as const;

/**
 * Autopilot of a scope or work. Every route needs a session (and CSRF when it writes) through the
 * global guard; the public allowlist does not change. A direct chat has no autopilot: 404.
 */
export function registerAutopilotRoutes(
  app: FastifyInstance,
  deps: {
    service: ChatService;
    runs: AutopilotRunRepository;
    maxSessionsPerSprint: number;
    /** The pilot picks the work up again after a resume. */
    onResume?: (chatId: number) => void;
    /** Completes a scope with the debt the user accepted (T3.2). */
    debt?: DebtAcceptance;
    /** Timeline of the work: the user's `on` stays on record under their name. */
    states?: WorktreeStateRepository;
    /** PRs of a finished work, looked up in GitHub when the pilot kept none. */
    prs?: PrLookup;
  },
): void {
  const { service, runs, maxSessionsPerSprint, onResume, debt, states, prs } = deps;

  const info = (chatId: number): AutopilotInfo => ({
    run: runs.get(chatId) ?? null,
    maxSessionsPerSprint,
  });
  /** Why `on` does not apply, as a readable 409; returns normally when it does. */
  const requireSwitchable = (chatId: number): void => {
    const chat = service.requireChat(chatId);
    if (chat.kind === 'direct') throw new ChatError('Un pedido directo no tiene piloto', 409);
    if (chat.kind === 'idea') {
      throw new ChatError('Una idea no tiene piloto hasta que se aprueba su plan', 409);
    }
    const run = runs.get(chatId);
    if (run?.status === 'finished') {
      throw new ChatError(
        'El trabajo ya terminó: el piloto llegó al final y no queda nada que pilotear',
        409,
      );
    }
    if (run !== undefined && run.status !== 'off') {
      throw new ChatError('El piloto ya está encendido en este trabajo', 409);
    }
    const state = states?.get(chatId)?.state;
    if (run?.phase === 'merge' && (state === 'pr_lista' || state === 'mergeada')) {
      throw new ChatError('La PR ya está lista: no queda nada que pilotear', 409);
    }
  };
  const requirePilotable = (chatId: number): void => {
    const kind = service.requireChat(chatId).kind;
    if (kind === 'idea') {
      throw new ChatError('Una idea no tiene piloto hasta que se aprueba su plan', 404);
    }
    if (kind === 'direct') {
      throw new ChatError('Un pedido directo no tiene piloto', 404);
    }
  };

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/autopilot',
    { schema: { params: idParams } },
    (request) => {
      requirePilotable(request.params.id);
      return info(request.params.id);
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/pr',
    { schema: { params: idParams } },
    async (request): Promise<{ urls: string[] }> => {
      const chat = service.requireChat(request.params.id);
      if (chat.kind === 'direct' || chat.kind === 'idea' || prs === undefined) return { urls: [] };
      return { urls: await prs.urls(chat) };
    },
  );

  app.post<{ Params: { id: number }; Body: { action: AutopilotAction; reason?: string } }>(
    '/api/chats/:id/autopilot',
    {
      schema: { params: idParams, body: actionBody },
      preValidation: onlyKeys(Object.keys(actionBody.properties)),
    },
    async (request) => {
      const chatId = request.params.id;
      service.requireChat(chatId);
      service.assertWritable(chatId);
      if (request.body.action === 'on') {
        requireSwitchable(chatId);
        if (runs.get(chatId) === undefined) runs.create(chatId);
        else runs.resume(chatId);
        const current = states?.get(chatId);
        if (states !== undefined && current !== undefined) {
          states.transition(chatId, {
            state: current.state,
            actor: 'user',
            reason: 'El usuario encendió el piloto',
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
            data: { action: 'on' },
            record: true,
          });
        }
        // The loop reads Kyro's nextAction and waits for a manual turn in progress to end.
        onResume?.(chatId);
        return info(chatId);
      }
      requirePilotable(chatId);
      if (request.body.action === 'accept_debt') {
        // The guard guarantees a session; the acceptance is always the one of that session's user.
        const userId = request.session?.userId;
        if (userId === undefined || debt === undefined) throw new ChatError('Unauthorized', 404);
        await debt.accept(chatId, userId, request.body.reason);
        return info(chatId);
      }
      try {
        if (request.body.action === 'pause') runs.pause(chatId);
        else if (request.body.action === 'resume') {
          runs.resume(chatId);
          onResume?.(chatId);
        } else runs.turnOff(chatId);
      } catch (error) {
        if (error instanceof AutopilotTransitionError) throw new ChatError(error.message, 409);
        throw error;
      }
      return info(chatId);
    },
  );
}
