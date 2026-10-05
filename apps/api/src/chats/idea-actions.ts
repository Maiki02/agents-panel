import type { Chat, IdeaAction, WorktreeStateId } from '@agents-panel/shared';
import { AlreadyRunningError, MaintenanceError, SessionLimitError } from '../agent/manager.js';
import type { AgentManager } from '../agent/manager.js';
import { execRunner, type CommandRunner } from '../kyro/reader.js';
import { POLICY_VERSION } from '../pilot/policy.js';
import type { AutopilotRunRepository } from '../pilot/runs-repo.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';
import type { ChatRepository } from './repo.js';
import type { IdeaScanner } from './idea.js';
import { ChatError } from './service.js';

export const KYRO_WORK_CREATE_TIMEOUT_MS = 60_000;

export interface IdeaActionsDeps {
  chats: ChatRepository;
  states: WorktreeStateRepository;
  manager: AgentManager;
  runs: AutopilotRunRepository;
  scanner: IdeaScanner;
  /** Name of a user, for `kyro work create --by`. */
  usernameOf: (userId: number) => string | undefined;
  /** Switches the pilot on for a chat whose run was just created. */
  onApproved: (chatId: number) => void;
  run?: CommandRunner;
}

const WAITING: WorktreeStateId = 'esperando_aprobacion_plan';

/**
 * What the user decides about the plan of an idea (R17): approve it as a scope or as a work, or
 * ask for changes. Every decision is a Timeline entry with actor `user`, who took it and the path
 * of the plan.
 */
export class IdeaActions {
  private readonly busy = new Set<number>();

  constructor(private readonly deps: IdeaActionsDeps) {}

  async apply(
    chatId: number,
    userId: number,
    input: { action: IdeaAction; text?: string | undefined },
  ): Promise<{ ok: true; kind: Chat['kind'] }> {
    const { chats, states } = this.deps;
    const chat = chats.findById(chatId);
    if (!chat) throw new ChatError('Chat not found', 404);
    if (chat.kind !== 'idea') throw new ChatError('El trabajo no es una idea', 404);
    const text = input.text?.trim() ?? '';
    if (input.action === 'request_changes' && text === '') {
      throw new ChatError('Pedir cambios necesita un texto', 400);
    }
    if (states.get(chatId)?.state !== WAITING) {
      throw new ChatError('El plan no está esperando aprobación', 409);
    }
    // One decision at a time: a double click must not run `kyro work create` twice.
    if (this.busy.has(chatId)) throw new ChatError('Ya hay una decisión en curso', 409);
    this.busy.add(chatId);
    try {
      const documents = await this.deps.scanner.scan(chat).catch(() => []);
      const path = documents.length === 1 ? documents[0] : undefined;
      if (path === undefined) {
        throw new ChatError('No hay exactamente un documento de idea para aprobar', 409);
      }
      if (input.action === 'request_changes') return this.requestChanges(chat, userId, path, text);
      return await this.approve(chat, userId, path, input.action);
    } finally {
      this.busy.delete(chatId);
    }
  }

  private decision(chat: Chat, userId: number, path: string, action: IdeaAction) {
    return {
      action,
      path,
      userId,
      username: this.deps.usernameOf(userId) ?? null,
      chatId: chat.id,
    };
  }

  private requestChanges(
    chat: Chat,
    userId: number,
    path: string,
    text: string,
  ): { ok: true; kind: Chat['kind'] } {
    const { states, manager } = this.deps;
    const current = states.get(chat.id);
    states.transition(chat.id, {
      state: 'madurando_idea',
      actor: 'user',
      reason: 'Pidió cambios al plan',
      detail: path,
      data: this.decision(chat, userId, path, 'request_changes'),
      role: current?.role ?? null,
      model: current?.model ?? null,
    });
    try {
      manager.start(chat.id, text, { role: 'thinker' });
    } catch (error) {
      // Nothing was sent: the plan keeps waiting for a decision.
      states.transition(chat.id, {
        state: WAITING,
        actor: 'system',
        reason: 'No se pudo enviar el pedido de cambios',
        detail: path,
        role: current?.role ?? null,
        model: current?.model ?? null,
      });
      if (
        error instanceof AlreadyRunningError ||
        error instanceof SessionLimitError ||
        error instanceof MaintenanceError
      ) {
        throw new ChatError(error.message, 409);
      }
      throw error;
    }
    return { ok: true, kind: 'idea' };
  }

  private async approve(
    chat: Chat,
    userId: number,
    path: string,
    action: 'approve_scope' | 'approve_work',
  ): Promise<{ ok: true; kind: Chat['kind'] }> {
    const { chats, states, runs, manager } = this.deps;
    if (manager.inMaintenance) throw new ChatError(new MaintenanceError().message, 409);
    if (runs.get(chat.id)) throw new ChatError('El trabajo ya tiene piloto', 409);
    const current = states.get(chat.id);
    const keep = { role: current?.role ?? null, model: current?.model ?? null };

    if (action === 'approve_work') {
      // Kyro creates the work from the idea; if it refuses, the chat stays an idea.
      try {
        await (this.deps.run ?? execRunner)(
          'kyro',
          [
            'work',
            'create',
            '--id',
            chat.slug,
            '--from',
            path,
            '--by',
            this.deps.usernameOf(userId) ?? `user-${String(userId)}`,
            '--json',
          ],
          { cwd: chat.worktreePath, timeoutMs: KYRO_WORK_CREATE_TIMEOUT_MS },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'kyro work create falló';
        states.transition(chat.id, {
          state: 'bloqueado',
          actor: 'system',
          reason: 'Kyro no pudo crear el work',
          detail: `kyro work create falló: ${message}`.slice(0, 500),
          blockedReason: 'kyro_bloqueado',
          data: this.decision(chat, userId, path, action),
          ...keep,
        });
        throw new ChatError(`Kyro no pudo crear el work: ${message}`.slice(0, 500), 422);
      }
    }

    const kind = action === 'approve_work' ? 'work' : 'scope';
    chats.setKind(chat.id, kind);
    runs.create(chat.id, POLICY_VERSION, action === 'approve_scope' ? path : null);
    states.transition(chat.id, {
      state: 'planificando',
      actor: 'user',
      reason: kind === 'work' ? 'Aprobó el plan como work' : 'Aprobó el plan como scope',
      detail: path,
      data: this.decision(chat, userId, path, action),
      ...keep,
    });
    this.deps.onApproved(chat.id);
    return { ok: true, kind };
  }
}
