import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, posix, sep } from 'node:path';
import type { EnvFileContent } from './repo.js';
import { EnvFileError, validateEnvPath } from './validate.js';

/** Rejects unless git ignores `relPath` in the repo or worktree at `dir`, so it can never be committed. */
export function assertGitIgnored(dir: string, relPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, 'check-ignore', '-q', '--', relPath], (error) => {
      if (!error) {
        resolve();
        return;
      }
      if (error.code === 1) {
        reject(new EnvFileError(`git no ignora ${relPath} en el proyecto: agregalo al .gitignore`));
        return;
      }
      reject(new EnvFileError('No se pudo comprobar si git ignora la ruta del .env'));
    });
  });
}

interface PlannedWrite {
  path: string;
  dir: string;
  content: string;
}

/**
 * Writes a project's .env files into a worktree with mode 600. Every check (readable, path,
 * existing folder inside the worktree, ignored by git) runs before the first write, so a
 * failure leaves nothing half written. Each file goes to a temp file in the same folder and is
 * renamed over the target: an existing symlink there is replaced, never followed.
 */
export async function writeEnvFiles(worktreePath: string, files: EnvFileContent[]): Promise<void> {
  for (const file of files) {
    if ('unreadable' in file)
      throw new EnvFileError(`el .env ${file.path} está ilegible, volvé a subirlo`);
  }

  const root = await realpath(worktreePath);
  const plan: PlannedWrite[] = [];
  for (const file of files) {
    if ('unreadable' in file) continue;
    const path = validateEnvPath(file.path);
    const folder = posix.dirname(path);
    let dir: string;
    try {
      dir = await realpath(join(worktreePath, folder));
      if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new EnvFileError(`falta la carpeta ${folder} para ${path}`);
    }
    if (dir !== root && !dir.startsWith(root + sep))
      throw new EnvFileError(`la carpeta ${folder} de ${path} queda fuera del worktree`);
    await assertGitIgnored(worktreePath, path);
    plan.push({ path, dir, content: file.content });
  }

  for (const item of plan) {
    const name = basename(item.path);
    const temp = join(item.dir, `.${name}.panel-${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temp, item.content, { mode: 0o600, flag: 'wx' });
    try {
      await chmod(temp, 0o600);
      await rename(temp, join(item.dir, name));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}
