import type { ModelRole, WorktreeState, WorktreeStateId } from '@agents-panel/shared';

/** Phases of a work from the idea to the PR, in order (docs/estados.md). */
export const PHASES = [
  { id: 'idea', label: 'Idea' },
  { id: 'plan', label: 'Plan' },
  { id: 'execution', label: 'Ejecución' },
  { id: 'qa', label: 'QA' },
  { id: 'close', label: 'Cierre' },
  { id: 'merge', label: 'Merge' },
  { id: 'pr', label: 'PR' },
] as const;

export type PhaseId = (typeof PHASES)[number]['id'];

const PHASE_OF: Partial<Record<WorktreeStateId, PhaseId>> = {
  madurando_idea: 'idea',
  esperando_aprobacion_plan: 'idea',
  planificando: 'plan',
  esperando_aclaracion: 'plan',
  escribiendo_codigo: 'execution',
  en_cola_build: 'execution',
  buildeando: 'execution',
  probando: 'execution',
  corrigiendo: 'execution',
  registrando_evidencia: 'execution',
  revisando_tarea: 'execution',
  esperando_permiso: 'execution',
  esperando_respuesta: 'execution',
  qa: 'qa',
  cerrando_sprint: 'close',
  esperando_aprobacion_cierre: 'close',
  cerrando: 'close',
  trayendo_dev: 'merge',
  resolviendo_conflictos: 'merge',
  validando_post_merge: 'merge',
  abriendo_pr: 'merge',
  en_cola_merge_raiz: 'merge',
  mergeando_raiz: 'merge',
  pr_lista: 'pr',
  pr_checks_fallidos: 'pr',
  pr_cambios_pedidos: 'pr',
  mergeada: 'pr',
  limpiando: 'pr',
  archivado: 'pr',
  terminado: 'pr',
};

/**
 * Phase a state belongs to. A state that interrupts the flow (blocked, paused, interrupted, error…)
 * has none of its own: it keeps the phase of the state it came from, and null when that is unknown.
 */
export function phaseOf(
  state: WorktreeStateId,
  previous: WorktreeStateId | null = null,
): PhaseId | null {
  const own = PHASE_OF[state];
  if (own !== undefined) return own;
  return previous === null ? null : (PHASE_OF[previous] ?? null);
}

export type StepStatus = 'done' | 'current' | 'upcoming';

export interface StepView {
  id: PhaseId;
  label: string;
  status: StepStatus;
}

export interface StepperView {
  steps: StepView[];
  /** Label of the current phase; null when the state does not say one. */
  current: string | null;
  /** "Sprint 2/3", null when the state has no sprint numbers: nothing is invented. */
  sprint: string | null;
  task: string | null;
  /** "Pensante · claude-opus-5-5"; null before any session. */
  session: string | null;
}

export const ROLE_LABEL: Record<ModelRole, string> = {
  thinker: 'Pensante',
  executor: 'Ejecutor',
};

/** "n/m" only when both numbers are known. */
function ratio(label: string, current: number | null, total: number | null): string | null {
  if (current === null || total === null || total < 1) return null;
  return `${label} ${String(current)}/${String(total)}`;
}

export function sessionLabel(role: ModelRole | null, model: string | null): string | null {
  if (role === null && model === null) return null;
  return [role === null ? null : ROLE_LABEL[role], model].filter((x) => x !== null).join(' · ');
}

/** What the stepper shows for the stored state of a work; null state: every step is upcoming. */
export function stepperView(
  state: Pick<
    WorktreeState,
    | 'state'
    | 'previousState'
    | 'sprintCurrent'
    | 'sprintTotal'
    | 'taskDone'
    | 'taskTotal'
    | 'role'
    | 'model'
  > | null,
): StepperView {
  const phase = state === null ? null : phaseOf(state.state, state.previousState);
  const index = phase === null ? -1 : PHASES.findIndex((p) => p.id === phase);
  const steps = PHASES.map<StepView>((p, i) => ({
    id: p.id,
    label: p.label,
    status: i < index ? 'done' : i === index ? 'current' : 'upcoming',
  }));
  return {
    steps,
    current: index < 0 ? null : (PHASES[index]?.label ?? null),
    sprint: state === null ? null : ratio('Sprint', state.sprintCurrent, state.sprintTotal),
    task: state === null ? null : ratio('Tarea', state.taskDone, state.taskTotal),
    session: state === null ? null : sessionLabel(state.role, state.model),
  };
}
