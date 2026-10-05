export type HealthStatus = 'ok';

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: HealthStatus;
  version: string;
}

/** Where a project stands: being cloned from GitHub, usable, or failed (see statusDetail). */
export type ProjectStatus = 'cloning' | 'ready' | 'error';

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
  status: ProjectStatus;
  statusDetail: string | null;
  /** The repo ships `.agents/kyro/`. Computed on read, never stored. */
  hasKyro: boolean;
  /** Set when a ready project could not initialize Kyro (the project stays usable). */
  kyroWarning: string | null;
  /** Kyro's files in the base clone are modified (e.g. after an update): they need a commit. */
  kyroPendingCommit?: boolean;
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
export type ChatKind = 'scope' | 'work' | 'direct';

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
