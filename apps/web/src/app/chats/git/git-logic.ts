import {
  PARITY_CATALOG,
  type AutopilotStatus,
  type ChatKind,
  type ChatStatus,
  type DeleteRepoPreview,
  type DiffFile,
  type ManualStep,
  type PrRepoOutcome,
  type RepoOpOutcome,
  type RepoStatus,
  type WorktreeStateId,
} from '@agents-panel/shared';
import type { BadgeTone } from '../../ui/badge';

/** Same rule as the API (`ops.ts`): the first line of the message, type(scope)!: text. */
const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\s][^()]*\))?!?: \S/;

/** Pilot states in which a manual operation could race the pilot (same list as the API guard). */
const PILOT_BUSY: readonly AutopilotStatus[] = ['active', 'queued', 'waiting_quota'];

/** Warning for a commit message that is not Conventional Commits; null when it is. Never blocks. */
export function commitWarning(message: string): string | null {
  const first = message.trim().split('\n', 1)[0] ?? '';
  if (first === '' || CONVENTIONAL.test(first)) return null;
  return 'El mensaje no sigue Conventional Commits (por ejemplo "feat(api): ..."). Se puede commitear igual.';
}

/**
 * Why the git buttons are disabled, or null when they can be used. The API guards the same
 * conditions (409); this only explains them before the click.
 */
export function gitBlockedReason(input: {
  chatStatus: ChatStatus;
  workState: WorktreeStateId | null | undefined;
  pilotStatus: AutopilotStatus | null;
}): string | null {
  if (input.workState === 'archivado') return 'El trabajo está archivado: es de solo lectura.';
  if (input.chatStatus === 'running') return 'El agente de este trabajo está corriendo.';
  if (input.pilotStatus !== null && PILOT_BUSY.includes(input.pilotStatus)) {
    return `El piloto automático está ${input.pilotStatus}: pausalo para operar a mano.`;
  }
  return null;
}

export function repoTitle(path: string): string {
  return path === '.' ? 'Raíz' : path;
}

/** "3 archivos cambiados · 2 adelante · 1 atrás"; null counts (no remote) are left out. */
export function repoSummary(repo: Pick<RepoStatus, 'files' | 'ahead' | 'behind'>): string {
  const n = repo.files.length;
  const parts = [
    n === 0 ? 'sin cambios' : `${String(n)} ${n === 1 ? 'archivo cambiado' : 'archivos cambiados'}`,
  ];
  if (repo.ahead !== null) parts.push(`${String(repo.ahead)} adelante`);
  if (repo.behind !== null) parts.push(`${String(repo.behind)} atrás`);
  return parts.join(' · ');
}

/** Short label of a `git status --porcelain` code. */
export function fileStatusLabel(status: string): string {
  const code = status.trim();
  if (code === '??') return 'nuevo';
  if (code.includes('U')) return 'conflicto';
  if (code.includes('D')) return 'borrado';
  if (code.includes('A')) return 'agregado';
  if (code.includes('R')) return 'renombrado';
  if (code.includes('M')) return 'modificado';
  return code === '' ? 'cambiado' : code;
}

export function outcomeTone(outcome: Pick<RepoOpOutcome, 'result'>): BadgeTone {
  switch (outcome.result) {
    case 'ok':
      return 'ok';
    case 'conflict':
      return 'warn';
    case 'error':
      return 'danger';
  }
}

export function outcomeLabel(outcome: Pick<RepoOpOutcome, 'result'>): string {
  switch (outcome.result) {
    case 'ok':
      return 'Listo';
    case 'conflict':
      return 'Conflicto';
    case 'error':
      return 'Error';
  }
}

/** Message to the agent that asks it to resolve the conflicts of an aborted pull. */
export function conflictMessage(
  operation: 'base' | 'branch',
  repo: string,
  files: readonly string[],
): string {
  const where = repo === '.' ? 'la raíz del trabajo' : `el repo ${repo}`;
  const what = operation === 'base' ? 'traer la rama base' : 'traer mi rama del remoto';
  return [
    `Al ${what} en ${where} hubo conflictos y el pull se abortó.`,
    'Resolvé los conflictos en estos archivos, probá que todo compile y commiteá el resultado:',
    ...files.map((file) => `- ${file}`),
  ].join('\n');
}

/** Outcomes inside an API answer, whether it came as 200 or as a 422 error body. */
export function outcomesOf(body: unknown): RepoOpOutcome[] {
  if (typeof body !== 'object' || body === null) return [];
  const record = body as { repos?: unknown; path?: unknown; result?: unknown };
  if (Array.isArray(record.repos)) return record.repos as RepoOpOutcome[];
  if (typeof record.path === 'string' && typeof record.result === 'string') {
    return [record as RepoOpOutcome];
  }
  return [];
}

// --- Agent steps (D26) ---------------------------------------------------------------------------

export interface StepButton {
  step: ManualStep;
  label: string;
}

/**
 * The agent steps a person can launch, read from the parity catalog and kept to the ones that apply
 * to the kind of chat: only a scope or a work has steps, `qa` (kyro analyze) only a scope and
 * `merge_dev` only where the project ships that skill. Complete is last.
 */
export function stepButtons(kind: ChatKind, hasMergeDev: boolean): StepButton[] {
  if (kind !== 'scope' && kind !== 'work') return [];
  const seen = new Set<ManualStep>();
  const buttons: StepButton[] = [];
  for (const action of PARITY_CATALOG) {
    const manual = action.manual;
    if (manual?.type !== 'step' || action.pilotStep !== manual.step) continue;
    if (seen.has(manual.step)) continue;
    if (manual.step === 'qa' && kind !== 'scope') continue;
    if (manual.step === 'merge_dev' && !hasMergeDev) continue;
    seen.add(manual.step);
    buttons.push({ step: manual.step, label: action.label });
  }
  return buttons;
}

/** Where a catalog action with a manual access has its button in the web. */
export const PARITY_BUTTONS: Readonly<Record<string, { where: string; label: string }>> = {
  init: { where: 'Aprobación de la idea', label: 'Aprobar el plan' },
  plan: { where: 'Pasos del agente', label: 'Planificar el sprint' },
  execute: { where: 'Pasos del agente', label: 'Ejecutar las tareas' },
  qa: { where: 'Pasos del agente', label: 'Correr el QA (kyro analyze)' },
  fix: { where: 'Pasos del agente', label: 'Corregir lo que marcó el QA' },
  close: { where: 'Pasos del agente', label: 'Cerrar el sprint' },
  complete: { where: 'Pasos del agente', label: 'Completar el scope o cerrar el work' },
  commit_kyro: { where: 'Pasos del agente', label: 'Completar el scope o cerrar el work' },
  merge_dev: { where: 'Crear PR', label: 'Correr merge-dev' },
  push: { where: 'Repo', label: 'Push' },
  merge: { where: 'Repo', label: 'Pedírselo al agente' },
  open_pr: { where: 'Crear PR', label: 'Crear PR' },
  status: { where: 'Repo', label: 'Actualizar' },
  diff: { where: 'Repo', label: 'Ver cambios' },
  commit: { where: 'Repo', label: 'Commit' },
  discard: { where: 'Repo', label: 'Descartar' },
  pull_base: { where: 'Repo', label: 'Traer base' },
  pull_branch: { where: 'Repo', label: 'Traer mi rama' },
  reinstall: { where: 'Barra de la pestaña', label: 'Reinstalar dependencias' },
  create_pr: { where: 'Crear PR', label: 'Crear PR' },
  delete_work: { where: 'Barra de la pestaña', label: 'Borrar trabajo' },
};

// --- Diff, discard, PR and delete ----------------------------------------------------------------

export function diffFileLabel(file: Pick<DiffFile, 'status' | 'binary'>): string {
  if (file.binary) return 'binario';
  switch (file.status) {
    case 'added':
      return 'agregado';
    case 'deleted':
      return 'borrado';
    case 'untracked':
      return 'nuevo';
    case 'modified':
      return 'modificado';
  }
}

export function diffFileSummary(file: Pick<DiffFile, 'additions' | 'deletions'>): string {
  return `+${String(file.additions)} −${String(file.deletions)}`;
}

/** Class of a unified-diff line, to color additions and deletions. */
export function patchLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted';
  if (line.startsWith('+')) return 'text-ok';
  if (line.startsWith('-')) return 'text-danger';
  if (line.startsWith('@@')) return 'text-accent';
  return '';
}

/** The sentence that asks to confirm a discard; the modal lists every file under it. */
export function discardQuestion(files: readonly string[]): string {
  const n = files.length;
  return `Se van a descartar los cambios sin commitear de ${String(n)} ${
    n === 1 ? 'archivo' : 'archivos'
  }. No se pueden recuperar.`;
}

/** What a repo of the delete preview would lose, one line each; empty when nothing is at risk. */
export function deleteRisks(repo: DeleteRepoPreview): string[] {
  const risks: string[] = [];
  if (repo.error) risks.push(`No se pudo leer el repo: ${repo.error}`);
  if (repo.unpushedCommits > 0) {
    const n = repo.unpushedCommits;
    risks.push(`${String(n)} ${n === 1 ? 'commit sin pushear' : 'commits sin pushear'}`);
  }
  if (repo.uncommittedFiles.length > 0) {
    const n = repo.uncommittedFiles.length;
    risks.push(`${String(n)} ${n === 1 ? 'archivo sin commitear' : 'archivos sin commitear'}`);
  }
  return risks;
}

/** One line for a PR outcome: the reason it stopped (secrets name their files) or what happened. */
export function prOutcomeText(outcome: PrRepoOutcome): string {
  if (outcome.secrets && outcome.secrets.length > 0) {
    return `Se frenó por posibles secretos en: ${outcome.secrets.join(', ')}`;
  }
  if (outcome.url) return outcome.existing ? 'La PR ya existía y se actualizó' : 'PR creada';
  return outcome.output;
}
