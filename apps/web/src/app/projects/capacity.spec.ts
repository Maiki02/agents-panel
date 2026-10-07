import { describe, expect, it } from 'vitest';
import type { DiskUsage, MemoryUsage } from '@agents-panel/shared';
import {
  diskSegments,
  diskState,
  formatBytes,
  formatGb,
  memorySegments,
  memoryState,
  percents,
  projectDiskText,
  swapText,
} from './capacity-logic';

const GB = 1024 ** 3;

const disk: DiskUsage = {
  measuring: false,
  measuredAt: 1_000,
  totals: {
    totalBytes: 100 * GB,
    projectsBytes: 10 * GB,
    worktreesBytes: 20 * GB,
    otherBytes: 30 * GB,
    freeBytes: 40 * GB,
  },
  projects: [],
  strays: [],
};

describe('formatBytes / formatGb', () => {
  it('uses binary units with a decimal comma', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(3 * GB)).toBe('3,0 GB');
    expect(formatGb(1.25 * GB)).toBe('1,3 GB');
  });

  it('never prints a number for an invalid value', () => {
    expect(formatBytes(-1)).toBe('sin dato');
    expect(formatGb(Number.NaN)).toBe('sin dato');
  });
});

describe('percents', () => {
  it('always adds up to 100', () => {
    for (const values of [
      [1, 1, 1, 0],
      [1, 2, 3, 4],
      [33, 33, 33, 1],
      [5, 0, 0, 0],
    ]) {
      expect(percents(values).reduce((a, b) => a + b, 0)).toBe(100);
    }
    expect(percents([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('is all zeros without a positive total', () => {
    expect(percents([0, 0])).toEqual([0, 0]);
  });
});

describe('segments', () => {
  it('splits the disk in its four parts', () => {
    const segments = diskSegments(disk);
    expect(segments.map((s) => s.label)).toEqual(['Proyectos', 'Worktrees', 'Otros', 'Libre']);
    expect(segments.map((s) => s.percent)).toEqual([10, 20, 30, 40]);
  });

  it('splits the RAM in its four parts and has none without totals', () => {
    const memory: MemoryUsage = {
      measuredAt: 1,
      totals: { totalBytes: 10, aiBytes: 4, panelBytes: 1, otherBytes: 1, availableBytes: 4 },
      swap: { totalBytes: 4 * GB, usedBytes: 2 * GB },
    };
    expect(memorySegments(memory).map((s) => s.label)).toEqual([
      'Sesiones de IA y builds',
      'Panel',
      'Otros',
      'Disponible',
    ]);
    expect(memorySegments({ ...memory, totals: null })).toEqual([]);
    expect(swapText(memory)).toBe('2,0 GB de 4,0 GB');
    expect(swapText({ ...memory, swap: null })).toBe('sin dato');
  });
});

describe('states', () => {
  it('is measuring before the first measurement and error when the load failed', () => {
    expect(diskState(null, false)).toBe('measuring');
    expect(diskState(null, true)).toBe('error');
    expect(diskState({ ...disk, measuring: true, measuredAt: null, totals: null }, false)).toBe(
      'measuring',
    );
    expect(diskState({ ...disk, totals: null }, false)).toBe('error');
    expect(diskState(disk, false)).toBe('ready');
    expect(memoryState(null, false)).toBe('measuring');
    expect(memoryState({ measuredAt: 1, totals: null, swap: null }, false)).toBe('error');
  });
});

describe('projectDiskText', () => {
  it('shows repository and worktrees, never "clon"', () => {
    const text = projectDiskText('ready', {
      name: 'a',
      repositoryBytes: 1.5 * GB,
      worktreesBytes: 2 * GB,
    });
    expect(text).toBe('Repositorio 1,5 GB · Worktrees 2,0 GB');
    expect(text.toLowerCase()).not.toContain('clon');
  });

  it('shows Midiendo… and sin dato instead of zeros', () => {
    expect(projectDiskText('measuring', undefined)).toBe('Midiendo…');
    expect(projectDiskText('error', undefined)).toBe('sin dato');
    expect(projectDiskText('ready', undefined)).toBe('sin dato');
    expect(projectDiskText('ready', { name: 'a', repositoryBytes: null, worktreesBytes: GB })).toBe(
      'Repositorio sin dato · Worktrees 1,0 GB',
    );
  });
});
