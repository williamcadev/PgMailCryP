// SPDX-License-Identifier: Apache-2.0
export class SqliteKv {
  constructor(database) {
    this.database = database;
    database.sqlite.exec('CREATE TABLE IF NOT EXISTS pgmailcryp_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expires INTEGER, metadata TEXT)');
  }
  async put(key, value, options = {}) {
    if (typeof value === 'string') value = Buffer.from(value);
    else if (value instanceof ArrayBuffer) value = new Uint8Array(value);
    else if (!ArrayBuffer.isView(value)) value = new Uint8Array(await new Response(value).arrayBuffer());
    const expires = options.expiration !== undefined ? options.expiration * 1000 : options.expirationTtl !== undefined ? Date.now() + options.expirationTtl * 1000 : null;
    if (expires !== null && !Number.isFinite(expires)) throw new Error('Invalid KV expiration');
    this.database.sqlite.prepare('INSERT INTO pgmailcryp_kv VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires,metadata=excluded.metadata')
      .run(key, value, expires, options.metadata === undefined ? null : JSON.stringify(options.metadata));
  }
  async getWithMetadata(key, options) {
    const row = this.database.sqlite.prepare('SELECT * FROM pgmailcryp_kv WHERE key=? AND (expires IS NULL OR expires>?)').get(key, Date.now());
    if (!row) return { value: null, metadata: null, cacheStatus: 'MISS' };
    const type = typeof options === 'string' ? options : options?.type ?? 'text';
    const buffer = Buffer.from(row.value);
    const value = type === 'json' ? JSON.parse(buffer.toString('utf8')) : type === 'arrayBuffer' ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) : type === 'stream' ? new Response(buffer).body : buffer.toString('utf8');
    return { value, metadata: row.metadata ? JSON.parse(row.metadata) : null, cacheStatus: 'HIT' };
  }
  async get(key, options) { return (await this.getWithMetadata(key, options)).value; }
  async delete(key) { this.database.sqlite.prepare('DELETE FROM pgmailcryp_kv WHERE key=?').run(key); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid KV list limit');
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    const rows = this.database.sqlite.prepare('SELECT key,expires,metadata FROM pgmailcryp_kv WHERE substr(key,1,?)=? AND key>? AND (expires IS NULL OR expires>?) ORDER BY key LIMIT ?').all(prefix.length, prefix, after, Date.now(), limit + 1);
    const complete = rows.length <= limit;
    return { keys: rows.slice(0, limit).map((row) => ({ name: row.key, expiration: row.expires === null ? undefined : Math.floor(row.expires / 1000), metadata: row.metadata ? JSON.parse(row.metadata) : undefined })), list_complete: complete, cursor: complete ? '' : Buffer.from(rows[limit - 1].key).toString('base64url') };
  }
}
