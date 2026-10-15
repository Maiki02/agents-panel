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
  // A merged work has finished every phase, PR included: all steps are done and none is current.
  // Only `mergeada` counts: `limpiando`, `archivado` and `terminado` can be reached without a merge.
  const merged = state !== null && state.state === 'mergeada';
  const steps = PHASES.map<StepView>((p, i) => ({
    id: p.id,
    label: p.label,
    status: merged || i < index ? 'done' : i === index ? 'current' : 'upcoming',
  }));
  return {
    steps,
    current: merged || index < 0 ? null : (PHASES[index]?.label ?? null),
    sprint: state === null ? null : ratio('Sprint', state.sprintCurrent, state.sprintTotal),
    task: state === null ? null : ratio('Tarea', state.taskDone, state.taskTotal),
    session: state === null ? null : sessionLabel(state.role, state.model),
  };
}

export type TaskTone = 'neutral' | 'warn' | 'danger';

export interface CurrentTaskView {
  /** Task id as Kyro prints it (T1.1, W2); null when Kyro has none: nothing is invented. */
  id: string | null;
  /** Readable activity ("Corrigiendo"); an interruption carries its reason ("Bloqueada: build roto"). */
  activity: string;
  tone: TaskTone;
  /** "n/m" of tasks; null unless both numbers are known. */
  progress: string | null;
  /** "Sprint 2/3"; null unless both numbers are known. */
  sprint: string | null;
}

/** Fine states of the Plan, Execution and QA phases, as the panel shows them. */
const TASK_ACTIVITY: Partial<Record<WorktreeStateId, string>> = {
  planificando: 'Planificando',
  esperando_aclaracion: 'Esperando respuesta',
  escribiendo_codigo: 'Escribiendo código',
  en_cola_build: 'En cola de build',
  buildeando: 'Buildeando',
  probando: 'Probando',
  corrigiendo: 'Corrigiendo',
  registrando_evidencia: 'Registrando evidencia',
  revisando_tarea: 'Revisando',
  esperando_permiso: 'Esperando permiso',
  esperando_respuesta: 'Esperando respuesta',
  qa: 'QA',
};

/** States that interrupt the flow, with their label and tone. */
const INTERRUPTION: Partial<Record<WorktreeStateId, { label: string; tone: TaskTone }>> = {
  pausado: { label: 'Pausada', tone: 'warn' },
  sin_cupo_de_uso: { label: 'Sin cupo de uso', tone: 'warn' },
  interrumpido: { label: 'Interrumpida', tone: 'warn' },
  revisar: { label: 'Para revisar', tone: 'warn' },
  bloqueado: { label: 'Bloqueada', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },
};

const WAITING: ReadonlySet<WorktreeStateId> = new Set([
  'esperando_aclaracion',
  'esperando_permiso',
  'esperando_respuesta',
]);

const TASK_PHASES: ReadonlySet<PhaseId | null> = new Set(['plan', 'execution', 'qa']);

/**
 * What the panel shows for the current task: its id, what is being done and how far it is.
 * Null when there is neither a task nor task activity (idea, close, merge, PR…).
 */
export function currentTaskView(
  state: Pick<
    WorktreeState,
    | 'state'
    | 'previousState'
    | 'taskId'
    | 'blockedReason'
    | 'detail'
    | 'sprintCurrent'
    | 'sprintTotal'
    | 'taskDone'
    | 'taskTotal'
  > | null,
): CurrentTaskView | null {
  if (state === null) return null;
  const interruption = INTERRUPTION[state.state];
  let activity: string | undefined;
  let tone: TaskTone = 'neutral';
  if (interruption !== undefined) {
    const phase = phaseOf(state.state, state.previousState);
    if (state.taskId === null && !TASK_PHASES.has(phase)) return null;
    const reason =
      state.blockedReason === null ? state.detail : state.blockedReason.replace(/_/g, ' ');
    activity =
      reason === null || reason === '' ? interruption.label : `${interruption.label}: ${reason}`;
    tone = interruption.tone;
  } else {
    activity = TASK_ACTIVITY[state.state];
    if (activity === undefined) return null;
    if (WAITING.has(state.state)) tone = 'warn';
  }
  const progress =
    state.taskDone === null || state.taskTotal === null || state.taskTotal < 1
      ? null
      : `${String(state.taskDone)}/${String(state.taskTotal)}`;
  return {
    id: state.taskId,
    activity,
    tone,
    progress,
    sprint: ratio('Sprint', state.sprintCurrent, state.sprintTotal),
  };
}
