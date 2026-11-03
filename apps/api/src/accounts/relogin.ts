import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import type { ClaudeAccount } from '@agents-panel/shared';
import { AccountError, type AccountService } from './service.js';

/**
 * Re-login of a Claude account from the web. The panel runs `claude auth login` on the VM with the
 * account's `CLAUDE_CONFIG_DIR`, hands the user the authorization link, receives the code the
 * browser shows and types it into the process. The flow lives only in memory: one per account, with
 * a time limit. The link's code is never logged, stored or returned, and the credentials files are
 * only ever written by `claude` itself.
 */

/** The login process, reduced to what the flow needs (a fake one stands in for it in tests). */
export interface ReloginProcess {
  onOutput(listener: (text: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  write(text: string): void;
  kill(): void;
}

/** Starts the login with this environment (`CLAUDE_CONFIG_DIR` already decided by the caller). */
export type ReloginSpawner = (env: Record<string, string>) => ReloginProcess;

/** Real spawner: `claude auth login` with a minimal environment and no inherited secrets. */
export function claudeLoginSpawner(bin = 'claude'): ReloginSpawner {
  return (env) => {
    const child = spawn(bin, ['auth', 'login'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    return {
      onOutput(listener) {
        child.stdout.on('data', (chunk: Buffer) => {
          listener(chunk.toString('utf8'));
        });
        child.stderr.on('data', (chunk: Buffer) => {
          listener(chunk.toString('utf8'));
        });
      },
      onExit(listener) {
        child.on('close', (code) => {
          listener(code);
        });
        child.on('error', () => {
          listener(null);
        });
      },
      write(text) {
        child.stdin.write(text);
      },
      kill() {
        child.kill('SIGTERM');
      },
    };
  };
}

export interface ReloginTimings {
  /** Time to get the link out of the process. */
  startMs: number;
  /** Time for `claude` to confirm the login after the code was typed. */
  finishMs: number;
  /** Total life of a flow, whatever happens. */
  flowMs: number;
}

const DEFAULT_TIMINGS: ReloginTimings = {
  startMs: 30_000,
  finishMs: 30_000,
  flowMs: 10 * 60_000,
};

/** The authorization link only counts when it points at Claude or Anthropic. */
const LINK_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];
const LINK_RE = /https:\/\/[^\s"'<>]+/g;
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
/** What the browser shows after authorizing: letters, digits and a few separators. */
const CODE_RE = /^[A-Za-z0-9._~+/=#:-]{6,512}$/;
const MAX_BUFFER = 16_384;

function trustedLink(text: string): string | null {
  for (const match of text.matchAll(LINK_RE)) {
    const link = match[0];
    try {
      const host = new URL(link).hostname;
      if (LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
        return link;
      }
    } catch {
      // Not a URL: keep looking.
    }
  }
  return null;
}

interface Flow {
  proc: ReloginProcess;
  state: 'starting' | 'awaiting_code' | 'finishing';
  startedAt: number;
  credentialsFile: string;
  buffer: string;
  url: string | null;
  exit: { code: number | null } | null;
  urlWaiter: { resolve: (url: string) => void; reject: (error: AccountError) => void } | null;
  exitWaiter: (() => void) | null;
  ttl: ReturnType<typeof setTimeout>;
}

export class ReloginService {
  private readonly flows = new Map<number, Flow>();
  private readonly timings: ReloginTimings;

  constructor(
    private readonly accounts: AccountService,
    private readonly options: {
      spawner?: ReloginSpawner;
      timings?: Partial<ReloginTimings>;
      /** Base environment of the process (PATH, HOME…); defaults to the panel's own. */
      baseEnv?: NodeJS.ProcessEnv;
      now?: () => number;
    } = {},
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  /** Minimal environment: no secrets of the panel travel to the login process. */
  private envFor(configDir: string | null): Record<string, string> {
    const base = this.options.baseEnv ?? process.env;
    const env: Record<string, string> = { NO_COLOR: '1', TERM: 'dumb' };
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
      const value = base[key];
      if (value !== undefined) env[key] = value;
    }
    if (configDir !== null) env['CLAUDE_CONFIG_DIR'] = configDir;
    return env;
  }

  /** Starts the login and returns the authorization link for the user to open. */
  async start(accountId: number): Promise<{ url: string }> {
    const target = this.accounts.loginTarget(accountId);
    if (this.flows.has(accountId)) {
      throw new AccountError(409, 'Ya hay un relogueo en curso para esa cuenta');
    }
    const spawner = this.options.spawner ?? claudeLoginSpawner();
    const proc = spawner(this.envFor(target.configDir));
    const flow: Flow = {
      proc,
      state: 'starting',
      startedAt: (this.options.now ?? Date.now)(),
      credentialsFile: target.credentialsFile,
      buffer: '',
      url: null,
      exit: null,
      urlWaiter: null,
      exitWaiter: null,
      ttl: setTimeout(() => {
        this.drop(accountId);
      }, this.timings.flowMs),
    };
    flow.ttl.unref();
    this.flows.set(accountId, flow);

    proc.onOutput((text) => {
      if (flow.url !== null) return;
      flow.buffer = (flow.buffer + text.replace(ANSI_RE, '')).slice(-MAX_BUFFER);
      const link = trustedLink(flow.buffer);
      if (link === null) return;
      flow.url = link;
      flow.buffer = '';
      flow.state = 'awaiting_code';
      flow.urlWaiter?.resolve(link);
      flow.urlWaiter = null;
    });
    proc.onExit((code) => {
      flow.exit = { code };
      flow.urlWaiter?.reject(
        new AccountError(502, 'El login de Claude terminó sin dar el link de autorización'),
      );
      flow.urlWaiter = null;
      flow.exitWaiter?.();
      flow.exitWaiter = null;
      // A process that died while the user was still to type the code leaves nothing to finish.
      if (flow.state !== 'finishing') this.drop(accountId);
    });

    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        flow.urlWaiter = null;
        reject(new AccountError(502, 'El login de Claude no dio el link a tiempo'));
      }, this.timings.startMs);
      timer.unref();
      flow.urlWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    }).catch((error: unknown) => {
      this.drop(accountId);
      throw error;
    });
    return { url };
  }

  /** Types the code the browser showed and waits for `claude` to confirm; returns the account. */
  async submitCode(accountId: number, rawCode: string): Promise<ClaudeAccount> {
    const flow = this.flows.get(accountId);
    if (flow === undefined) {
      throw new AccountError(404, 'No hay un relogueo en curso: empezá de nuevo');
    }
    if (flow.state !== 'awaiting_code') {
      throw new AccountError(409, 'El relogueo todavía no está esperando el código');
    }
    const code = rawCode.trim();
    if (!CODE_RE.test(code)) {
      throw new AccountError(400, 'El código no tiene el formato que muestra Claude');
    }
    flow.state = 'finishing';
    flow.proc.write(`${code}\n`);

    if (flow.exit === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.timings.finishMs);
        timer.unref();
        flow.exitWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const exit = flow.exit;
    this.drop(accountId);
    if (exit === null) {
      throw new AccountError(502, 'Claude no confirmó el login a tiempo; empezá de nuevo');
    }
    if (exit.code !== 0 || !this.credentialsWritten(flow)) {
      throw new AccountError(
        400,
        'Claude no aceptó el código; pedí un link nuevo y probá otra vez',
      );
    }
    return this.accounts.view(accountId);
  }

  /** Drops the flow of an account and stops its process. Safe when there is none. */
  cancel(accountId: number): void {
    this.drop(accountId);
  }

  /** Stops every flow (the server is closing). */
  closeAll(): void {
    for (const id of [...this.flows.keys()]) this.drop(id);
  }

  /** The credentials file was written by this login, not left from before. */
  private credentialsWritten(flow: Flow): boolean {
    try {
      return statSync(flow.credentialsFile).mtimeMs >= flow.startedAt - 1000;
    } catch {
      return false;
    }
  }

  private drop(accountId: number): void {
    const flow = this.flows.get(accountId);
    if (flow === undefined) return;
    this.flows.delete(accountId);
    clearTimeout(flow.ttl);
    flow.buffer = '';
    if (flow.exit === null) flow.proc.kill();
  }
}
