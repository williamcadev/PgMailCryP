// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Native SQLite driver retaining the prepared-statement surface consumed by Drizzle. */
export class SqliteDatabase {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
    this.sqlite = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  prepare(sql) { return new Statement(this, sql, []); }
  transaction(action) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const result = action(); if (result?.then) throw new Error('SQLite transaction callbacks must be synchronous'); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async batch(statements) { return this.transaction(() => statements.map((statement) => statement.execute(false))); }
  async exec(sql) { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
  close() { if (!this.closed) { this.sqlite.close(); this.closed = true; } }
}
class Statement {
  constructor(database, sql, values) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.database, this.sql, values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value === undefined ? null : value)); }
  execute(arrays) {
    const statement = this.database.sqlite.prepare(this.sql);
    const reads = statement.columns().length > 0;
    let results = [], changes = 0, lastRowId = 0;
    if (reads) { statement.setReturnArrays(arrays); results = statement.all(...this.values); }
    else { const result = statement.run(...this.values); changes = Number(result.changes); lastRowId = Number(result.lastInsertRowid); }
    // RETURNING statements are reads too; SQLite's changes() records their writes.
    if (reads && !/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(this.sql)) changes = Number(this.database.sqlite.prepare('SELECT changes() AS n').get().n);
    return { success: true, results, meta: { changes, last_row_id: lastRowId, duration: 0, rows_read: results.length, rows_written: changes } };
  }
  async all() { return this.execute(false); }
  async run() { return this.execute(false); }
  async raw(options) {
    const rows = this.execute(true).results;
    return options?.columnNames ? [this.database.sqlite.prepare(this.sql).columns().map((column) => column.name), ...rows] : rows;
  }
  async first(column) { const row = this.execute(false).results[0]; return row ? column ? row[column] ?? null : row : null; }
}

/** Immutable migration hashes make an accidental downgrade/rewrite fail before serving. */
export function migrate(database, directory) {
  database.sqlite.exec('CREATE TABLE IF NOT EXISTS pgmailcryp_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = database.sqlite.prepare('SELECT name,hash FROM pgmailcryp_migrations ORDER BY name').all();
  const files = readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const row of applied) if (!files.includes(row.name)) throw new Error(`Installed migration missing from this release: ${row.name}`);
  for (const name of files) {
    const sql = readFileSync(join(directory, name), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const previous = applied.find((row) => row.name === name);
    if (previous) { if (previous.hash !== hash) throw new Error(`Installed migration changed: ${name}`); continue; }
    database.sqlite.exec('PRAGMA foreign_keys=OFF');
    try { database.transaction(() => {
      for (const part of sql.split(/-->\s*statement-breakpoint/)) if (part.trim()) database.sqlite.exec(part);
      if (database.sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`Migration violates foreign keys: ${name}`);
      database.sqlite.prepare('INSERT INTO pgmailcryp_migrations VALUES (?,?,?)').run(name, hash, Date.now());
    }); } finally { database.sqlite.exec('PRAGMA foreign_keys=ON'); }
  }
  const integrity = database.sqlite.prepare('PRAGMA quick_check').get();
  if (Object.values(integrity)[0] !== 'ok') throw new Error('SQLite integrity check failed');
}
