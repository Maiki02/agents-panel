import type { MaintenanceRun, MaintenanceStatus } from '@agents-panel/shared';
import type { Db } from '../db/index.js';

export const MAX_OUTPUT_BYTES = 16 * 1024;
export const TRUNCATION_MARK = '[…salida recortada…]\n';

interface RunRow {
  id: number;
  kind: 'kyro-update';
  from_version: string | null;
  to_version: string | null;
  status: MaintenanceStatus;
  output: string | null;
  started_at: number;
  finished_at: number | null;
}

function toRun(row: RunRow): MaintenanceRun {
  return {
    id: row.id,
    kind: row.kind,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    status: row.status,
    output: row.output,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Keeps the last 16 KB (UTF-8 bytes) of the output and says so when it cut something. */
export function trimOutput(output: string): string {
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.length <= MAX_OUTPUT_BYTES) return output;
  // Cutting may split a multi-byte character: drop the broken first character.
  const tail = bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString('utf8');
  return TRUNCATION_MARK + (tail.startsWith('�') ? tail.slice(1) : tail);
}

export class MaintenanceRunRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(fromVersion: string | null): MaintenanceRun {
    const result = this.db
      .prepare(
        `INSERT INTO maintenance_runs (kind, from_version, status, started_at)
         VALUES ('kyro-update', ?, 'running', ?)`,
      )
      .run(fromVersion, this.now());
    const run = this.findById(Number(result.lastInsertRowid));
    if (!run) throw new Error('Maintenance run insert failed');
    return run;
  }

  finish(
    id: number,
    result: { status: 'ok' | 'error'; toVersion: string | null; output: string },
  ): void {
    this.db
      .prepare(
        'UPDATE maintenance_runs SET status = ?, to_version = ?, output = ?, finished_at = ? WHERE id = ?',
      )
      .run(result.status, result.toVersion, trimOutput(result.output), this.now(), id);
  }

  findById(id: number): MaintenanceRun | undefined {
    const row = this.db.prepare('SELECT * FROM maintenance_runs WHERE id = ?').get(id) as
      RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Newest first. */
  list(limit = 20): MaintenanceRun[] {
    return (
      this.db
        .prepare('SELECT * FROM maintenance_runs ORDER BY started_at DESC, id DESC LIMIT ?')
        .all(limit) as unknown as RunRow[]
    ).map(toRun);
  }

  /** Runs left 'running' by a restart can never finish: mark them as errors. */
  failInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE maintenance_runs SET status = 'error', output = 'interrumpido', finished_at = ?
         WHERE status = 'running'`,
      )
      .run(this.now());
    return Number(result.changes);
  }
}
