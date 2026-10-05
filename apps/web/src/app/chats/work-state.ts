import type { WorktreeStateId } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';

/** Who has to move: the tone of the badge follows it (docs/identidad-visual.md). */
type Who = 'working' | 'user' | 'ok' | 'waiting' | 'error';

const TONE: Record<Who, BadgeTone> = {
  working: 'accent',
  user: 'warn',
  ok: 'ok',
  waiting: 'neutral',
  error: 'danger',
};

const STATES: Record<WorktreeStateId, { label: string; who: Who }> = {
  en_cola: { label: 'En cola', who: 'waiting' },
  creando_worktree: { label: 'Creando worktree', who: 'working' },
  instalando_dependencias: { label: 'Instalando dependencias', who: 'working' },
  madurando_idea: { label: 'Madurando la idea', who: 'working' },
  planificando: { label: 'Planificando', who: 'working' },
  esperando_aclaracion: { label: 'Necesita una aclaración', who: 'user' },
  esperando_aprobacion_plan: { label: 'Esperando aprobación del plan', who: 'user' },
  escribiendo_codigo: { label: 'Escribiendo código', who: 'working' },
  en_cola_build: { label: 'En cola para buildear', who: 'waiting' },
  buildeando: { label: 'Buildeando', who: 'working' },
  probando: { label: 'Probando', who: 'working' },
  corrigiendo: { label: 'Corrigiendo', who: 'working' },
  registrando_evidencia: { label: 'Registrando evidencia', who: 'working' },
  revisando_tarea: { label: 'Revisando tarea', who: 'working' },
  esperando_permiso: { label: 'Pide permiso', who: 'user' },
  esperando_respuesta: { label: 'Esperando tu respuesta', who: 'user' },
  qa: { label: 'QA en curso', who: 'working' },
  cerrando_sprint: { label: 'Cerrando sprint', who: 'working' },
  esperando_aprobacion_cierre: { label: 'Cierre de scope para aprobar', who: 'user' },
  trayendo_dev: { label: 'Trayendo la base a la rama', who: 'working' },
  resolviendo_conflictos: { label: 'Resolviendo conflictos', who: 'working' },
  validando_post_merge: { label: 'Validando después del merge', who: 'working' },
  abriendo_pr: { label: 'Abriendo la PR', who: 'working' },
  en_cola_merge_raiz: { label: 'En cola para mergear la raíz', who: 'waiting' },
  mergeando_raiz: { label: 'Mergeando la raíz', who: 'working' },
  pr_lista: { label: 'PR lista para revisar', who: 'ok' },
  pr_checks_fallidos: { label: 'Checks de la PR en rojo', who: 'user' },
  pr_cambios_pedidos: { label: 'Cambios pedidos en la PR', who: 'working' },
  mergeada: { label: 'Mergeada', who: 'ok' },
  limpiando: { label: 'Borrando worktree', who: 'working' },
  archivado: { label: 'Archivado', who: 'waiting' },
  pausado: { label: 'Pausado', who: 'user' },
  sin_cupo_de_uso: { label: 'Esperando cupo de la suscripción', who: 'waiting' },
  interrumpido: { label: 'Interrumpido', who: 'user' },
  bloqueado: { label: 'Bloqueado', who: 'user' },
  revisar: { label: 'Revisar a mano', who: 'user' },
  error: { label: 'Error', who: 'error' },
  cancelado: { label: 'Cancelado', who: 'waiting' },
  cerrando: { label: 'Cerrando', who: 'working' },
  terminado: { label: 'Terminado', who: 'ok' },
};

/** The single badge of a work: the label of its fine state and the tone of who has to move. */
export function workStateBadge(state: WorktreeStateId): { label: string; tone: BadgeTone } {
  const entry = STATES[state];
  return { label: entry.label, tone: TONE[entry.who] };
}
