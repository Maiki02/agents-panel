import {
  query,
  type HookCallback,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ALLOWED_TOOLS } from './permissions.js';
import { ASK_USER_QUESTION, type AgentEvent, type AgentRunner, type RunParams } from './runner.js';

/**
 * Applies the panel's policy to every tool call before permission rules run. Without this, allow
 * rules from the user's settings (loaded through settingSources) would approve calls first and
 * canUseTool would never see them.
 */
export function createPreToolUseHook(decide: RunParams['canUseTool']): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    // AskUserQuestion goes on to canUseTool, which waits for the user's answer and returns it as
    // updatedInput. Deciding here too would ask the user twice.
    if (input.tool_name === ASK_USER_QUESTION) return {};
    const toolInput =
      typeof input.tool_input === 'object' && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const decision = await decide(input.tool_name, toolInput, { toolUseId: input.tool_use_id });
    if (decision.behavior === 'allow') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    };
  };
}

function toEvent(message: SDKMessage): AgentEvent {
  const subtype =
    'subtype' in message && typeof message.subtype === 'string' ? message.subtype : '';
  const event: AgentEvent = {
    type: subtype ? `${message.type}:${subtype}` : message.type,
    payload: message,
  };
  if (message.type === 'system' && subtype === 'init' && 'session_id' in message) {
    event.sessionId = message.session_id;
  }
  return event;
}

/**
 * Environment of the Claude Code process: the API's own, with CLAUDE_CONFIG_DIR set to the
 * account's directory or removed for the default account. Setting it to ~/.claude would not be the
 * same: Claude Code would look for .claude.json inside the directory instead of ~/.claude.json.
 */
export function accountEnv(
  configDir: string | null | undefined,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env['CLAUDE_CONFIG_DIR'];
  if (configDir) env['CLAUDE_CONFIG_DIR'] = configDir;
  return env;
}

/**
 * SDK options for one turn. Pure so it can be tested: permissions stay on (acceptEdits plus an
 * allowlist) and no mode that skips permission checks is ever an option.
 */
export function buildQueryOptions(params: RunParams, abortController: AbortController): Options {
  return {
    cwd: params.cwd,
    model: params.model,
    env: accountEnv(params.configDir),
    settingSources: ['project', 'user'],
    permissionMode: 'acceptEdits',
    allowedTools: ALLOWED_TOOLS,
    abortController,
    ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
    hooks: { PreToolUse: [{ hooks: [createPreToolUseHook(params.canUseTool)] }] },
    canUseTool: (toolName, input, { toolUseID }) =>
      params.canUseTool(toolName, input, { toolUseId: toolUseID }),
  };
}

/**
 * Runs the Claude Agent SDK with cwd in the chat's worktree. Permissions stay on:
 * acceptEdits plus an allowlist; there is no bypass mode anywhere in this codebase.
 */
export class SdkRunner implements AgentRunner {
  async *run(params: RunParams): AsyncGenerator<AgentEvent> {
    const abortController = new AbortController();
    const abort = () => {
      abortController.abort();
    };
    if (params.signal.aborted) abort();
    params.signal.addEventListener('abort', abort, { once: true });

    try {
      const stream = query({
        prompt: params.prompt,
        options: buildQueryOptions(params, abortController),
      });
      for await (const message of stream) yield toEvent(message);
    } finally {
      params.signal.removeEventListener('abort', abort);
    }
  }
}
