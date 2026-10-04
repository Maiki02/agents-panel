/** One thing the agent did or said, already reduced to what the panel persists. */
export interface AgentEvent {
  /** SDK message type, with the subtype appended when present (e.g. "system:init", "result:success"). */
  type: string;
  payload: unknown;
  /** Present on the SDK init message; stored so the chat can be resumed. */
  sessionId?: string;
}

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface RunParams {
  cwd: string;
  prompt: string;
  /** SDK session to continue; absent for the first turn. */
  resumeSessionId?: string;
  signal: AbortSignal;
  /** Decides each tool call that is not auto-approved. Anything it denies is recorded by the caller. */
  canUseTool: (toolName: string, input: Record<string, unknown>) => PermissionDecision;
}

export interface AgentRunner {
  /** Runs one turn of a session and yields its events until the turn ends. */
  run(params: RunParams): AsyncIterable<AgentEvent>;
}
