import type { FastifyInstance } from 'fastify';
import type { AutopilotAction, AutopilotInfo } from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { ChatError, type ChatService } from '../chats/service.js';
import type { DebtAcceptance } from './accept-debt.js';
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
    action: { enum: ['pause', 'resume', 'off', 'accept_debt'] },
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
  },
): void {
  const { service, runs, maxSessionsPerSprint, onResume, debt } = deps;

  const info = (chatId: number): AutopilotInfo => ({
    run: runs.get(chatId) ?? null,
    maxSessionsPerSprint,
  });
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

  app.post<{ Params: { id: number }; Body: { action: AutopilotAction; reason?: string } }>(
    '/api/chats/:id/autopilot',
    {
      schema: { params: idParams, body: actionBody },
      preValidation: onlyKeys(Object.keys(actionBody.properties)),
    },
    async (request) => {
      const chatId = request.params.id;
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
