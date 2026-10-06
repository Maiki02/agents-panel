import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstanceLockError, LOCK_FILE, acquireInstanceLock } from '../src/instance-lock.js';

const dataDir = () => mkdtempSync(join(tmpdir(), 'panel-lock-'));

describe('instance lock', () => {
  it('writes the pid and removes the file on release', () => {
    const dir = dataDir();
    const release = acquireInstanceLock(dir);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0]).toBe(String(process.pid));
    release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    release();
  });

  it('refuses a second instance on the same directory with a clear message', () => {
    const dir = dataDir();
    // The parent of the test process is alive and is not us.
    writeFileSync(join(dir, LOCK_FILE), `${String(process.ppid)}\n`);
    expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockError);
    expect(() => acquireInstanceLock(dir)).toThrow(/already using/);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8').trim()).toBe(String(process.ppid));
  });

  it('takes over a lock whose pid is dead', () => {
    const dir = dataDir();
    writeFileSync(join(dir, LOCK_FILE), '2147483646\n');
    const release = acquireInstanceLock(dir);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0]).toBe(String(process.pid));
    release();
  });

  it('takes over an unreadable lock and keeps independent directories independent', () => {
    const a = dataDir();
    writeFileSync(join(a, LOCK_FILE), 'garbage');
    const releaseA = acquireInstanceLock(a);
    const releaseB = acquireInstanceLock(dataDir());
    releaseA();
    releaseB();
  });

  describe('boot id', () => {
    const bootFile = (id: string) => {
      const file = join(dataDir(), 'boot_id');
      writeFileSync(file, `${id}\n`);
      return file;
    };

    it('writes pid and boot id, and a live pid from the same boot is still refused', () => {
      const dir = dataDir();
      const boot = bootFile('boot-A');
      const release = acquireInstanceLock(dir, process.pid, boot);
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${String(process.pid)}\nboot-A\n`);
      release();
      writeFileSync(join(dir, LOCK_FILE), `${String(process.ppid)}\nboot-A\n`);
      expect(() => acquireInstanceLock(dir, process.pid, boot)).toThrow(/already using/);
    });

    it('takes over a lock from another boot even if its pid is alive (pid reused after a reboot)', () => {
      const dir = dataDir();
      writeFileSync(join(dir, LOCK_FILE), `${String(process.ppid)}\nboot-OLD\n`);
      const release = acquireInstanceLock(dir, process.pid, bootFile('boot-NEW'));
      expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(`${String(process.pid)}\nboot-NEW\n`);
      release();
    });

    it('keeps the old behaviour for a lock with only a pid and without a readable boot id', () => {
      const dir = dataDir();
      writeFileSync(join(dir, LOCK_FILE), `${String(process.ppid)}\n`);
      expect(() => acquireInstanceLock(dir, process.pid, bootFile('boot-A'))).toThrow(
        /already using/,
      );
      writeFileSync(join(dir, LOCK_FILE), `${String(process.ppid)}\nboot-OLD\n`);
      const missing = join(dataDir(), 'no-such-file');
      expect(() => acquireInstanceLock(dir, process.pid, missing)).toThrow(/already using/);
      // With no boot id there is nothing to write besides the pid.
      const clean = dataDir();
      const release = acquireInstanceLock(clean, process.pid, missing);
      expect(readFileSync(join(clean, LOCK_FILE), 'utf8')).toBe(`${String(process.pid)}\n`);
      release();
    });
  });
});
