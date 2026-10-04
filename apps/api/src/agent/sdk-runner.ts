import { query, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALLOWED_TOOLS } from './permissions.js';
import type { AgentEvent, AgentRunner, RunParams } from './runner.js';

/**
 * Applies the panel's policy to every tool call before permission rules run. Without this, allow
 * rules from the user's settings (loaded through settingSources) would approve calls first and
 * canUseTool would never see them.
 */
export function createPreToolUseHook(decide: RunParams['canUseTool']): HookCallback {
  return (input) => {
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    const toolInput =
      typeof input.tool_input === 'object' && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const decision = decide(input.tool_name, toolInput);
    if (decision.behavior === 'allow') return Promise.resolve({});
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    });
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
        options: {
          cwd: params.cwd,
          settingSources: ['project', 'user'],
          permissionMode: 'acceptEdits',
          allowedTools: ALLOWED_TOOLS,
          abortController,
          ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
          hooks: { PreToolUse: [{ hooks: [createPreToolUseHook(params.canUseTool)] }] },
          canUseTool: (toolName, input) => Promise.resolve(params.canUseTool(toolName, input)),
        },
      });
      for await (const message of stream) yield toEvent(message);
    } finally {
      params.signal.removeEventListener('abort', abort);
    }
  }
}
