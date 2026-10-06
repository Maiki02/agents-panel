import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'panel.lock';

export class InstanceLockError extends Error {
  override readonly name = 'InstanceLockError';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';

/** Identifies this boot of the machine; null where the kernel does not expose it. */
function currentBootId(file: string): string | null {
  try {
    const id = readFileSync(file, 'utf8').trim();
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

interface LockOwner {
  pid: number;
  /** null for a lock written by an older version (only the pid). */
  bootId: string | null;
}

function readOwner(path: string): LockOwner | null {
  try {
    const [first = '', second = ''] = readFileSync(path, 'utf8').trim().split('\n');
    const pid = Number.parseInt(first.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, bootId: second.trim() === '' ? null : second.trim() };
  } catch {
    return null;
  }
}

/**
 * One API per data directory: the pilot resumes its work on start, so two instances on the same
 * database would run the same steps twice. Returns the function that releases the lock.
 * A lock whose pid is dead (crash, kill -9) is taken over, and so is one written during another boot
 * of the machine: after an unclean reboot its pid may belong to an unrelated live process, which
 * would keep the service from ever starting.
 */
export function acquireInstanceLock(
  dataDir: string,
  pid: number = process.pid,
  bootIdFile: string = BOOT_ID_FILE,
): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILE);
  const bootId = currentBootId(bootIdFile);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, bootId === null ? `${String(pid)}\n` : `${String(pid)}\n${bootId}\n`);
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only remove our own lock.
        if (readOwner(path)?.pid === pid) {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = readOwner(path);
    // A lock from another boot is stale whatever its pid is doing now.
    const otherBoot = owner?.bootId != null && bootId !== null && owner.bootId !== bootId;
    if (owner !== null && !otherBoot && owner.pid !== pid && isAlive(owner.pid)) {
      throw new InstanceLockError(
        `Another panel API (pid ${String(owner.pid)}) is already using ${dataDir}. ` +
          'Stop it before starting a second one (the pilot would resume the same work twice).',
      );
    }
    try {
      unlinkSync(path);
    } catch {
      // lost the race to another process; the next attempt decides
    }
  }
  throw new InstanceLockError(`Could not take the instance lock at ${path}`);
}
