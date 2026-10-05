/** One thing the agent did or said, already reduced to what the panel persists. */
export interface AgentEvent {
  /** SDK message type, with the subtype appended when present (e.g. "system:init", "result:success"). */
  type: string;
  payload: unknown;
  /** Present on the SDK init message; stored so the chat can be resumed. */
  sessionId?: string;
}

/** The only tool whose answer comes from the user instead of from the allowlist. */
export const ASK_USER_QUESTION = 'AskUserQuestion';

/**
 * `updatedInput` replaces the tool input the agent sees. It is how a user's answer comes back to
 * AskUserQuestion (confirmed by the H1 spike, see docs/plan.md).
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface ToolCallContext {
  /** Id of this tool call, from the SDK; used to tie a question to its call. */
  toolUseId?: string;
}

export interface RunParams {
  cwd: string;
  prompt: string;
  /** SDK session to continue; absent for the first turn. */
  resumeSessionId?: string;
  signal: AbortSignal;
  /**
   * Decides each tool call that is not auto-approved. Anything it denies is recorded by the caller.
   * It is async because AskUserQuestion waits, with no timeout, for the user to answer.
   */
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    context?: ToolCallContext,
  ) => Promise<PermissionDecision>;
}

export interface AgentRunner {
  /** Runs one turn of a session and yields its events until the turn ends. */
  run(params: RunParams): AsyncIterable<AgentEvent>;
}
