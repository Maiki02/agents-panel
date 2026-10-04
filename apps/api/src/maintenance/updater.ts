import { execFile } from 'node:child_process';
import type { Project } from '@agents-panel/shared';
import type { AgentManager } from '../agent/manager.js';
import type { KyroLock } from './lock.js';
import type { MaintenanceRunRepository } from './runs.js';
import type { KyroVersions } from './versions.js';

const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 8 * 1024 * 1024;
const VERSION_LINE_RE = /^KYRO_VERSION=(\S+)\s*$/m;

/** The update cannot start now (409): sessions are running or another update is in progress. */
export class UpdateBlockedError extends Error {
  override readonly name = 'UpdateBlockedError';
  readonly status = 409;
  constructor(
    message: string,
    readonly running: number | null,
  ) {
    super(message);
  }
}

export interface ScriptResult {
  exitCode: number;
  /** stdout + stderr. */
  output: string;
}

/** Runs `bash <script> <roots...>` (argv, no shell). Never rejects: failures are an exit code. */
export type ScriptRunner = (args: string[], timeoutMs: number) => Promise<ScriptResult>;

export const bashRunner: ScriptRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      'bash',
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!error) {
          resolve({ exitCode: 0, output });
          return;
        }
        const code = (error as { code?: unknown }).code;
        const note = (error as { killed?: boolean }).killed
          ? '\n[timeout: se cortó el script]'
          : '';
        resolve({ exitCode: typeof code === 'number' ? code : 1, output: output + note });
      },
    );
  });

export interface KyroUpdaterDeps {
  manager: Pick<AgentManager, 'tryBeginMaintenance' | 'endMaintenance'>;
  runs: MaintenanceRunRepository;
  versions: Pick<KyroVersions, 'installed'>;
  projects: { list(): Project[] };
  lock: KyroLock;
  scriptPath: string;
  runner?: ScriptRunner;
  timeoutMs?: number;
}

/** Runs scripts/vm/08-kyro-update.sh in the background while new sessions are blocked. */
export class KyroUpdater {
  private readonly runner: ScriptRunner;
  private readonly timeoutMs: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: KyroUpdaterDeps) {
    this.runner = deps.runner ?? bashRunner;
    this.timeoutMs = deps.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  }

  /** Resolves when every update in flight has finished (tests wait on this instead of sleeping). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Returns the run id right away; throws UpdateBlockedError (409) when it cannot start. */
  async start(): Promise<number> {
    const { manager, runs, versions } = this.deps;
    // Check and flag are one synchronous step: no session can start in between.
    const begin = manager.tryBeginMaintenance();
    if (!begin.ok) {
      throw 'running' in begin
        ? new UpdateBlockedError(
            `Hay ${String(begin.running)} sesiones corriendo; esperá a que terminen`,
            begin.running,
          )
        : new UpdateBlockedError('Ya hay una actualización en curso', null);
    }
    let runId: number;
    try {
      runId = runs.create(await versions.installed()).id;
    } catch (error) {
      manager.endMaintenance();
      throw error;
    }
    const job = this.execute(runId).finally(() => this.pending.delete(job));
    this.pending.add(job);
    return runId;
  }

  private async execute(runId: number): Promise<void> {
    const { manager, runs, versions, projects, lock, scriptPath } = this.deps;
    try {
      const roots = projects
        .list()
        .filter((project) => project.status === 'ready' && project.hasKyro)
        .map((project) => project.repoPath);
      // Waits for a `kyro install` in flight (project registration) before touching the runtime.
      const result = await lock.run(() => this.runner([scriptPath, ...roots], this.timeoutMs));
      // The version shown is the one measured afterwards, not the one asked for.
      const toVersion =
        (await versions.installed()) ?? VERSION_LINE_RE.exec(result.output)?.[1] ?? null;
      runs.finish(runId, {
        status: result.exitCode === 0 ? 'ok' : 'error',
        toVersion,
        output: result.output,
      });
    } catch (error) {
      try {
        runs.finish(runId, {
          status: 'error',
          toVersion: null,
          output: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The run stays 'running' and becomes 'interrumpido' at the next start; never leave a
        // rejected promise nobody awaits.
      }
    } finally {
      manager.endMaintenance();
    }
  }
}
