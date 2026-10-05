import type { Chat, ChatStatus, ModelRole, WorktreeStateId } from '@agents-panel/shared';
import { mapKyroState } from '../kyro/map-state.js';
import type { KyroReadResult } from '../kyro/reader.js';
import type { KyroScopeState, KyroWorkState } from '../kyro/state.js';
import type { WorktreeStateRepository } from './state-repo.js';

/** The part of KyroReader the tracker needs; tests inject a fake backed by fixtures. */
export interface KyroStateReader {
  readScope(cwd: string): Promise<KyroReadResult<KyroScopeState>>;
  readWork(cwd: string, work?: string): Promise<KyroReadResult<KyroWorkState>>;
}

export interface TurnInfo {
  role: ModelRole;
  model: string;
}

/** What AgentManager tells the outside world about a turn; it must never break the turn. */
export interface TurnObserver {
  turnStarted(chat: Chat, turn: TurnInfo): void;
  turnFinished(chat: Chat, turn: TurnInfo, result: ChatStatus): Promise<void>;
  questionAsked(chat: Chat): void;
  questionAnswered(chat: Chat): void;
}

/** After these the user resumed the work by sending a message: the agent is moving again. */
const STOPPED: readonly WorktreeStateId[] = ['interrumpido', 'error'];
/** Waits for a question or a permission: a restart cancels them, so a resume never goes back to one. */
const QUESTION_WAITS: readonly WorktreeStateId[] = ['esperando_respuesta', 'esperando_permiso'];
/** The state before the first turn of a scope or work. */
const PREPARING: readonly WorktreeStateId[] = [
  'en_cola',
  'creando_worktree',
  'instalando_dependencias',
];

/**
 * Keeps `worktree_state` in step with what happens to a chat: creation, each turn, questions and
 * restarts. The state after a turn comes from the Kyro CLI only (R4, R7). Direct chats have none.
 */
export class WorktreeStateTracker implements TurnObserver {
  constructor(
    private readonly states: WorktreeStateRepository,
    private readonly reader: KyroStateReader,
  ) {}

  private static tracked(chat: Chat): boolean {
    return chat.kind !== 'direct';
  }

  /** The worktree exists and its setup (dependencies, .env) already ran. */
  created(chat: Chat, setup: unknown[] = []): void {
    if (!WorktreeStateTracker.tracked(chat)) return;
    this.states.transition(chat.id, {
      state: 'creando_worktree',
      actor: 'system',
      reason: 'Worktree creado',
      data: { branch: chat.branch },
    });
    this.states.transition(chat.id, {
      state: 'instalando_dependencias',
      actor: 'system',
      reason: 'Setup del proyecto',
      data: { steps: setup },
    });
  }

  turnStarted(chat: Chat, turn: TurnInfo): void {
    if (!WorktreeStateTracker.tracked(chat)) return;
    const current = this.states.get(chat.id);
    const common = { role: turn.role, model: turn.model };
    if (current === undefined || PREPARING.includes(current.state)) {
      this.states.transition(chat.id, {
        state: 'planificando',
        actor: 'agent',
        reason: 'Empezó el primer turno',
        ...common,
      });
    } else if (STOPPED.includes(current.state)) {
      this.states.transition(chat.id, {
        state: this.resumeState(chat, current.previousState),
        actor: 'user',
        reason: 'Retomó el trabajo con un mensaje',
        ...common,
      });
    } else {
      // Same state: only the role and model of the running session change.
      this.states.transition(chat.id, { ...this.keep(current), actor: 'agent', ...common });
    }
  }

  /** The state a stopped work goes back to: the one before the question it was waiting on, if any. */
  private resumeState(chat: Chat, previous: WorktreeStateId | null): WorktreeStateId {
    let state = previous;
    if (state !== null && QUESTION_WAITS.includes(state)) {
      const entry = this.states
        .timeline(chat.id)
        .reverse()
        .find((transition) => transition.toState === state);
      state = entry?.fromState ?? null;
    }
    return state === null || QUESTION_WAITS.includes(state) ? 'planificando' : state;
  }

  /** Reads Kyro after the turn: the next state is whatever the CLI reports. */
  async turnFinished(chat: Chat, turn: TurnInfo, result: ChatStatus): Promise<void> {
    if (!WorktreeStateTracker.tracked(chat)) return;
    const common = { role: turn.role, model: turn.model };
    // A cancelled turn leaves the work where it was; the user decides what comes next.
    if (result === 'cancelled') return;
    if (result === 'error') {
      this.states.transition(chat.id, {
        state: 'error',
        actor: 'system',
        reason: 'La sesión terminó con error',
        detail: 'La sesión del agente terminó con error',
        ...common,
      });
      return;
    }
    const read =
      chat.kind === 'scope'
        ? await this.reader.readScope(chat.worktreePath)
        : await this.reader.readWork(chat.worktreePath);
    if (!read.ok) {
      this.states.transition(chat.id, {
        state: 'error',
        actor: 'system',
        reason: 'No se pudo leer el estado de Kyro',
        detail: read.error.message,
        data: { kind: read.error.kind },
        ...common,
      });
      return;
    }
    const mapped = mapKyroState(read.state);
    this.states.transition(chat.id, {
      state: mapped.state,
      actor: 'agent',
      reason: `Kyro: ${read.state.nextAction}`,
      detail: mapped.detail,
      phase: mapped.phase,
      sprintCurrent: mapped.sprintCurrent,
      sprintClosed: mapped.sprintClosed,
      sprintTotal: mapped.sprintTotal,
      taskDone: mapped.taskDone,
      taskTotal: mapped.taskTotal,
      openDebt: mapped.openDebt,
      blockedReason: mapped.blockedReason,
      // No pilot yet: when the turn ends the next move is the user's.
      data: {
        nextAction: read.state.nextAction,
        nextTaskId: read.state.nextTaskId,
        waitingOn: 'user',
      },
      ...common,
    });
  }

  questionAsked(chat: Chat): void {
    if (!WorktreeStateTracker.tracked(chat)) return;
    const current = this.states.get(chat.id);
    // Without a state yet there is nothing to come back to; a second question keeps the first one's.
    if (current === undefined || current.state === 'esperando_respuesta') return;
    this.states.transition(chat.id, {
      state: 'esperando_respuesta',
      actor: 'agent',
      reason: 'El agente hizo una pregunta',
      role: current.role,
      model: current.model,
    });
  }

  questionAnswered(chat: Chat): void {
    if (!WorktreeStateTracker.tracked(chat)) return;
    const current = this.states.get(chat.id);
    if (current?.state !== 'esperando_respuesta' || current.previousState === null) return;
    this.states.transition(chat.id, {
      state: current.previousState,
      actor: 'user',
      reason: 'Respondió la pregunta',
      role: current.role,
      model: current.model,
    });
  }

  /** On startup: every tracked work whose turn was running is now interrupted. */
  markInterrupted(chats: Chat[]): void {
    for (const chat of chats) {
      if (!WorktreeStateTracker.tracked(chat)) continue;
      const current = this.states.get(chat.id);
      this.states.transition(chat.id, {
        state: 'interrumpido',
        actor: 'system',
        reason: 'El panel se reinició con la sesión en curso',
        role: current?.role ?? null,
        model: current?.model ?? null,
      });
    }
  }

  /** Same state, progress and detail as the stored row. */
  private keep(current: NonNullable<ReturnType<WorktreeStateRepository['get']>>) {
    return {
      state: current.state,
      detail: current.detail,
      phase: current.phase,
      sprintCurrent: current.sprintCurrent,
      sprintClosed: current.sprintClosed,
      sprintTotal: current.sprintTotal,
      taskDone: current.taskDone,
      taskTotal: current.taskTotal,
      openDebt: current.openDebt,
      blockedReason: current.blockedReason,
    };
  }
}
