import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  readonly dataDir: string;
  /** Root under which worktrees are created: <root>/<project>/<slug>. */
  readonly worktreesDir: string;
  /** Directory where GitHub projects are cloned: <root>/<project>. */
  readonly projectsDir: string;
  /** Cloning is refused when the disk has less free space than this (GB). */
  readonly minFreeDiskGb: number;
  /** Script run by the Kyro update (scripts/vm/08-kyro-update.sh of this repo by default). */
  readonly kyroUpdateScript: string;
  readonly origin: string;
  /** Raw key bytes. Never log this object's secretKey. */
  readonly secretKey: Buffer;
  readonly sessionIdleTtlSeconds: number;
  readonly sessionAbsoluteTtlSeconds: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

const MIN_SECRET_BYTES = 32;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return value;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/** Reads and validates the environment. Error messages never include secret values. */
export function loadConfig(env: Env = process.env): Config {
  const rawKey = env['PANEL_SECRET_KEY'];
  if (rawKey === undefined || rawKey === '') {
    throw new ConfigError('PANEL_SECRET_KEY is required (at least 32 bytes)');
  }
  const secretKey = Buffer.from(rawKey, 'utf8');
  if (secretKey.length < MIN_SECRET_BYTES) {
    throw new ConfigError(`PANEL_SECRET_KEY must be at least ${String(MIN_SECRET_BYTES)} bytes`);
  }

  const rawOrigin = env['PANEL_ORIGIN'];
  if (rawOrigin === undefined || rawOrigin === '') {
    throw new ConfigError('PANEL_ORIGIN is required (e.g. https://host.ts.net)');
  }
  let origin: string;
  try {
    origin = new URL(rawOrigin).origin;
  } catch {
    throw new ConfigError('PANEL_ORIGIN must be a valid URL');
  }

  const rawDataDir = env['PANEL_DATA_DIR'];
  const dataDir = expandHome(
    rawDataDir === undefined || rawDataDir === '' ? '~/.local/share/agents-panel' : rawDataDir,
  );

  const rawWorktrees = env['PANEL_WORKTREES_DIR'];
  const worktreesDir = expandHome(
    rawWorktrees === undefined || rawWorktrees === '' ? '~/wt' : rawWorktrees,
  );

  const rawProjects = env['PANEL_PROJECTS_DIR'];
  const projectsDir = expandHome(
    rawProjects === undefined || rawProjects === '' ? '~/proyectos' : rawProjects,
  );

  const rawScript = env['PANEL_KYRO_UPDATE_SCRIPT'];
  const kyroUpdateScript =
    rawScript === undefined || rawScript === ''
      ? fileURLToPath(new URL('../../../scripts/vm/08-kyro-update.sh', import.meta.url))
      : expandHome(rawScript);

  return {
    dataDir,
    worktreesDir,
    projectsDir,
    minFreeDiskGb: positiveInt(env, 'PANEL_MIN_FREE_DISK_GB', 10),
    kyroUpdateScript,
    origin,
    secretKey,
    sessionIdleTtlSeconds: positiveInt(env, 'PANEL_SESSION_IDLE_TTL_SECONDS', 30 * 60),
    sessionAbsoluteTtlSeconds: positiveInt(env, 'PANEL_SESSION_ABSOLUTE_TTL_SECONDS', 12 * 60 * 60),
  };
}
