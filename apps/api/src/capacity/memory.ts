import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { MemoryUsage } from '@agents-panel/shared';

export interface MemoryReaderOptions {
  /** Root of the proc filesystem; tests point it at a simulated one. */
  procRoot?: string;
  worktreesDir: string;
  /** Pid of the API process (the root of the "Panel" function). */
  panelPid?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Meminfo {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
}

function kbField(text: string, name: string): number | null {
  const match = new RegExp('^' + name + ':\\s+(\\d+)\\s*kB', 'm').exec(text);
  return match?.[1] === undefined ? null : Number(match[1]) * 1024;
}

function parseMeminfo(text: string): Meminfo {
  const totalBytes = kbField(text, 'MemTotal');
  const availableBytes = kbField(text, 'MemAvailable');
  const swapTotalBytes = kbField(text, 'SwapTotal');
  const swapFreeBytes = kbField(text, 'SwapFree');
  if (
    totalBytes === null ||
    availableBytes === null ||
    swapTotalBytes === null ||
    swapFreeBytes === null
  ) {
    throw new Error('meminfo is missing MemTotal, MemAvailable, SwapTotal or SwapFree');
  }
  return { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes };
}

interface ProcInfo {
  pid: number;
  ppid: number;
  rssBytes: number;
  cwd: string | null;
}

function readProcess(procRoot: string, pid: number): ProcInfo | null {
  let status: string;
  try {
    status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
  } catch {
    return null; // the process ended while we were reading
  }
  const ppid = /^PPid:\s+(\d+)/m.exec(status)?.[1];
  const rss = kbField(status, 'VmRSS'); // absent for kernel threads
  let cwd: string | null;
  try {
    cwd = readlinkSync(join(procRoot, String(pid), 'cwd'));
  } catch {
    cwd = null; // unreadable (other user, gone): counted as "Otros"
  }
  return { pid, ppid: ppid === undefined ? 0 : Number(ppid), rssBytes: rss ?? 0, cwd };
}

function isUnder(path: string, dir: string): boolean {
  const base = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return path === base || path.startsWith(base + sep);
}

/** Reads the RAM split on every call (no cache). A /proc/meminfo failure is logged and yields no data. */
export function readMemory(options: MemoryReaderOptions): MemoryUsage {
  const procRoot = options.procRoot ?? '/proc';
  const now = options.now ?? Date.now;
  const measuredAt = now();
  let meminfo: Meminfo;
  try {
    meminfo = parseMeminfo(readFileSync(join(procRoot, 'meminfo'), 'utf8'));
  } catch (err) {
    options.log?.('capacity: cannot read ' + join(procRoot, 'meminfo') + ': ' + String(err));
    return { measuredAt, totals: null, swap: null };
  }

  const processes = new Map<number, ProcInfo>();
  try {
    for (const entry of readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      const info = readProcess(procRoot, Number(entry));
      if (info) processes.set(info.pid, info);
    }
  } catch (err) {
    options.log?.('capacity: cannot list ' + procRoot + ': ' + String(err));
  }

  const panelPid = options.panelPid ?? process.pid;
  const isPanelTree = (pid: number): boolean => {
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && current > 0 && !seen.has(current)) {
      if (current === panelPid) return true;
      seen.add(current);
      current = processes.get(current)?.ppid;
    }
    return false;
  };

  let ai = 0;
  let panel = 0;
  for (const info of processes.values()) {
    if (info.cwd !== null && isUnder(info.cwd, options.worktreesDir)) ai += info.rssBytes;
    else if (isPanelTree(info.pid)) panel += info.rssBytes;
  }

  // Per-process RSS does not match MemTotal - MemAvailable exactly: Otros absorbs the difference
  // (floor 0) and, if the attributed sum overshoots the used memory, both are scaled down so
  // the bar still closes on MemTotal.
  const { totalBytes, availableBytes } = meminfo;
  const used = Math.max(0, totalBytes - availableBytes);
  if (ai + panel > used) {
    const scale = used / (ai + panel);
    ai = Math.floor(ai * scale);
    panel = Math.floor(panel * scale);
  }
  return {
    measuredAt,
    totals: {
      totalBytes,
      aiBytes: ai,
      panelBytes: panel,
      otherBytes: used - ai - panel,
      availableBytes,
    },
    swap: {
      totalBytes: meminfo.swapTotalBytes,
      usedBytes: Math.max(0, meminfo.swapTotalBytes - meminfo.swapFreeBytes),
    },
  };
}
