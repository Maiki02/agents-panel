import type { Db } from './index.js';

/** Markers of one-time startup jobs (table app_flags). */
export class AppFlags {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  isSet(name: string): boolean {
    return (
      this.db.prepare('SELECT 1 AS found FROM app_flags WHERE name = ?').get(name) !== undefined
    );
  }

  set(name: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO app_flags (name, set_at) VALUES (?, ?)')
      .run(name, this.now());
  }
}
