import type { PanelDeployInfo } from '@agents-panel/shared';
import type { AgentManager } from '../agent/manager.js';
import type { AutopilotRunRepository } from '../pilot/runs-repo.js';
import type { MaintenanceRunRepository } from './runs.js';
import { UpdateBlockedError, bashRunner, type ScriptRunner } from './updater.js';
import { SwrCell } from './swr.js';
import { defaultExec, type Exec } from './versions.js';

const SCRIPT_TIMEOUT_MS = 20 * 60 * 1000;
const FETCH_TTL_MS = 60_000;
const BRANCH = 'main';
const TO_RE = /^DEPLOY_TO=(\S+)\s*$/m;
const RESTART_RE = /^DEPLOY_RESTART=yes\s*$/m;

/** Exit code the panel leaves with to be restarted by systemd (Restart=on-failure) after a deploy. */
export const RESTART_EXIT_CODE = 75;

export const NOT_UNDER_SYSTEMD =
  'El panel no corre como servicio de systemd: no se puede reiniciar solo (paso 16 del runbook)';

export interface PanelDeployerDeps {
  manager: Pick<AgentManager, 'tryBeginMaintenance' | 'endMaintenance'>;
  runs: MaintenanceRunRepository;
  /** A pilot in its merge phase validates or opens a PR without a session: not cut by a restart. */
  pilots: Pick<AutopilotRunRepository, 'listByStatus'>;
  repoPath: string;
  scriptPath: string;
  /** Running under systemd; without it nobody would start the panel again. */
  selfDeploy: boolean;
  /** Closes the server and leaves with RESTART_EXIT_CODE; tests replace it. */
  restart: () => void;
  runner?: ScriptRunner;
  exec?: Exec;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Deploys the panel itself: runs scripts/vm/12-panel-deploy.sh (fast-forward of main + build)
 * while new sessions are blocked, keeps the run in maintenance_runs and, when the script built a
 * new commit, restarts the process through systemd. Never uses sudo.
 */
export class PanelDeployer {
  private readonly runner: ScriptRunner;
  private readonly exec: Exec;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly pending = new Set<Promise<void>>();
  private commit: string | null = null;
  private readonly behindCell: SwrCell<number | null>;
  private running = false;

  constructor(private readonly deps: PanelDeployerDeps) {
    this.runner = deps.runner ?? bashRunner;
    this.exec = deps.exec ?? defaultExec;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? SCRIPT_TIMEOUT_MS;
    // Stale-while-revalidate: the fetch (up to 15 s) refreshes in the background, not in a request.
    this.behindCell = new SwrCell(() => this.loadBehind(), FETCH_TTL_MS, this.now);
  }

  /** Reads the commit the server started from; called once at boot, so a later pull does not lie. */
  async init(): Promise<void> {
    this.commit = await this.git(['rev-parse', '--short', 'HEAD'], 5_000);
    // Warms the first value without waiting for it.
    this.behindCell.warm();
  }

  get deployRunning(): boolean {
    return this.running;
  }

  async info(): Promise<PanelDeployInfo> {
    return {
      commit: this.commit,
      behind: await this.behindCell.get(),
      deployRunning: this.running,
      unavailableReason: this.deps.selfDeploy ? null : NOT_UNDER_SYSTEMD,
    };
  }

  /** Resolves when every deploy in flight has finished (tests wait on this instead of sleeping). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Returns the run id right away; throws UpdateBlockedError (409) when it cannot start. */
  start(): number {
    const { manager, runs, pilots, selfDeploy } = this.deps;
    if (!selfDeploy) throw new UpdateBlockedError(NOT_UNDER_SYSTEMD, null);
    const merging = pilots.listByStatus('active').filter((run) => run.phase === 'merge').length;
    if (merging > 0) {
      throw new UpdateBlockedError(
        `Hay ${String(merging)} piloto(s) llevando un trabajo a su PR; esperá a que terminen`,
        null,
      );
    }
    const begin = manager.tryBeginMaintenance();
    if (!begin.ok) {
      throw 'running' in begin
        ? new UpdateBlockedError(
            `Hay ${String(begin.running)} sesiones corriendo; esperá a que terminen`,
            begin.running,
          )
        : new UpdateBlockedError('Ya hay una actualización o un despliegue en curso', null);
    }
    let runId: number;
    try {
      runId = runs.create(this.commit, 'panel-deploy').id;
    } catch (error) {
      manager.endMaintenance();
      throw error;
    }
    this.running = true;
    const job = this.execute(runId).finally(() => this.pending.delete(job));
    this.pending.add(job);
    return runId;
  }

  private async execute(runId: number): Promise<void> {
    const { manager, runs, repoPath, scriptPath } = this.deps;
    let restart = false;
    try {
      // The running commit, not the disk's: a `git pull` without a restart still needs a deploy.
      const args = [scriptPath, repoPath, ...(this.commit === null ? [] : [this.commit])];
      const result = await this.runner(args, this.timeoutMs);
      const ok = result.exitCode === 0;
      restart = ok && RESTART_RE.test(result.output);
      runs.finish(runId, {
        status: ok ? 'ok' : 'error',
        toVersion: TO_RE.exec(result.output)?.[1] ?? null,
        output: result.output,
      });
    } catch (error) {
      restart = false;
      try {
        runs.finish(runId, {
          status: 'error',
          toVersion: null,
          output: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Left 'running', it becomes 'interrumpido' at the next start.
      }
    } finally {
      this.running = false;
      this.behindCell.invalidate();
      // Sessions stay blocked until the process is gone: the new build is what starts them.
      if (restart) this.deps.restart();
      else manager.endMaintenance();
    }
  }

  /** Commits of origin/main the running server does not have (it fetches: slow, so cached). */
  private async loadBehind(): Promise<number | null> {
    if (this.commit === null) return null;
    await this.git(['fetch', '--quiet', 'origin', BRANCH], 15_000);
    const count = await this.git(
      ['rev-list', '--count', `${this.commit}..origin/${BRANCH}`],
      5_000,
    );
    return count !== null && /^\d+$/.test(count) ? Number(count) : null;
  }

  private async git(args: string[], timeoutMs: number): Promise<string | null> {
    try {
      return (await this.exec('git', ['-C', this.deps.repoPath, ...args], timeoutMs)).trim();
    } catch {
      return null;
    }
  }
}
