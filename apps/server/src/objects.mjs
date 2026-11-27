// SPDX-License-Identifier: Apache-2.0
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const metadataHeaders = { contentType: 'content-type', contentLanguage: 'content-language', contentDisposition: 'content-disposition', contentEncoding: 'content-encoding', cacheControl: 'cache-control', cacheExpiry: 'expires' };
async function bytes(value, limit) {
  if (typeof value === 'string') value = Buffer.from(value);
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) { if (value.byteLength > limit) throw new Error('Object exceeds storage limit'); return Buffer.from(value.buffer, value.byteOffset, value.byteLength); }
  const chunks = []; let size = 0;
  for await (const chunk of value instanceof Blob ? value.stream() : value) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > limit) throw new Error('Object exceeds storage limit'); chunks.push(buffer); }
  return Buffer.concat(chunks);
}
export class FileObjects {
  constructor(database, directory, limit = 64 * 1024 * 1024) {
    this.database = database; this.directory = resolve(directory); this.limit = limit;
    database.sqlite.exec('CREATE TABLE IF NOT EXISTS pgmailcryp_objects (key TEXT PRIMARY KEY, file TEXT NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL, http TEXT NOT NULL, custom TEXT NOT NULL, uploaded INTEGER NOT NULL)');
  }
  path(file) { if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(file)) throw new Error('Invalid stored object path'); return join(this.directory, file); }
  async put(key, value, options = {}) {
    if (typeof key !== 'string' || !key || key.length > 1024 || key.includes('\0')) throw new Error('Invalid object key');
    if (options.onlyIf) throw new Error('Conditional object writes are not supported');
    const content = await bytes(value, this.limit), etag = hash(content);
    const file = `${hash(key)}/${etag}`, target = join(this.directory, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    const folder = await open(dirname(target), 'r'); try { await folder.sync(); } finally { await folder.close(); }
    this.database.sqlite.prepare('INSERT INTO pgmailcryp_objects VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET file=excluded.file,etag=excluded.etag,size=excluded.size,http=excluded.http,custom=excluded.custom,uploaded=excluded.uploaded')
      .run(key, file, etag, content.length, JSON.stringify(options.httpMetadata ?? {}), JSON.stringify(options.customMetadata ?? {}), Date.now());
    return this.head(key);
  }
  metadata(row) {
    if (!row) return null;
    const httpMetadata = JSON.parse(row.http);
    return { key: row.key, size: row.size, etag: row.etag, httpEtag: `"${row.etag}"`, uploaded: new Date(row.uploaded), version: row.etag, httpMetadata, customMetadata: JSON.parse(row.custom), writeHttpMetadata(headers) { for (const [key, value] of Object.entries(httpMetadata)) if (metadataHeaders[key]) headers.set(metadataHeaders[key], value instanceof Date ? value.toUTCString() : String(value)); } };
  }
  async head(key) { return this.metadata(this.database.sqlite.prepare('SELECT * FROM pgmailcryp_objects WHERE key=?').get(key)); }
  async get(key, options = {}) {
    if (options.onlyIf) throw new Error('Conditional object reads are not supported');
    const row = this.database.sqlite.prepare('SELECT * FROM pgmailcryp_objects WHERE key=?').get(key);
    if (!row) return null;
    const result = this.metadata(row);
    let start = 0, length = row.size;
    if (options.range) {
      if ('suffix' in options.range) { length = Math.min(row.size, options.range.suffix); start = row.size - length; }
      else { start = options.range.offset ?? 0; length = Math.min(options.range.length ?? row.size - start, row.size - start); }
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start > row.size) throw new Error('Invalid object range');
      result.range = { offset: start, length };
    }
    const path = this.path(row.file);
    const stream = length ? Readable.toWeb(createReadStream(path, { start, end: start + length - 1 })) : new ReadableStream({ start(controller) { controller.close(); } });
    const response = new Response(stream);
    return Object.assign(result, { body: response.body, arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: () => response.json(), blob: () => response.blob() });
  }
  async delete(keys) { this.database.transaction(() => { for (const key of Array.isArray(keys) ? keys : [keys]) this.database.sqlite.prepare('DELETE FROM pgmailcryp_objects WHERE key=?').run(key); }); }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid object list limit');
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    const rows = this.database.sqlite.prepare('SELECT * FROM pgmailcryp_objects WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?').all(prefix.length, prefix, after, limit + 1);
    const truncated = rows.length > limit;
    return { objects: rows.slice(0, limit).map((row) => this.metadata(row)), truncated, cursor: truncated ? Buffer.from(rows[limit - 1].key).toString('base64url') : undefined, delimitedPrefixes: [] };
  }
  async verify() { for (const row of this.database.sqlite.prepare('SELECT file,etag FROM pgmailcryp_objects').all()) if (hash(await readFile(this.path(row.file))) !== row.etag) throw new Error('Stored object failed integrity verification'); }
}
