import type { FastifyInstance } from 'fastify';
import type { AutopilotAction, AutopilotInfo } from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { ChatError, type ChatService } from '../chats/service.js';
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
  properties: { action: { enum: ['pause', 'resume', 'off'] } },
} as const;

/**
 * Autopilot of a scope or work. Every route needs a session (and CSRF when it writes) through the
 * global guard; the public allowlist does not change. A direct chat has no autopilot: 404.
 */
export function registerAutopilotRoutes(
  app: FastifyInstance,
  deps: { service: ChatService; runs: AutopilotRunRepository; maxSessionsPerSprint: number },
): void {
  const { service, runs, maxSessionsPerSprint } = deps;

  const info = (chatId: number): AutopilotInfo => ({
    run: runs.get(chatId) ?? null,
    maxSessionsPerSprint,
  });
  const requirePilotable = (chatId: number): void => {
    if (service.requireChat(chatId).kind === 'direct') {
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

  app.post<{ Params: { id: number }; Body: { action: AutopilotAction } }>(
    '/api/chats/:id/autopilot',
    {
      schema: { params: idParams, body: actionBody },
      preValidation: onlyKeys(Object.keys(actionBody.properties)),
    },
    (request) => {
      const chatId = request.params.id;
      requirePilotable(chatId);
      try {
        if (request.body.action === 'pause') runs.pause(chatId);
        else if (request.body.action === 'resume') runs.resume(chatId);
        else runs.turnOff(chatId);
      } catch (error) {
        if (error instanceof AutopilotTransitionError) throw new ChatError(error.message, 409);
        throw error;
      }
      return info(chatId);
    },
  );
}
