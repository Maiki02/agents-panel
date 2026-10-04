import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KyroVersionInfo } from '@agents-panel/shared';

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
  private latestCache: { value: string | null; at: number } | undefined;

  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly now: () => number = Date.now,
  ) {}

  async installed(): Promise<string | null> {
    return this.read('kyro', ['--version'], 5_000);
  }

  /** Unknown (null) with no network, a timeout or an odd answer: the update stays allowed. */
  async latest(): Promise<string | null> {
    // Cached briefly so repeated page loads do not each spawn `npm view` (up to 10 s).
    const cached = this.latestCache;
    if (cached && this.now() - cached.at < LATEST_TTL_MS) return cached.value;
    const value = await this.read('npm', ['view', 'kyro-ai', 'version'], 10_000);
    this.latestCache = { value, at: this.now() };
    return value;
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
