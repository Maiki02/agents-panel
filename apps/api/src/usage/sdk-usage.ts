import { query } from '@anthropic-ai/claude-agent-sdk';
import { accountEnv } from '../agent/sdk-runner.js';

/** One window of the SDK's usage answer (`rate_limits.five_hour`, ...). */
export interface RawUsageWindow {
  /** 0-100. */
  utilization?: number | null;
  /** ISO 8601. */
  resets_at?: string | null;
}

/** The part of `SDKControlGetUsageResponse` the panel reads. */
export interface RawUsage {
  rate_limits_available: boolean;
  rate_limits: Record<string, RawUsageWindow | null | undefined> | null;
}

export interface UsageReadParams {
  /** CLAUDE_CONFIG_DIR of the account; null is the default account (variable removed). */
  configDir: string | null;
  /** Aborted when the reading takes too long: the reader must close its session. */
  signal: AbortSignal;
}

/** Reads the plan usage of one account; tests inject a fake so no process is launched. */
export type UsageReader = (params: UsageReadParams) => Promise<RawUsage>;

/** What the reader needs from an SDK session (a subset of `Query`). */
export interface UsageSession {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(opts?: {
    skipBehaviors?: boolean;
  }): Promise<unknown>;
  interrupt(): Promise<unknown>;
  close(): void;
}

/** Opens an SDK session; production uses `query`, tests a fake. */
export type UsageSessionOpener = (params: {
  prompt: AsyncIterable<never>;
  options: { env: Record<string, string | undefined>; abortController: AbortController };
}) => UsageSession;

const INTERRUPT_GRACE_MS = 2000;

/** An input stream that never produces a message: the session starts but no prompt is sent. */
function noPrompt(signal: AbortSignal): AsyncIterable<never> {
  const ended = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
  });
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => ended.then(() => ({ done: true as const, value: undefined })),
    }),
  };
}

const openWithSdk: UsageSessionOpener = ({ prompt, options }) =>
  query({
    prompt,
    options: { ...options, settingSources: [], permissionMode: 'default' },
  });

/**
 * Opens a short SDK session without a prompt, asks for the usage (experimental call: its name may
 * change) and always closes the session, also when the call fails or the reading is aborted.
 * Permissions stay on: the session never runs a tool.
 */
export function createUsageReader(open: UsageSessionOpener = openWithSdk): UsageReader {
  return async ({ configDir, signal }) => {
    const abortController = new AbortController();
    const input = new AbortController();
    const stop = () => {
      input.abort();
      abortController.abort();
    };
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    const session = open({
      prompt: noPrompt(input.signal),
      options: { env: accountEnv(configDir), abortController },
    });
    try {
      return (await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      })) as RawUsage;
    } finally {
      signal.removeEventListener('abort', stop);
      input.abort();
      let grace: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          session.interrupt(),
          new Promise((resolve) => {
            grace = setTimeout(resolve, INTERRUPT_GRACE_MS);
          }),
        ]);
      } catch {
        // The session may have no turn to interrupt: closing it is what matters.
      } finally {
        clearTimeout(grace);
        session.close();
      }
    }
  };
}

export const readUsageWithSdk: UsageReader = createUsageReader();
