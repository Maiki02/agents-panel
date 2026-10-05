import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  KyroStateError,
  parseAnalyzeFindings,
  parseCapabilities,
  parseScopeState,
  parseScopeTaskContext,
  parseWorkState,
  parseWorkTaskContext,
  type AnalyzeFinding,
  type KyroScopeState,
  type KyroTaskContext,
  type KyroWorkState,
} from './state.js';

const execFileAsync = promisify(execFile);

/** Runs a command with argv (no shell) and resolves with its stdout; rejects when it fails. */
export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<string>;

export const execRunner: CommandRunner = async (file, args, { cwd, timeoutMs }) => {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

export const KYRO_READ_TIMEOUT_MS = 30_000;

/** Why a read failed: the CLI could not run, printed something unexpected, or the worktree has no Kyro target. */
export interface KyroReadError {
  kind: 'cli_failed' | 'unexpected_output' | 'no_target';
  message: string;
}

export type KyroReadResult<T> = { ok: true; state: T } | { ok: false; error: KyroReadError };

function fail<T>(kind: KyroReadError['kind'], message: string): KyroReadResult<T> {
  return { ok: false, error: { kind, message } };
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the Kyro state of one worktree through the CLI. Never throws: failures are returned. */
export class KyroReader {
  constructor(
    private readonly run: CommandRunner = execRunner,
    private readonly timeoutMs: number = KYRO_READ_TIMEOUT_MS,
    private readonly bin = 'kyro',
  ) {}

  /**
   * Scope of the worktree: `activeScope` in `.agents/kyro/local.json`. context-pack and status are
   * read together; when they disagree the state moved between the two calls, so it reads once more.
   */
  async readScope(cwd: string): Promise<KyroReadResult<KyroScopeState>> {
    let scope: string;
    let artifactRoot = join('.agents', 'kyro', 'scopes');
    try {
      const local = await readJsonFile(join(cwd, '.agents', 'kyro', 'local.json'));
      const active = isRecord(local) ? local['activeScope'] : undefined;
      if (typeof active !== 'string' || active === '') {
        return fail('no_target', 'local.json no tiene un scope activo');
      }
      scope = active;
    } catch {
      return fail('no_target', 'No se pudo leer .agents/kyro/local.json del worktree');
    }
    try {
      const project = await readJsonFile(join(cwd, '.agents', 'kyro', 'project.json'));
      const root = isRecord(project) ? project['artifactRoot'] : undefined;
      if (typeof root === 'string' && root !== '') artifactRoot = root;
    } catch {
      // The default artifact root applies.
    }

    let lastError: KyroReadError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [pack, status, sprint] = await Promise.all([
          this.json(cwd, ['context-pack', '--kyro-scope', scope, '--json']),
          this.json(cwd, ['status', 'full', '--kyro-scope', scope, '--json']),
          readJsonFile(join(cwd, artifactRoot, scope, 'sprint.json')),
        ]);
        return { ok: true, state: parseScopeState(pack, status, sprint) };
      } catch (error) {
        const failure = this.toError(error);
        // Only a disagreement between the two reads is worth another try.
        if (failure.kind !== 'unexpected_output' || !failure.message.includes('says nextAction')) {
          return { ok: false, error: failure };
        }
        lastError = failure;
      }
    }
    return { ok: false, error: lastError ?? { kind: 'unexpected_output', message: 'unknown' } };
  }

  /**
   * Work of the worktree: `work` when given, otherwise the only folder under `.agents/kyro/work`
   * (one worktree owns one work).
   */
  async readWork(cwd: string, work?: string): Promise<KyroReadResult<KyroWorkState>> {
    let slug = work;
    if (slug === undefined) {
      try {
        const entries = await readdir(join(cwd, '.agents', 'kyro', 'work'), {
          withFileTypes: true,
        });
        const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        if (dirs.length !== 1 || dirs[0] === undefined) {
          return fail(
            'no_target',
            `Se esperaba un solo Work en el worktree y hay ${String(dirs.length)}`,
          );
        }
        slug = dirs[0];
      } catch {
        return fail('no_target', 'El worktree no tiene Works de Kyro');
      }
    }
    try {
      const status = await this.json(cwd, ['work', 'status', '--work', slug, '--json']);
      return { ok: true, state: parseWorkState(status) };
    } catch (error) {
      return { ok: false, error: this.toError(error) };
    }
  }

  /** Task context of a scope: the same data `kyro-task-context` uses, as typed fields. */
  async contextPackTask(cwd: string, scope: string): Promise<KyroReadResult<KyroTaskContext>> {
    try {
      const pack = await this.json(cwd, [
        'context-pack',
        '--kyro-scope',
        scope,
        '--task',
        '--verbosity',
        'detailed',
        '--json',
      ]);
      return { ok: true, state: parseScopeTaskContext(pack) };
    } catch (error) {
      return { ok: false, error: this.toError(error) };
    }
  }

  /** Task context of a work (`work context-pack`). */
  async workContextPack(cwd: string, work: string): Promise<KyroReadResult<KyroTaskContext>> {
    try {
      const pack = await this.json(cwd, ['work', 'context-pack', '--work', work, '--json']);
      return { ok: true, state: parseWorkTaskContext(pack) };
    } catch (error) {
      return { ok: false, error: this.toError(error) };
    }
  }

  /** `kyro analyze` of a scope: the pilot closes a sprint only without CRITICAL or HIGH findings. */
  async analyze(cwd: string, scope: string): Promise<KyroReadResult<AnalyzeFinding[]>> {
    try {
      const out = await this.json(cwd, ['analyze', '--kyro-scope', scope, '--json']);
      return { ok: true, state: parseAnalyzeFindings(out) };
    } catch (error) {
      return { ok: false, error: this.toError(error) };
    }
  }

  /** The verbs the installed Kyro supports (`capabilities --json`). */
  async capabilities(cwd: string): Promise<KyroReadResult<string[]>> {
    try {
      return {
        ok: true,
        state: parseCapabilities(await this.json(cwd, ['capabilities', '--json'])),
      };
    } catch (error) {
      return { ok: false, error: this.toError(error) };
    }
  }

  private async json(cwd: string, args: string[]): Promise<unknown> {
    const stdout = await this.run(this.bin, args, { cwd, timeoutMs: this.timeoutMs });
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new KyroStateError(`kyro ${args[0] ?? ''} did not print JSON`);
    }
  }

  private toError(error: unknown): KyroReadError {
    if (error instanceof KyroStateError)
      return { kind: 'unexpected_output', message: error.message };
    if (error instanceof SyntaxError) {
      return { kind: 'unexpected_output', message: 'sprint.json is not valid JSON' };
    }
    const message = error instanceof Error ? error.message : 'kyro failed';
    return { kind: 'cli_failed', message };
  }
}
