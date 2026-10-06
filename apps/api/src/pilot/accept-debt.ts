import { ChatError, type ChatService } from '../chats/service.js';
import type { KyroActionResult, KyroReadResult } from '../kyro/reader.js';
import type { KyroScopeState } from '../kyro/state.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';
import { realGit, type PilotGit } from './git-ops.js';
import type { AutopilotRunRepository } from './runs-repo.js';

export interface AcceptDebtDeps {
  service: ChatService;
  states: WorktreeStateRepository;
  runs: AutopilotRunRepository;
  kyro: {
    readScope(cwd: string, preferred?: string): Promise<KyroReadResult<KyroScopeState>>;
    completeScope(
      cwd: string,
      scope: string,
      acceptOpenDebt?: { reason: string },
    ): Promise<KyroActionResult>;
  };
  git?: PilotGit;
  usernameOf: (userId: number) => string | undefined;
  /** The pilot picks the work up again, now past the completion. */
  onResume: (chatId: number) => void;
}

/**
 * The user's explicit OK to complete a scope with debt still open (R20). Only the panel runs
 * `kyro scope complete --accept-open-debt`, and only after the user gave a reason; the agent's
 * policy forbids the flag.
 */
export class DebtAcceptance {
  private readonly busy = new Set<number>();

  constructor(private readonly deps: AcceptDebtDeps) {}

  async accept(chatId: number, userId: number, reason: string | undefined): Promise<void> {
    const { service, states, runs, kyro } = this.deps;
    const chat = service.requireChat(chatId);
    if (chat.kind !== 'scope')
      throw new ChatError('Solo un scope puede aceptar deuda abierta', 409);
    const why = reason?.trim() ?? '';
    if (why === '') throw new ChatError('Aceptar la deuda necesita un motivo', 400);
    const current = states.get(chatId);
    if (current?.state !== 'esperando_aprobacion_cierre') {
      throw new ChatError('El scope no está esperando aprobación de cierre', 409);
    }
    // Completing is irreversible: without a pilot run there is nothing to resume, so refuse first.
    if (runs.get(chatId) === undefined) {
      throw new ChatError('El scope no tiene piloto: no se puede completar desde acá', 409);
    }
    if (this.busy.has(chatId)) throw new ChatError('Ya hay una decisión en curso', 409);
    this.busy.add(chatId);
    try {
      const read = await kyro.readScope(chat.worktreePath, chat.slug);
      if (!read.ok) throw new ChatError(`No se pudo leer Kyro: ${read.error.message}`, 409);
      const debt = read.state.debtItems ?? [];
      const keep = { role: current.role, model: current.model };

      const done = await kyro.completeScope(chat.worktreePath, read.state.scope, { reason: why });
      if (!done.ok) {
        throw new ChatError(
          `Kyro no pudo completar el scope: ${done.error.message}`.slice(0, 500),
          422,
        );
      }
      try {
        const git = this.deps.git ?? realGit;
        await git.commitKyro(
          chat.worktreePath,
          `chore(kyro): completar scope ${read.state.scope} aceptando deuda`,
        );
        await git.push(chat.worktreePath, chat.branch);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'El commit de cierre falló';
        states.transition(chatId, {
          state: 'bloqueado',
          actor: 'system',
          reason: 'El commit o el push del cierre falló',
          detail,
          blockedReason: 'git',
          ...keep,
        });
        throw new ChatError(detail.slice(0, 500), 422);
      }
      states.transition(chatId, {
        state: 'cerrando',
        actor: 'user',
        reason: 'Aceptó la deuda abierta y completó el scope',
        detail: why,
        data: {
          action: 'accept_debt',
          userId,
          username: this.deps.usernameOf(userId) ?? null,
          reason: why,
          debt,
        },
        ...keep,
      });
      // The pilot goes on to the merge phase; the same debt is never asked about again.
      runs.setPhase(chatId, 'merge');
      if (runs.get(chatId)?.status === 'stopped') runs.resume(chatId);
      this.deps.onResume(chatId);
    } finally {
      this.busy.delete(chatId);
    }
  }
}
