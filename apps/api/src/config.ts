import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** VAPID identity the panel signs Web Push messages with (secrets: only in the panel's .env). */
export interface PushVapid {
  readonly publicKey: string;
  readonly privateKey: string;
  /** `mailto:` or `https:` contact the push services may use. */
  readonly subject: string;
}

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
  /** The panel's own repo, the one the Deploy button brings `main` into. */
  readonly panelRepo: string;
  /** Script run by the panel deploy (scripts/vm/12-panel-deploy.sh of this repo by default). */
  readonly panelDeployScript: string;
  /** Running under systemd (INVOCATION_ID): only then can the panel restart itself after a deploy. */
  readonly selfDeploy: boolean;
  readonly origin: string;
  /** Every origin the browser may send on a state-changing request: `origin` plus the extras. */
  readonly allowedOrigins: readonly string[];
  /** Raw key bytes. Never log this object's secretKey. */
  readonly secretKey: Buffer;
  readonly sessionIdleTtlSeconds: number;
  readonly sessionAbsoluteTtlSeconds: number;
  /** Sessions the pilot may open for one sprint before it stops the work (R11). */
  readonly pilotMaxSessionsPerSprint: number;
  /** Longest a project's validate_command may run before the pilot stops it. */
  readonly pilotValidateTimeoutMs: number;
  /** Folder with the compiled web the API serves; null serves nothing (PANEL_WEB_DIR). */
  readonly webDir: string | null;
  /** null when the VAPID keys are not set: Web Push stays off and nothing is sent. */
  readonly pushVapid: PushVapid | null;
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

function loadVapid(env: Env): PushVapid | null {
  const publicKey = env['PUSH_VAPID_PUBLIC_KEY'] ?? '';
  const privateKey = env['PUSH_VAPID_PRIVATE_KEY'] ?? '';
  const subject = env['PUSH_VAPID_SUBJECT'] ?? '';
  if (publicKey === '' && privateKey === '') return null;
  if (publicKey === '' || privateKey === '') {
    throw new ConfigError('PUSH_VAPID_PUBLIC_KEY and PUSH_VAPID_PRIVATE_KEY go together');
  }
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    throw new ConfigError('PUSH_VAPID_SUBJECT must start with mailto: or https://');
  }
  return { publicKey, privateKey, subject };
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

  // Other URLs the same panel is reached by (the Funnel name next to the local tunnel).
  const extraOrigins = (env['PANEL_EXTRA_ORIGINS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
        return url.origin;
      } catch {
        throw new ConfigError('PANEL_EXTRA_ORIGINS must be a comma-separated list of http(s) URLs');
      }
    });

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

  const rawWebDir = env['PANEL_WEB_DIR'];
  const webDir = rawWebDir === undefined || rawWebDir === '' ? null : expandHome(rawWebDir);

  const rawScript = env['PANEL_KYRO_UPDATE_SCRIPT'];
  const kyroUpdateScript =
    rawScript === undefined || rawScript === ''
      ? fileURLToPath(new URL('../../../scripts/vm/08-kyro-update.sh', import.meta.url))
      : expandHome(rawScript);

  const rawDeploy = env['PANEL_DEPLOY_SCRIPT'];
  const panelDeployScript =
    rawDeploy === undefined || rawDeploy === ''
      ? fileURLToPath(new URL('../../../scripts/vm/12-panel-deploy.sh', import.meta.url))
      : expandHome(rawDeploy);

  return {
    dataDir,
    worktreesDir,
    projectsDir,
    minFreeDiskGb: positiveInt(env, 'PANEL_MIN_FREE_DISK_GB', 10),
    kyroUpdateScript,
    panelRepo: fileURLToPath(new URL('../../../', import.meta.url)),
    panelDeployScript,
    selfDeploy: (env['INVOCATION_ID'] ?? '') !== '',
    webDir,
    origin,
    allowedOrigins: [...new Set([origin, ...extraOrigins])],
    secretKey,
    sessionIdleTtlSeconds: positiveInt(env, 'PANEL_SESSION_IDLE_TTL_SECONDS', 30 * 60),
    sessionAbsoluteTtlSeconds: positiveInt(env, 'PANEL_SESSION_ABSOLUTE_TTL_SECONDS', 12 * 60 * 60),
    pilotMaxSessionsPerSprint: positiveInt(env, 'PILOT_MAX_SESSIONS_PER_SPRINT', 6),
    pilotValidateTimeoutMs: positiveInt(env, 'PILOT_VALIDATE_TIMEOUT_MINUTES', 15) * 60 * 1000,
    pushVapid: loadVapid(env),
  };
}
