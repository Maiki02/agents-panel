export * from './usage.js';

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
  /** Claude account the session ran with; null for sessions older than the accounts. */
  accountId: number | null;
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

/** A git repo of a project: the root ('.') or a child repo ignored by the root. */
export interface ProjectRepo {
  id: number;
  projectId: number;
  /** Path relative to the base clone / worktree; '.' is the root. Only ever comes from detection. */
  path: string;
  /** Branch the repo is updated from and merged into; editable per repo. */
  baseBranch: string;
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

/** A window of a chat's events (`?tail=`): `firstSeq` is the cursor for the previous window. */
export interface ChatEventWindow {
  events: ChatEvent[];
  hasMore: boolean;
  firstSeq: number | null;
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

export type MaintenanceKind = 'kyro-update' | 'panel-deploy';

/**
 * One maintenance run: a Kyro update (docs/vm-setup.md, step 14; versions in from/to) or a panel
 * deploy (step 18; short commits in from/to).
 */
export interface MaintenanceRun {
  id: number;
  kind: MaintenanceKind;
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

/** The deployed panel: the commit it runs and what `origin/main` has on top of it. */
export interface PanelDeployInfo {
  /** Short commit the running server was started from; null when git could not tell. */
  commit: string | null;
  /** Commits of origin/main not deployed yet; null when unknown (no network, error). */
  behind: number | null;
  deployRunning: boolean;
  /** Why the Deploy button cannot be used (not under systemd); null when it can. */
  unavailableReason: string | null;
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

/** Outcome of updating one repo of the base clone: `result` or `error`, never both. */
export interface RepoPullResult {
  /** '.' for the root, else the child folder. */
  path: string;
  baseBranch: string;
  result: PullResult | null;
  error: string | null;
}

/** The root's pull result (compatible with the old response) plus one result per repo. */
export interface PullBaseResult extends PullResult {
  repos: RepoPullResult[];
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

/**
 * A Claude Code login the panel can run sessions with. `configDir` null is the default account
 * (~/.claude); the others are a CLAUDE_CONFIG_DIR. Exactly one is active for the whole panel.
 */
export interface ClaudeAccount {
  id: number;
  name: string;
  configDir: string | null;
  active: boolean;
  /** From `oauthAccount` of the account's .claude.json; null when it cannot be read. */
  email: string | null;
  organization: string | null;
  /** The directory has a login (.credentials.json). */
  loggedIn: boolean;
  /**
   * Its projects/ is the one of ~/.claude (scripts/vm/11-claude-cuentas.sh): it can resume a
   * session started with another account. Always true for the default account.
   */
  linked: boolean;
  createdAt: number;
}

export interface NewClaudeAccount {
  name: string;
  configDir: string;
}

// --- Git operations of a work (GET/POST /api/chats/:id/git, /setup) -------------------------------

/** Status of one repo of a work. */
export interface RepoStatus {
  /** '.' for the root, else the child folder name. */
  path: string;
  baseBranch: string;
  branch: string;
  files: { path: string; status: string }[];
  ahead: number | null;
  behind: number | null;
  /** Set when git failed on this repo; the other repos still answer. */
  error: string | null;
}

export interface WorktreeStatus {
  chatId: number;
  repos: RepoStatus[];
}

export type RepoOpResult = 'ok' | 'conflict' | 'error';

/** Outcome of an operation on one repo. */
export interface RepoOpOutcome {
  path: string;
  result: RepoOpResult;
  output: string;
  /** Conflicting files of a pull that was aborted. */
  conflicts?: string[];
  /** True when the user can hand the conflict to the agent. */
  askAgent?: boolean;
  /** True when this pull changed a lockfile. */
  lockfileChanged?: boolean;
}

export interface CommitOutcome extends RepoOpOutcome {
  /** Set when the message is not Conventional Commits; the commit is made anyway. */
  warning?: string;
}

export interface PullOutcome {
  repos: RepoOpOutcome[];
  /** Result of the automatic reinstall, when a lockfile changed. */
  reinstall: RepoOpOutcome | null;
}

export interface PushOutcome {
  repos: RepoOpOutcome[];
}

export interface GitCommitRequest {
  /** Relative path of a repo of the work ('.' for the root). */
  repo: string;
  files: string[];
  message: string;
}

export interface GitDiscardRequest {
  /** Relative path of a repo of the work ('.' for the root). */
  repo: string;
  files: string[];
}

/** What deleting the work would lose in one repo (D28). */
export interface DeleteRepoPreview {
  path: string;
  /** The work's own branch in this repo; null when the repo sits on its base (nothing to delete). */
  branch: string | null;
  /** True when origin has that branch. */
  remoteExists: boolean;
  /** Commits of the branch that are in no remote branch of origin. */
  unpushedCommits: number;
  /** Paths with changes that are not committed (ignored files never show). */
  uncommittedFiles: string[];
  /** Why this repo could not be read; the deletion would not touch it blindly. */
  error: string | null;
}

export interface DeletePreview {
  chatId: number;
  worktreePath: string;
  repos: DeleteRepoPreview[];
}

export interface DeleteWorkRequest {
  /** Also deletes the work's branches in origin (never the base). */
  deleteRemote: boolean;
}

export interface DeleteWorkOutcome {
  chatId: number;
  state: 'archivado';
  /** What was done, in order: one line per removed worktree or branch. */
  steps: string[];
}

/** A repo of the work that has commits outside its base: a candidate for a PR (D25). */
export interface PrRepoPreview {
  path: string;
  baseBranch: string;
  branch: string;
  /** Commits of the branch that are not in `origin/<base>`. */
  commits: number;
  /** URL of the PR already open from this branch into the base, or null. */
  openPrUrl: string | null;
  /** Conventional Commits title, prefilled and editable. */
  title: string;
  /** Body prefilled from `git log <base>..HEAD --no-merges`, editable. */
  body: string;
}

export interface PrPreview {
  chatId: number;
  /** True when the project ships its own merge-dev skill (the main button is then Run merge-dev). */
  hasMergeDev: boolean;
  repos: PrRepoPreview[];
}

export interface CreatePrRepoRequest {
  repo: string;
  title: string;
  body: string;
}

export interface CreatePrRequest {
  repos: CreatePrRepoRequest[];
}

/** Outcome of the PR of one repo; `output` is the git/gh output or the reason it stopped. */
export interface PrRepoOutcome extends RepoOpOutcome {
  /** The PR (new or the one already open) when there is one. */
  url?: string;
  /** True when the PR already existed and the push only updated it. */
  existing?: boolean;
  /** Files with secrets that stopped the push and the PR. */
  secrets?: string[];
}

export interface CreatePrOutcome {
  repos: PrRepoOutcome[];
}

/** Steps of the agent (and the completion) a person can ask for by hand (D26). */
export const MANUAL_STEPS = [
  'plan',
  'execute',
  'qa',
  'fix',
  'close',
  'merge_dev',
  'complete',
] as const;
export type ManualStep = (typeof MANUAL_STEPS)[number];

export interface StepRequest {
  step: ManualStep;
}

export interface StepOutcome {
  step: ManualStep;
  /** The agent step that was launched; `qa` resolves to `fix` or `close`, `complete` launches none. */
  launched: 'plan' | 'execute' | 'fix' | 'close' | 'merge_dev' | null;
  /** Blocking findings of `kyro analyze` (qa only). */
  findings?: string[];
  /** Result of the Kyro verb and the commit (complete only). */
  output?: string;
}

/** What a diff compares: the uncommitted changes, or the work's commits against the repo base. */
export type DiffAgainst = 'worktree' | 'base';

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'untracked';

/** One changed file of a diff (never an ignored one). */
export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Unified patch, cut at the limit; empty for a binary file. */
  patch: string;
  /** True when the patch was cut: ask for the file alone to see more. */
  truncated: boolean;
}

/** Read-only diff of one repo of the work (D27). */
export interface RepoDiff {
  repo: string;
  against: DiffAgainst;
  /** Base branch of the repo (the comparison point of `against: base`). */
  baseBranch: string;
  files: DiffFile[];
  /** True when more files changed than the diff lists. */
  moreFiles: boolean;
}

/** Pull and push: without `repo` they run on every repo of the work. */
export interface GitRepoRequest {
  repo?: string;
}

/** How a person asks for an action by hand: a route of the API, or a step of the agent. */
export type ManualAccess =
  { type: 'route'; method: 'GET' | 'POST'; path: string } | { type: 'step'; step: ManualStep };

/**
 * One action of the parity catalog (D26): what the pilot does by itself and the way to do the same by
 * hand. `pilotStep` is the name of the pilot's step (an `AutopilotStep`, `qa` or `complete`) and
 * `service` the method of the action service the pilot calls; both are set only for what the pilot
 * runs, and such an action must have a `manual` access.
 */
export interface ParityAction {
  id: string;
  label: string;
  /** Who does it in automatic mode: the pilot, or nobody (manual only). */
  automatic: 'pilot' | null;
  /** A deterministic action of the panel, or a step that needs the agent to reason. */
  kind: 'deterministic' | 'agent_step';
  pilotStep?: string;
  service?: string;
  /** The way to do it by hand; null only for an action the pilot never does by itself. */
  manual: ManualAccess | null;
  /** Why an action has no manual access yet. */
  note?: string;
}

const route = (method: 'GET' | 'POST', path: string): ManualAccess => ({
  type: 'route',
  method,
  path,
});
const step = (name: ManualStep): ManualAccess => ({ type: 'step', step: name });

/** Every action of the panel's flow with the pilot and its manual counterpart (D26). */
export const PARITY_CATALOG: readonly ParityAction[] = [
  {
    id: 'init',
    label: 'Crear el scope de la idea aprobada',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'init',
    manual: route('POST', '/api/chats/:id/idea'),
  },
  {
    id: 'plan',
    label: 'Planificar el sprint',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'plan',
    manual: step('plan'),
  },
  {
    id: 'execute',
    label: 'Ejecutar las tareas',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'execute',
    manual: step('execute'),
  },
  {
    id: 'qa',
    label: 'Correr el QA (kyro analyze)',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'qa',
    manual: step('qa'),
  },
  {
    id: 'fix',
    label: 'Corregir lo que marcó el QA',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'fix',
    manual: step('fix'),
  },
  {
    id: 'close',
    label: 'Cerrar el sprint',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'close',
    manual: step('close'),
  },
  {
    id: 'complete',
    label: 'Completar el scope o cerrar el work',
    automatic: 'pilot',
    kind: 'deterministic',
    pilotStep: 'complete',
    manual: step('complete'),
  },
  {
    id: 'commit_kyro',
    label: 'Commitear lo que escribió Kyro',
    automatic: 'pilot',
    kind: 'deterministic',
    service: 'commitKyro',
    manual: step('complete'),
  },
  {
    id: 'push',
    label: 'Pushear la rama del trabajo',
    automatic: 'pilot',
    kind: 'deterministic',
    service: 'pushBranch',
    manual: route('POST', '/api/chats/:id/git/push'),
  },
  {
    id: 'merge',
    label: 'Resolver los conflictos del merge con la base',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'merge',
    manual: route('POST', '/api/chats/:id/messages'),
  },
  {
    id: 'merge_dev',
    label: 'Correr merge-dev',
    automatic: 'pilot',
    kind: 'agent_step',
    pilotStep: 'merge_dev',
    manual: step('merge_dev'),
  },
  {
    id: 'open_pr',
    label: 'Abrir la PR',
    automatic: 'pilot',
    kind: 'deterministic',
    service: 'openPr',
    manual: route('POST', '/api/chats/:id/git/pr'),
  },
  {
    id: 'status',
    label: 'Ver el estado de cada repo',
    automatic: null,
    kind: 'deterministic',
    manual: route('GET', '/api/chats/:id/git'),
  },
  {
    id: 'diff',
    label: 'Ver los cambios',
    automatic: null,
    kind: 'deterministic',
    manual: route('GET', '/api/chats/:id/git/diff'),
  },
  {
    id: 'commit',
    label: 'Commitear archivos elegidos',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/git/commit'),
  },
  {
    id: 'discard',
    label: 'Descartar cambios',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/git/discard'),
  },
  {
    id: 'pull_base',
    label: 'Traer la rama base',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/git/pull-base'),
  },
  {
    id: 'pull_branch',
    label: 'Traer mi rama',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/git/pull-branch'),
  },
  {
    id: 'reinstall',
    label: 'Reinstalar dependencias',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/setup'),
  },
  {
    id: 'create_pr',
    label: 'Crear PR por repo',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/git/pr'),
  },
  {
    id: 'delete_work',
    label: 'Borrar el trabajo',
    automatic: null,
    kind: 'deterministic',
    manual: route('POST', '/api/chats/:id/work/delete'),
  },
  {
    id: 'repair_kyro',
    label: 'Reparar el estado de Kyro',
    automatic: null,
    kind: 'agent_step',
    manual: null,
    note: 'Manual y sin ruta todavía: el piloto nunca lo hace solo.',
  },
];
