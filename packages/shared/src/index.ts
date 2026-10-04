export type HealthStatus = 'ok';

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  status: HealthStatus;
  version: string;
}

/** A registered project (a git repo the panel can open worktrees on). */
export interface Project {
  id: number;
  name: string;
  repoPath: string;
  baseBranch: string;
  setupCommand: string | null;
}

/** A Kyro scope (big stage) or work (small change); each one owns one worktree. */
export type ChatKind = 'scope' | 'work';

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
