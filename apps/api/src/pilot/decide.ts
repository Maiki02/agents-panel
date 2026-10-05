import type { AutopilotRun, BlockedReason, ModelRole, WorktreeStateId } from '@agents-panel/shared';
import type { KyroScopeState, KyroWorkState } from '../kyro/state.js';

/** The kind of session the pilot opens for a step (the fix and close sessions come from the quality check). */
export type PilotStep = 'plan' | 'execute';

/** What the pilot does next. It is decided from Kyro's signals only (R7). */
export type PilotDecision =
  | { kind: 'session'; step: PilotStep; role: ModelRole }
  | {
      kind: 'stop';
      state: WorktreeStateId;
      blockedReason: BlockedReason | null;
      detail: string | null;
    }
  /** The sprint's tasks are done: QA and analyze decide between fixing and closing. */
  | { kind: 'check_quality' }
  | { kind: 'finished' };

/**
 * What the pilot knows about the session that just ended. The agent's text is deliberately not
 * part of it: a phrase such as "the sprint is over" must never move the pilot to another step.
 */
export interface LastSession {
  result: 'idle' | 'error' | 'cancelled';
  /** The session ended after the user answered one of its questions. */
  answeredQuestion: boolean;
}

export type Fingerprint = Record<string, unknown>;

export const DEFAULT_MAX_SESSIONS_PER_SPRINT = 6;

/** Signals that move when a session did something: routing, progress, debt and pending reviews. */
export function fingerprint(kyro: KyroScopeState | KyroWorkState): Fingerprint {
  if (kyro.kind === 'work') {
    return {
      nextAction: kyro.nextAction,
      nextTaskId: kyro.nextTaskId,
      tasksDone: kyro.tasks.done,
      revision: kyro.revision,
      blockedReason: kyro.blockedReason,
    };
  }
  return {
    nextAction: kyro.nextAction,
    nextTaskId: kyro.nextTaskId,
    sprintCurrent: kyro.sprint.current,
    sprintClosed: kyro.sprint.closed,
    tasksDone: kyro.tasks.done,
    openDebt: kyro.openDebt,
    pendingReview: kyro.pendingReview,
  };
}

/** True when the signals changed between two reads of Kyro. */
export function progressed(before: Fingerprint, after: Fingerprint): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].some((key) => before[key] !== after[key]);
}

const session = (step: PilotStep, role: ModelRole): PilotDecision => ({
  kind: 'session',
  step,
  role,
});

const stop = (
  state: WorktreeStateId,
  blockedReason: BlockedReason | null,
  detail: string | null,
): PilotDecision => ({ kind: 'stop', state, blockedReason, detail });

/** A blocker that asks for `kyro repair` is an integrity finding, which is never applied alone. */
function isIntegrity(reason: string): boolean {
  return /repair|integrity|integridad/i.test(reason);
}

/** Kyro 6.1.0 reports this when the only pending task was disposed of: the sprint is not over. */
function isNoReadyWork(reason: string): boolean {
  return /no_ready_work/i.test(reason);
}

/**
 * Next step of a scope or work. Pure: the same Kyro state, run and last session always give the
 * same answer. `lastSession` is null before the first session of the run.
 */
export function decideNextStep(
  kyro: KyroScopeState | KyroWorkState,
  run: Pick<AutopilotRun, 'sessionsInSprint' | 'lastFingerprint'>,
  lastSession: LastSession | null,
  options: { maxSessionsPerSprint?: number } = {},
): PilotDecision {
  const max = options.maxSessionsPerSprint ?? DEFAULT_MAX_SESSIONS_PER_SPRINT;
  const route = kyro.kind === 'work' ? workRoute(kyro) : scopeRoute(kyro);

  // Terminal or waiting-for-a-person routes win over the loop guards: they are not a failure.
  if (route.kind === 'finished' || route.kind === 'stop') return route;

  // A session that moved nothing and asked nothing is a loop in the making (R11).
  if (
    lastSession !== null &&
    !lastSession.answeredQuestion &&
    run.lastFingerprint !== null &&
    !progressed(run.lastFingerprint, fingerprint(kyro))
  ) {
    return stop('bloqueado', 'sin_avance', 'La sesión terminó sin que el estado avance');
  }
  // Planning the next sprint starts a new count: the sessions of the one that just closed do not
  // carry over (the cap is per sprint, R11).
  const sessions = kyro.kind === 'scope' && kyro.sprint.current === null ? 0 : run.sessionsInSprint;
  if (sessions >= max) {
    return stop(
      'bloqueado',
      'tope_de_sesiones',
      `El sprint llegó al tope de ${String(max)} sesiones`,
    );
  }
  return route;
}

function scopeRoute(kyro: KyroScopeState): PilotDecision {
  if (kyro.nextAction === 'done') return { kind: 'finished' };
  if (kyro.nextAction === 'clarify') {
    return stop('esperando_aclaracion', null, 'Kyro pide aclarar un punto antes de seguir');
  }
  const blocked = kyro.blockedTasks ?? [];
  if (blocked.length > 0) {
    return stop('bloqueado', 'tarea_bloqueada', `Tarea bloqueada: ${blocked.join(', ')}`);
  }
  // With a sprint still open, "no ready work" means the sprint only needs its quality check.
  const blockers = kyro.blockers.filter(
    (reason) => !(isNoReadyWork(reason) && kyro.sprint.current !== null),
  );
  if (blockers.length > 0) {
    return stop(
      'bloqueado',
      blockers.some(isIntegrity) ? 'integridad_kyro' : 'kyro_bloqueado',
      blockers.join(' · '),
    );
  }
  switch (kyro.nextAction) {
    case 'init':
    case 'plan_sprint':
      return session('plan', 'thinker');
    case 'execute_task':
    case 'review_task':
      return session('execute', 'executor');
    case 'qa_or_close':
    case 'close_sprint':
      return { kind: 'check_quality' };
    case 'await_scope_completion':
      // An open sprint still has its quality check to run; closing and merging the scope is sprint 4.
      return kyro.sprint.current !== null
        ? { kind: 'check_quality' }
        : stop('esperando_aprobacion_cierre', null, 'El scope está listo para completarse');
  }
}

function workRoute(kyro: KyroWorkState): PilotDecision {
  switch (kyro.nextAction) {
    case 'done':
      return { kind: 'finished' };
    case 'plan_tasks':
      return session('plan', 'thinker');
    case 'execute_task':
    case 'review_task':
      return session('execute', 'executor');
    case 'resolve_blocker':
      return stop('bloqueado', 'tarea_bloqueada', kyro.blockedReason);
    case 'ready_to_close':
      return stop('cerrando', null, 'El work está listo para cerrarse');
  }
}
