import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { Project } from '@agents-panel/shared';
import type { AgentManager } from '../agent/manager.js';
import { commitKyroToBase, type KyroCommitOutcome, type KyroCommitter } from './kyro-commit.js';
import type { KyroLock } from './lock.js';
import { skippedRoots, type MaintenanceRunRepository } from './runs.js';
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
  versions: Pick<KyroVersions, 'installed'> & Partial<Pick<KyroVersions, 'invalidateInstalled'>>;
  projects: { list(): Project[] };
  /** Called when the update finished (ok or not): `kyro update` rewrites project.json in clones. */
  onFinished?: () => void;
  lock: KyroLock;
  scriptPath: string;
  runner?: ScriptRunner;
  /** Commits `.agents/kyro/` to the base branch of each clone; tests replace it. */
  committer?: KyroCommitter;
  timeoutMs?: number;
}

/** Runs scripts/vm/08-kyro-update.sh in the background while new sessions are blocked. */
export class KyroUpdater {
  private readonly runner: ScriptRunner;
  private readonly committer: KyroCommitter;
  private readonly timeoutMs: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: KyroUpdaterDeps) {
    this.runner = deps.runner ?? bashRunner;
    this.committer = deps.committer ?? commitKyroToBase;
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

  /**
   * Commits and pushes, project by project, what the update left in `.agents/kyro/` of each base
   * clone (no branch, no PR: user decision). Skipped roots are left alone; a failure never stops
   * the rest. Returns the output lines to append and whether every project went well.
   */
  private async commitAll(
    targets: Project[],
    result: ScriptResult,
    version: string | null,
  ): Promise<{ ok: boolean; lines: string }> {
    const skipped = new Set(skippedRoots(result.output).map((root) => resolve(root)));
    let ok = true;
    let lines = '';
    for (const project of targets) {
      if (skipped.has(resolve(project.repoPath))) continue;
      let outcome: KyroCommitOutcome;
      try {
        outcome = await this.committer(project, version);
      } catch (error) {
        outcome = {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (outcome.status === 'committed') {
        lines += `KYRO_COMMITTED=${project.repoPath} ${outcome.commit.slice(0, 7)}\n`;
      } else if (outcome.status === 'failed') {
        ok = false;
        lines += `KYRO_COMMIT_FAILED=${project.repoPath}: ${outcome.reason.replace(/\s+/g, ' ')}\n`;
      }
    }
    const header = '== commit de .agents/kyro/ en la rama base\n';
    return { ok, lines: lines === '' ? '' : header + lines };
  }

  private async execute(runId: number): Promise<void> {
    const { manager, runs, versions, projects, lock, scriptPath } = this.deps;
    try {
      const targets = projects
        .list()
        .filter((project) => project.status === 'ready' && project.hasKyro);
      const roots = targets.map((project) => project.repoPath);
      // Waits for a `kyro install` in flight (project registration) before touching the runtime.
      const result = await lock.run(() => this.runner([scriptPath, ...roots], this.timeoutMs));
      // The cached version is stale now: forget it so this read and the next page load measure it.
      versions.invalidateInstalled?.();
      // The version shown is the one measured afterwards, not the one asked for.
      const toVersion =
        (await versions.installed()) ?? VERSION_LINE_RE.exec(result.output)?.[1] ?? null;
      // A failed script may have left a half-synced workspace: nothing is committed then.
      const commits =
        result.exitCode === 0 ? await this.commitAll(targets, result, toVersion) : null;
      runs.finish(runId, {
        status: result.exitCode === 0 && commits?.ok !== false ? 'ok' : 'error',
        toVersion,
        output: result.output + (commits?.lines ?? ''),
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
      // Also on failure: the script may have changed the version or the clones before failing.
      versions.invalidateInstalled?.();
      this.deps.onFinished?.();
      manager.endMaintenance();
    }
  }
}
