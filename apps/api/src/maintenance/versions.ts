import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KyroVersionInfo } from '@agents-panel/shared';

import { SwrCell } from './swr.js';

const execFileAsync = promisify(execFile);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Runs a command (argv, no shell) and returns its stdout. Injectable for tests. */
export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const defaultExec: Exec = async (file, args, timeoutMs) => {
  const { stdout } = await execFileAsync(file, args, { timeout: timeoutMs });
  return stdout;
};

/** First line of the output when it is a semver version; null otherwise. */
export function parseVersion(output: string): string | null {
  const line = output.trim().split('\n').at(-1)?.trim() ?? '';
  return SEMVER_RE.test(line) ? line : null;
}

const LATEST_TTL_MS = 60_000;

export class KyroVersions {
  private readonly installedCell: SwrCell<string | null>;
  private readonly latestCell: SwrCell<string | null>;

  constructor(
    private readonly exec: Exec = defaultExec,
    now: () => number = Date.now,
  ) {
    // The installed version only changes with a Kyro update (the updater invalidates it): the TTL
    // is effectively infinite, so `kyro --version` is not spawned on every page load.
    this.installedCell = new SwrCell(
      () => this.read('kyro', ['--version'], 5_000),
      Number.POSITIVE_INFINITY,
      now,
    );
    // Stale-while-revalidate: with a previous value the answer is immediate and `npm view` (up to
    // 10 s) refreshes in the background, once at a time.
    this.latestCell = new SwrCell(
      () => this.read('npm', ['view', 'kyro-ai', 'version'], 10_000),
      LATEST_TTL_MS,
      now,
    );
  }

  installed(): Promise<string | null> {
    return this.installedCell.get();
  }

  /** Forgets the cached installed version; the next read measures it again. */
  invalidateInstalled(): void {
    this.installedCell.invalidate();
  }

  /** Unknown (null) with no network, a timeout or an odd answer: the update stays allowed. */
  latest(): Promise<string | null> {
    return this.latestCell.get();
  }

  /** Loads both values without waiting (service start), so the first page load already has them. */
  warm(): void {
    this.installedCell.warm();
    this.latestCell.warm();
  }

  async info(): Promise<KyroVersionInfo> {
    const [installed, latest] = await Promise.all([this.installed(), this.latest()]);
    return { installed, latest };
  }

  private async read(file: string, args: string[], timeoutMs: number): Promise<string | null> {
    try {
      return parseVersion(await this.exec(file, args, timeoutMs));
    } catch {
      return null;
    }
  }
}
