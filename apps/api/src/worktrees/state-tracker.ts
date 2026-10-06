import type {
  AutopilotStep,
  BlockedReason,
  Chat,
  ChatStatus,
  ModelRole,
  WorktreeStateId,
} from '@agents-panel/shared';
import { mapKyroState } from '../kyro/map-state.js';
import type { KyroReadResult } from '../kyro/reader.js';
import type { KyroScopeState, KyroWorkState } from '../kyro/state.js';
import type { IdeaScanner } from '../chats/idea.js';
import type { QuestionRepository } from '../chats/questions-repo.js';
import type { WorktreeStateRepository } from './state-repo.js';

/** The part of KyroReader the tracker needs; tests inject a fake backed by fixtures. */
export interface KyroStateReader {
  /** `preferred` is the chat's slug: the scope named like it wins over `local.json`. */
  readScope(cwd: string, preferred?: string): Promise<KyroReadResult<KyroScopeState>>;
  /** `hints` narrow the works of the worktree to the chat's own (see KyroReader.readWork). */
  readWork(
    cwd: string,
    work?: string,
    hints?: { preferred?: string; since?: number },
  ): Promise<KyroReadResult<KyroWorkState>>;
}

export interface TurnInfo {
  role: ModelRole;
  model: string;
  /** Present when the pilot opened the turn: its transitions are the pilot's, not the agent's. */
  pilot?: { step: AutopilotStep; policyVersion: number };
}

/** What AgentManager tells the outside world about a turn; it must never break the turn. */
export interface TurnObserver {
  turnStarted(chat: Chat, turn: TurnInfo): void;
  turnFinished(chat: Chat, turn: TurnInfo, result: ChatStatus): Promise<void>;
  questionAsked(chat: Chat): void;
  questionAnswered(chat: Chat): void;
}

/** After these the user resumed the work by sending a message: the agent is moving again. */
const STOPPED: readonly WorktreeStateId[] = [
  'interrumpido',
  'error',
  'pausado',
  'sin_cupo_de_uso',
  'bloqueado',
];
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
    /** Finds the document of an idea chat in git; without it an idea stays in madurando_idea. */
    private readonly ideas?: IdeaScanner,
    private readonly questions?: QuestionRepository,
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
    const actor = turn.pilot ? 'pilot' : 'agent';
    const data = turn.pilot ? { ...turn.pilot } : undefined;
    if (current === undefined || PREPARING.includes(current.state)) {
      // An idea is matured by the user's own request: the first turn is theirs, not the agent's.
      this.states.transition(chat.id, {
        state: chat.kind === 'idea' ? 'madurando_idea' : 'planificando',
        actor: chat.kind === 'idea' ? 'user' : actor,
        ...(data ? { data } : {}),
        reason: chat.kind === 'idea' ? 'Empezó la idea' : 'Empezó el primer turno',
        ...common,
      });
    } else if (
      chat.kind === 'idea' &&
      (current.state === 'esperando_aprobacion_plan' || current.state === 'bloqueado')
    ) {
      // The user keeps talking to the idea: the plan is not ready to approve anymore.
      this.states.transition(chat.id, {
        state: 'madurando_idea',
        actor: 'user',
        reason: 'Siguió madurando la idea con un mensaje',
        ...common,
      });
    } else if (STOPPED.includes(current.state)) {
      this.states.transition(chat.id, {
        state: this.resumeState(chat, current.previousState),
        actor: turn.pilot ? 'pilot' : 'user',
        ...(data ? { data } : {}),
        reason: turn.pilot ? 'El piloto retomó el trabajo' : 'Retomó el trabajo con un mensaje',
        ...common,
      });
    } else {
      // Same state: only the role and model of the running session change.
      this.states.transition(chat.id, {
        ...this.keep(current),
        actor,
        ...(data ? { data } : {}),
        ...common,
      });
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
    if (state === null || QUESTION_WAITS.includes(state)) {
      return chat.kind === 'idea' ? 'madurando_idea' : 'planificando';
    }
    return state;
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
    if (chat.kind === 'idea') {
      await this.ideaFinished(chat, common);
      return;
    }
    const read =
      chat.kind === 'scope'
        ? await this.reader.readScope(chat.worktreePath, chat.slug)
        : await this.reader.readWork(chat.worktreePath, undefined, {
            preferred: chat.slug,
            since: chat.createdAt,
          });
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
      actor: turn.pilot ? 'pilot' : 'agent',
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
      // Without the pilot the next move is the user's; with it, the pilot decides.
      data: {
        nextAction: read.state.nextAction,
        nextTaskId: read.state.nextTaskId,
        waitingOn: turn.pilot ? 'pilot' : 'user',
        ...turn.pilot,
      },
      ...common,
    });
  }

  /**
   * An idea has no scope or work in Kyro yet, so git is the signal: exactly one new or changed
   * document means the plan is written and waits for the user's approval.
   */
  private async ideaFinished(
    chat: Chat,
    common: { role: TurnInfo['role']; model: string },
  ): Promise<void> {
    // A question nobody answered keeps the work waiting for it, whatever the files say. The
    // manager cancels the stored questions when the turn ends, so the state is the signal too.
    if (
      this.states.get(chat.id)?.state === 'esperando_respuesta' ||
      this.questions?.listByChat(chat.id, 'pending').length
    ) {
      return;
    }
    const documents = await (this.ideas?.scan(chat) ?? Promise.resolve([])).catch(() => []);
    if (documents.length === 1) {
      const [file] = documents;
      this.states.transition(chat.id, {
        state: 'esperando_aprobacion_plan',
        actor: 'agent',
        reason: 'La idea quedó escrita: espera la aprobación del plan',
        detail: file ?? null,
        data: { path: file, waitingOn: 'user' },
        ...common,
      });
    } else if (documents.length > 1) {
      this.states.transition(chat.id, {
        state: 'bloqueado',
        actor: 'agent',
        reason: 'Hay más de un documento de idea',
        detail: `Hay ${String(documents.length)} documentos de idea y tiene que haber uno: ${documents.join(', ')}`,
        blockedReason: 'otro',
        data: { documents, waitingOn: 'user' },
        ...common,
      });
    } else {
      this.states.transition(chat.id, {
        state: 'madurando_idea',
        actor: 'agent',
        reason: 'El turno de la idea terminó sin documento',
        data: { waitingOn: 'user' },
        ...common,
      });
    }
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

  /**
   * The pilot's own transitions (it stopped, waits for a free session or for the usage limit):
   * same progress as the stored row, actor `pilot`, and the reason for the Timeline.
   */
  pilotMark(
    chat: Chat,
    mark: {
      state: WorktreeStateId;
      reason: string;
      detail?: string | null;
      blockedReason?: BlockedReason | null;
      data?: Record<string, unknown>;
      /** Keeps a Timeline entry even if the state does not change. */
      record?: boolean;
    },
  ): void {
    if (!WorktreeStateTracker.tracked(chat)) return;
    const current = this.states.get(chat.id);
    this.states.transition(chat.id, {
      ...(current ? this.keep(current) : {}),
      ...(mark.record ? { record: true } : {}),
      state: mark.state,
      actor: 'pilot',
      reason: mark.reason,
      detail: mark.detail ?? null,
      blockedReason: mark.blockedReason ?? null,
      ...(mark.data ? { data: mark.data } : {}),
      role: current?.role ?? null,
      model: current?.model ?? null,
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
