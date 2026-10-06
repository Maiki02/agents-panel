export type HealthStatus = 'ok';

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: HealthStatus;
  version: string;
}

/** Where a project stands: being cloned from GitHub, usable, or failed (see statusDetail). */
export type ProjectStatus = 'cloning' | 'ready' | 'error';

/** Which model plays which part of a job: the thinker plans, the executor does the rest. */
export type ModelRole = 'thinker' | 'executor';

/** Only Claude is implemented; the data model keeps the provider to add others later. */
export type ModelProvider = 'claude';

/** Models each provider offers. A model outside its provider's list is refused. */
export const MODEL_CATALOG: Record<ModelProvider, readonly string[]> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],
};

export const DEFAULT_PROVIDER: ModelProvider = 'claude';

/** Global defaults used when neither the chat nor the project chose a model. */
export const DEFAULT_MODELS: Record<ModelRole, string> = {
  thinker: 'claude-opus-5-5',
  executor: 'claude-sonnet-5-5',
};

/** The models of a project or a chat, one per role. */
export interface ModelSelection {
  provider: ModelProvider;
  thinker: string;
  executor: string;
}

/** Where the autopilot of a job stands. `stopped` always carries a reason the user can read. */
export const AUTOPILOT_STATUSES = [
  'active',
  'paused',
  'off',
  'stopped',
  'waiting_quota',
  'queued',
  'finished',
] as const;
export type AutopilotStatus = (typeof AUTOPILOT_STATUSES)[number];

/**
 * What a pilot session is for: creating the scope of an approved idea, the plan of a sprint, its
 * execution, a fix, or its closing.
 */
export const AUTOPILOT_STEPS = [
  'init',
  'plan',
  'execute',
  'fix',
  'close',
  'merge',
  'merge_dev',
  'manual',
] as const;
export type AutopilotStep = (typeof AUTOPILOT_STEPS)[number];

/** Phase of a run past the work itself: the merge into the base, until the PR is ready. */
export type AutopilotPhase = 'merge';

/** The autopilot of one scope or work (one row per chat, created when it is switched on). */
export interface AutopilotRun {
  chatId: number;
  status: AutopilotStatus;
  /** Step of the session in progress or about to open; null before the first one. */
  step: AutopilotStep | null;
  sprintN: number | null;
  /** Sessions opened for the current sprint: the cap is `maxSessionsPerSprint`. */
  sessionsInSprint: number;
  /** Signals read after the last turn, to notice a turn that moved nothing. */
  lastFingerprint: Record<string, unknown> | null;
  stopReason: string | null;
  /** When a `waiting_quota` run tries again. */
  retryAt: number | null;
  policyVersion: number | null;
  /** Idea document an approved scope is created from; set until its init session opens. */
  seedPath: string | null;
  /** null while the work is being done; 'merge' once it is completed and goes to the PR. */
  phase: AutopilotPhase | null;
  /** Open PRs of the work (the root repo and its child repos), once the merge phase made them. */
  prUrls: string[];
  createdAt: number;
  updatedAt: number;
}

/** Answer of `GET`/`POST /api/chats/:id/autopilot`. */
export interface AutopilotInfo {
  run: AutopilotRun | null;
  maxSessionsPerSprint: number;
}

/** `on` switches the pilot on in a scope or work that has none (or has it off). */
export type AutopilotAction = 'on' | 'pause' | 'resume' | 'off' | 'accept_debt';

/** One SDK session the panel opened for a chat, with the model that ran it. */
export interface AgentSession {
  id: number;
  chatId: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  sdkSessionId: string | null;
  /** Sprint the session worked on; null until the pilot assigns one. */
  sprintN: number | null;
  /** What the session was for; `manual` for the ones the user started by hand. */
  step: AutopilotStep;
  /** Version of the gates policy the session ran with; null when none was injected. */
  policyVersion: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Final chat status of the turn (idle, error, cancelled); null while running. */
  result: string | null;
}

/** A registered project (a git repo the panel can open worktrees on). */
export interface Project {
  id: number;
  /** Internal kebab-case name: used in paths and worktrees, never changes. */
  name: string;
  /** Free-form name shown in the web; falls back to `name` when null. */
  displayName: string | null;
  /** Canonical GitHub URL (https://github.com/owner/repo), null for projects added by path. */
  repoUrl: string | null;
  repoPath: string;
  baseBranch: string;
  setupCommand: string | null;
  /** Command that validates a worktree before its PR (build, tests); null when it has none. */
  validateCommand: string | null;
  status: ProjectStatus;
  statusDetail: string | null;
  /** The repo ships `.agents/kyro/`. Computed on read, never stored. */
  hasKyro: boolean;
  /** Set when a ready project could not initialize Kyro (the project stays usable). */
  kyroWarning: string | null;
  /** The Kyro init branch waits to be pushed and merged; null once the clone has Kyro or none exists. */
  kyroInit?: KyroInitPending | null;
  /** Kyro's files in the base clone are modified (e.g. after an update): they need a commit. */
  kyroPendingCommit?: boolean;
  /** Models for new chats; the global defaults when the project has no configuration. */
  models: ModelSelection;
}

/** Metadata of a project's development .env; the content never leaves the API. */
export interface EnvFileInfo {
  /** Relative path inside the worktree, e.g. `.env` or `backend/.env.local`. */
  path: string;
  keyNames: string[];
  updatedAt: number;
  /** False when it cannot be decrypted (rotated PANEL_SECRET_KEY or tampered data). */
  readable: boolean;
}

/** Outcome of writing a project's .env files into one active worktree. */
export interface EnvApplyResult {
  chatId: number;
  worktreePath: string;
  status: 'written' | 'skipped';
  /** Why it was skipped; null when written. */
  reason: string | null;
}

/** A Kyro scope (big stage) or work (small change); each one owns one worktree. */
export type ChatKind = 'scope' | 'work' | 'direct' | 'idea';

/** Coarse session state; see docs/estados.md. */
export type ChatStatus = 'running' | 'idle' | 'error' | 'interrupted' | 'cancelled';

export interface Chat {
  id: number;
  projectId: number;
  projectName: string;
  kind: ChatKind;
  slug: string;
  title: string;
  worktreePath: string;
  branch: string;
  sdkSessionId: string | null;
  status: ChatStatus;
  /** Resolved when the chat was created: changing the project later does not touch it. */
  models: ModelSelection;
  /** Fine state of a scope, work or idea (`null` before the first transition and for a direct chat). */
  workState?: WorktreeStateId | null;
  createdAt: number;
  updatedAt: number;
}

/** One persisted event of a chat, ordered by `seq` (unique per chat). */
export interface ChatEvent {
  id: number;
  chatId: number;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: number;
}

/** One question of an AskUserQuestion call, as the agent asked it. "Other" is added by the UI. */
export interface AskedQuestion {
  question: string;
  /** Very short chip label (max 12 characters). */
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

/** The user's answer to one question: chosen option labels and/or free text. */
export interface QuestionAnswerItem {
  selected: string[];
  text: string | null;
}

/** Answers keyed by the exact question text. */
export type QuestionAnswer = Record<string, QuestionAnswerItem>;

export type PendingQuestionStatus = 'pending' | 'answered' | 'cancelled';

/** A question the agent of a chat is waiting on. It never expires and is never auto-answered. */
export interface PendingQuestion {
  id: number;
  chatId: number;
  toolUseId: string;
  questions: AskedQuestion[];
  status: PendingQuestionStatus;
  answer: QuestionAnswer | null;
  /** User id; always set when status is answered. */
  answeredBy: number | null;
  createdAt: number;
  answeredAt: number | null;
}

export type MaintenanceStatus = 'running' | 'ok' | 'error';

/** One Kyro update run (see docs/vm-setup.md, step 14). */
export interface MaintenanceRun {
  id: number;
  kind: 'kyro-update';
  fromVersion: string | null;
  toVersion: string | null;
  status: MaintenanceStatus;
  /** Last 16 KB of the script output; null while running. */
  output: string | null;
  /** Project roots the update skipped because they had local changes outside .agents/kyro/. */
  skipped: string[];
  startedAt: number;
  finishedAt: number | null;
}

/** Installed Kyro version and the latest published one; null when unknown (no network, error). */
export interface KyroVersionInfo {
  installed: string | null;
  latest: string | null;
}

/** Result of bringing `origin/<base>` into a project's base clone (POST /api/projects/:id/pull). */
export interface PullResult {
  status: 'up_to_date' | 'updated';
  before: string;
  after: string;
  /** Commits brought from origin. */
  commits: number;
  /** Local commits origin does not have (kept untouched). */
  ahead: number;
  output: string;
}

/** The branch POST /api/projects/:id/kyro-init leaves committed and unpushed. */
/** The branch `Inicializar Kyro` left behind, read from the clone's refs (no network). */
export interface KyroInitPending {
  branch: string;
  /** The branch is on `origin`: only the PR and the merge are left. */
  pushed: boolean;
  /** GitHub link that opens the PR of the branch; null for a project without a GitHub URL. */
  prUrl: string | null;
}

/** Answer of `POST /api/projects/:id/kyro-init/push`. */
export interface KyroInitPushResult {
  branch: string;
  prUrl: string | null;
}

export interface KyroBranchResult {
  branch: string;
  path: string;
  commit: string;
}

/** Work that deleting a project would lose (409 body of DELETE /api/projects/:id). */
export interface DeleteBlocker {
  path: string;
  kind: 'uncommitted' | 'unpushed';
  detail: string;
}

/** Catalog of worktree states (docs/estados.md); the panel stores one per scope or work. */
export const WORKTREE_STATE_IDS = [
  'en_cola',
  'creando_worktree',
  'instalando_dependencias',
  'madurando_idea',
  'planificando',
  'esperando_aclaracion',
  'esperando_aprobacion_plan',
  'escribiendo_codigo',
  'en_cola_build',
  'buildeando',
  'probando',
  'corrigiendo',
  'registrando_evidencia',
  'revisando_tarea',
  'esperando_permiso',
  'esperando_respuesta',
  'qa',
  'cerrando_sprint',
  'esperando_aprobacion_cierre',
  'trayendo_dev',
  'resolviendo_conflictos',
  'validando_post_merge',
  'abriendo_pr',
  'en_cola_merge_raiz',
  'mergeando_raiz',
  'pr_lista',
  'pr_checks_fallidos',
  'pr_cambios_pedidos',
  'mergeada',
  'limpiando',
  'archivado',
  'pausado',
  'sin_cupo_de_uso',
  'interrumpido',
  'bloqueado',
  'revisar',
  'error',
  'cancelado',
  // Added with the Kyro mapping: the Kyro side of the work is over (see docs/estados.md).
  'cerrando',
  'terminado',
] as const;

export type WorktreeStateId = (typeof WORKTREE_STATE_IDS)[number];

/** Who caused a transition: the user, the pilot (orchestrator), the agent or the panel itself. */
export const ACTORS = ['user', 'pilot', 'agent', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

/** Why the pilot stopped; shown next to the `bloqueado` state. */
export const BLOCKED_REASONS = [
  'sin_avance',
  'tope_de_sesiones',
  'tarea_bloqueada',
  'kyro_bloqueado',
  'integridad_kyro',
  'qa_sin_correr',
  'qa_sin_aprobar',
  'secretos',
  'conflicto',
  'build_roto',
  'merge_sin_pr',
  'git',
  'otro',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** Current fine-grained state of a scope or work (a direct chat has none). */
export interface WorktreeState {
  chatId: number;
  state: WorktreeStateId;
  /** Free detail shown next to the state, e.g. what is being tested. */
  detail: string | null;
  phase: string | null;
  sprintCurrent: number | null;
  sprintClosed: number | null;
  sprintTotal: number | null;
  taskDone: number | null;
  taskTotal: number | null;
  openDebt: number | null;
  blockedReason: BlockedReason | null;
  actor: Actor;
  role: ModelRole | null;
  model: string | null;
  /** When the current state began. */
  since: number;
  previousState: WorktreeStateId | null;
}

/** One entry of a work's Timeline. `fromState` is null for the first one. */
export interface WorktreeTransition {
  id: number;
  chatId: number;
  fromState: WorktreeStateId | null;
  toState: WorktreeStateId;
  reason: string | null;
  actor: Actor;
  role: ModelRole | null;
  model: string | null;
  data: unknown;
  createdAt: number;
}

/** Commands a project's repo suggests, with the file that suggested them. Never applied on their own. */
export interface PermissionSuggestion {
  file: string;
  commands: string[];
}

/** What the agent may run through Bash in a project (GET /api/projects/:id/permissions). */
export interface ProjectPermissions {
  /** Commands every project has; they cannot be removed. */
  base: string[];
  /** Hosts curl always reaches. */
  curlBaseHosts: string[];
  /** Commands this project added. */
  commands: string[];
  /** Hosts this project added for curl. */
  hosts: string[];
  /** Commands no project can enable. */
  fixedDenied: string[];
  suggestions: PermissionSuggestion[];
}

/** The document kyro-idea wrote in an idea chat, as the web shows it for approval. */
export interface IdeaDocument {
  state: WorktreeStateId | null;
  /** Relative to the worktree; null until exactly one document exists. */
  path: string | null;
  /** Every candidate path found (more than one blocks the approval). */
  documents: string[];
  content: string | null;
  truncated: boolean;
}

/** What the user decides about the plan of an idea (POST /api/chats/:id/idea). */
export const IDEA_ACTIONS = ['approve_scope', 'approve_work', 'request_changes'] as const;
export type IdeaAction = (typeof IDEA_ACTIONS)[number];

/** Answer of `GET /api/push/config`: Web Push is off until the panel has VAPID keys. */
export interface PushConfig {
  enabled: boolean;
  /** VAPID public key the browser subscribes with; null while disabled. */
  publicKey: string | null;
}

/** A browser or phone that receives the panel's notifications (never exposes its keys). */
export interface PushSubscriptionInfo {
  id: number;
  endpoint: string;
  name: string;
  userAgent: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
}

/** What the browser sends to subscribe (`PushSubscription.toJSON()` plus a name). */
export interface NewPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  name?: string;
}

/** Answer of `POST /api/push/subscriptions/:id/test`. */
export interface PushTestResult {
  sent: boolean;
  /** The push service said the subscription is gone (404 or 410) and the panel dropped it. */
  removed: boolean;
  statusCode: number | null;
}

/**
 * Who has to move in a state: the badge tone of the web and the push notifications of the API
 * follow it, so both read the same classification.
 */
export type StateActor = 'working' | 'user' | 'ok' | 'waiting' | 'error';

/** Spanish label and who has to move, for every state of the catalog (docs/estados.md). */
export const WORKTREE_STATE_INFO: Record<WorktreeStateId, { label: string; who: StateActor }> = {
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
