import type { Db } from '../db/index.js';

/** A row of claude_accounts; what the panel stores (identity and login are read from disk). */
export interface AccountRecord {
  id: number;
  name: string;
  configDir: string | null;
  active: boolean;
  createdAt: number;
}

interface AccountRow {
  id: number;
  name: string;
  config_dir: string | null;
  active: number;
  created_at: number;
}

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    configDir: row.config_dir,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

/** Claude accounts of the panel. Migration 19 creates the default one (no directory), active. */
export class AccountRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): AccountRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM claude_accounts ORDER BY config_dir IS NOT NULL, id')
        .all() as unknown as AccountRow[]
    ).map(toRecord);
  }

  findById(id: number): AccountRecord | undefined {
    const row = this.db.prepare('SELECT * FROM claude_accounts WHERE id = ?').get(id) as
      AccountRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  findByName(name: string): AccountRecord | undefined {
    const row = this.db.prepare('SELECT * FROM claude_accounts WHERE name = ?').get(name) as
      AccountRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  findByConfigDir(configDir: string): AccountRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM claude_accounts WHERE config_dir = ?')
      .get(configDir) as AccountRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** The account new sessions run with. The migration guarantees one; it never goes missing. */
  active(): AccountRecord {
    const row = this.db.prepare('SELECT * FROM claude_accounts WHERE active = 1').get() as
      AccountRow | undefined;
    if (!row) throw new Error('No active Claude account');
    return toRecord(row);
  }

  create(name: string, configDir: string): AccountRecord {
    const result = this.db
      .prepare(
        'INSERT INTO claude_accounts (name, config_dir, active, created_at) VALUES (?, ?, 0, ?)',
      )
      .run(name, configDir, this.now());
    const created = this.findById(Number(result.lastInsertRowid));
    if (!created) throw new Error('Account not created');
    return created;
  }

  rename(id: number, name: string): void {
    this.db.prepare('UPDATE claude_accounts SET name = ? WHERE id = ?').run(name, id);
  }

  /** Makes `id` the only active account, in one transaction; an unknown id changes nothing. */
  setActive(id: number): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE claude_accounts SET active = 0 WHERE active = 1').run();
      const { changes } = this.db
        .prepare('UPDATE claude_accounts SET active = 1 WHERE id = ?')
        .run(id);
      if (Number(changes) !== 1) throw new Error(`Account not found: ${String(id)}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM claude_accounts WHERE id = ?').run(id);
  }
}
