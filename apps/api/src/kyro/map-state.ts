import type { BlockedReason, WorktreeStateId } from '@agents-panel/shared';
import type { KyroScopeState, KyroWorkState } from './state.js';

/** Phases of the stepper (docs/estados.md). */
export type WorktreePhaseId = 'planificacion' | 'ejecucion' | 'qa' | 'cierre';

/** What the Kyro CLI says about a worktree, reduced to the fields of `worktree_state`. */
export interface MappedKyroState {
  state: WorktreeStateId;
  phase: WorktreePhaseId;
  detail: string | null;
  sprintCurrent: number | null;
  sprintClosed: number | null;
  sprintTotal: number | null;
  taskDone: number;
  taskTotal: number;
  openDebt: number | null;
  blockedReason: BlockedReason | null;
}

const SCOPE_STATE: Record<
  KyroScopeState['nextAction'],
  { state: WorktreeStateId; phase: WorktreePhaseId }
> = {
  init: { state: 'planificando', phase: 'planificacion' },
  plan_sprint: { state: 'planificando', phase: 'planificacion' },
  clarify: { state: 'esperando_aclaracion', phase: 'planificacion' },
  execute_task: { state: 'escribiendo_codigo', phase: 'ejecucion' },
  review_task: { state: 'revisando_tarea', phase: 'ejecucion' },
  qa_or_close: { state: 'qa', phase: 'qa' },
  close_sprint: { state: 'cerrando_sprint', phase: 'qa' },
  await_scope_completion: { state: 'esperando_aprobacion_cierre', phase: 'cierre' },
  done: { state: 'terminado', phase: 'cierre' },
};

const WORK_STATE: Record<
  KyroWorkState['nextAction'],
  { state: WorktreeStateId; phase: WorktreePhaseId }
> = {
  plan_tasks: { state: 'planificando', phase: 'planificacion' },
  execute_task: { state: 'escribiendo_codigo', phase: 'ejecucion' },
  review_task: { state: 'revisando_tarea', phase: 'ejecucion' },
  resolve_blocker: { state: 'bloqueado', phase: 'ejecucion' },
  ready_to_close: { state: 'cerrando', phase: 'cierre' },
  done: { state: 'terminado', phase: 'cierre' },
};

/**
 * Pure mapping from the parsed Kyro state to the fine state. It takes only data printed by the
 * CLI, so nothing the agent writes can move a worktree to another state (R7).
 */
export function mapKyroState(kyro: KyroScopeState | KyroWorkState): MappedKyroState {
  if (kyro.kind === 'work') {
    const base = WORK_STATE[kyro.nextAction];
    const blocked = kyro.nextAction === 'resolve_blocker';
    return {
      ...base,
      detail: blocked ? kyro.blockedReason : null,
      sprintCurrent: null,
      sprintClosed: null,
      sprintTotal: null,
      taskDone: kyro.tasks.done,
      taskTotal: kyro.tasks.total,
      openDebt: null,
      blockedReason: blocked ? 'tarea_bloqueada' : null,
    };
  }
  const base = SCOPE_STATE[kyro.nextAction];
  // A finished scope has nothing left to block; otherwise any CLI blocker stops the route.
  const blocked = kyro.nextAction !== 'done' && kyro.blockers.length > 0;
  return {
    state: blocked ? 'bloqueado' : base.state,
    phase: base.phase,
    detail: blocked ? kyro.blockers.join(' · ') : null,
    sprintCurrent: kyro.sprint.current,
    sprintClosed: kyro.sprint.closed,
    sprintTotal: kyro.sprint.total,
    taskDone: kyro.tasks.done,
    taskTotal: kyro.tasks.total,
    openDebt: kyro.openDebt,
    blockedReason: blocked ? 'kyro_bloqueado' : null,
  };
}
