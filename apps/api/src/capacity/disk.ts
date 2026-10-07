import { execFile } from 'node:child_process';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DiskProjectUsage, DiskStrayUsage, DiskTotals, DiskUsage } from '@agents-panel/shared';

const execFileAsync = promisify(execFile);

/** Measures the bytes a folder uses on disk. Rejects when it cannot (ENOENT keeps its `code`). */
export type DiskMeter = (path: string) => Promise<number>;

/** Total and free bytes of the filesystem that holds `path`. */
export type FsStats = (path: string) => Promise<{ totalBytes: number; freeBytes: number }>;

const DU_TIMEOUT_MS = 5 * 60 * 1000;
const INTERVAL_MS = 10 * 60 * 1000;

/**
 * Default meter: `du -sx --block-size=1` through execFile (no shell). `du` never follows symlinks
 * (a link counts as the link itself) and `-x` stays on one filesystem. Any failure, even a partial
 * one (a subfolder it could not read), rejects: the item is reported as "sin dato".
 */
export const duMeter: DiskMeter = async (path) => {
  await lstat(path); // ENOENT surfaces with its code, so the caller can tell "absent" from "unreadable"
  const { stdout } = await execFileAsync('du', ['-sx', '--block-size=1', '--', path], {
    timeout: DU_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const bytes = Number(stdout.split('\t')[0]);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('du returned an unexpected output');
  return bytes;
};

export const statfsStats: FsStats = async (path) => {
  const stats = await statfs(path);
  return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
};

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Called when something that changes disk use happened (a worktree or a project was created or
 * deleted). The running monitor re-measures; with no monitor it does nothing.
 */
export function notifyDiskChanged(): void {
  for (const listener of [...listeners]) listener();
}

export interface DiskMonitorDeps {
  /** Registered projects: name and where the clone lives. */
  projects: () => readonly { name: string; repoPath: string }[];
  projectsDir: string;
  worktreesDir: string;
  meter?: DiskMeter;
  fsStats?: FsStats;
  now?: () => number;
  /** Where per-item failures go (the absolute path stays in the log, never in the response). */
  log?: (message: string) => void;
  intervalMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * Measures disk use in the background. The last result lives in memory: it is derived data that a
 * restart recomputes on startup, so it needs no table (and can never be stale across restarts).
 * One measurement at a time; reading never waits for `du`.
 */
export class DiskMonitor {
  private readonly meter: DiskMeter;
  private readonly fsStats: FsStats;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly intervalMs: number;
  private last: Omit<DiskUsage, 'measuring'> | null = null;
  private current: Promise<void> | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly listener: Listener = () => {
    this.trigger();
  };

  constructor(private readonly deps: DiskMonitorDeps) {
    this.meter = deps.meter ?? duMeter;
    this.fsStats = deps.fsStats ?? statfsStats;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.intervalMs = deps.intervalMs ?? INTERVAL_MS;
  }

  /** First measurement now, then every interval, and again on every disk-changing event. */
  start(): void {
    if (this.timer) return;
    listeners.add(this.listener);
    this.timer = setInterval(() => {
      this.refresh();
    }, this.intervalMs);
    this.timer.unref();
    this.refresh();
  }

  stop(): void {
    listeners.delete(this.listener);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get measuring(): boolean {
    return this.current !== null;
  }

  /** The last result; never waits. Before the first measurement: measuring, with no numbers. */
  get(): DiskUsage {
    if (!this.last) {
      return { measuring: true, measuredAt: null, totals: null, projects: [], strays: [] };
    }
    return { ...this.last, measuring: this.measuring };
  }

  /** Starts a measurement unless one is running. Returns whether it started one. */
  refresh(): boolean {
    if (this.current) return false;
    this.current = this.measure()
      .catch((error: unknown) => {
        this.log(`disk measurement failed: ${error instanceof Error ? error.message : 'unknown'}`);
      })
      .finally(() => {
        this.current = null;
        if (this.dirty) {
          this.dirty = false;
          this.refresh();
        }
      });
    return true;
  }

  /** An event changed the disk: measure again, or once more after the one in flight. */
  private trigger(): void {
    if (!this.refresh()) this.dirty = true;
  }

  /** Resolves when no measurement is running (tests wait on this instead of sleeping). */
  async whenIdle(): Promise<void> {
    while (this.current) await this.current;
  }

  private async measureItem(path: string, label: string): Promise<number | null> {
    try {
      return await this.meter(path);
    } catch (error) {
      this.log(`disk: cannot measure ${label} (${path}): ${(error as Error).message}`);
      return null;
    }
  }

  private async measure(): Promise<void> {
    const { projectsDir, worktreesDir } = this.deps;
    const registered = this.deps.projects();
    const projects: DiskProjectUsage[] = [];
    for (const project of registered) {
      const repositoryBytes = await this.measureItem(project.repoPath, `repo of ${project.name}`);
      let worktreesBytes: number | null;
      try {
        worktreesBytes = await this.meter(resolve(worktreesDir, project.name));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') worktreesBytes = 0;
        else {
          this.log(
            `disk: cannot measure worktrees of ${project.name}: ${(error as Error).message}`,
          );
          worktreesBytes = null;
        }
      }
      projects.push({ name: project.name, repositoryBytes, worktreesBytes });
    }

    const repoPaths = new Set(registered.map((project) => resolve(project.repoPath)));
    const names = new Set(registered.map((project) => project.name));
    const strays: DiskStrayUsage[] = [];
    for (const name of await entries(projectsDir)) {
      const path = resolve(projectsDir, name);
      if (repoPaths.has(path)) continue;
      strays.push({
        name,
        area: 'proyectos',
        bytes: await this.measureItem(path, `folder ${name}`),
      });
    }
    for (const name of await entries(worktreesDir)) {
      if (names.has(name)) continue;
      const path = resolve(worktreesDir, name);
      strays.push({
        name,
        area: 'worktrees',
        bytes: await this.measureItem(path, `folder ${name}`),
      });
    }

    let totals: DiskTotals | null = null;
    try {
      const fsInfo = await this.fsStats(projectsDir).catch(() => this.fsStats(worktreesDir));
      totals = this.totalsOf(fsInfo.totalBytes, fsInfo.freeBytes, projects, strays);
    } catch (error) {
      this.log(`disk: statfs failed: ${(error as Error).message}`);
    }
    this.last = { measuredAt: this.now(), totals, projects, strays };
  }

  /**
   * Projects + Worktrees + Otros + Libre always add up to the total. Otros is the rest of the used
   * space and never goes negative: if the folders add up to more than the used space (sparse files,
   * hard links), Worktrees and then Projects are capped so the sum still holds.
   */
  private totalsOf(
    totalBytes: number,
    freeBytes: number,
    projects: readonly DiskProjectUsage[],
    strays: readonly DiskStrayUsage[],
  ): DiskTotals {
    const used = Math.max(0, totalBytes - freeBytes);
    let projectsBytes = 0;
    let worktreesBytes = 0;
    for (const project of projects) {
      projectsBytes += project.repositoryBytes ?? 0;
      worktreesBytes += project.worktreesBytes ?? 0;
    }
    for (const stray of strays) {
      if (stray.area === 'proyectos') projectsBytes += stray.bytes ?? 0;
      else worktreesBytes += stray.bytes ?? 0;
    }
    projectsBytes = Math.min(projectsBytes, used);
    worktreesBytes = Math.min(worktreesBytes, used - projectsBytes);
    return {
      totalBytes: used + Math.min(freeBytes, totalBytes),
      projectsBytes,
      worktreesBytes,
      otherBytes: used - projectsBytes - worktreesBytes,
      freeBytes: Math.min(freeBytes, totalBytes),
    };
  }
}
