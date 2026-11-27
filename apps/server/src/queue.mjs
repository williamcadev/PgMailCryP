// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

/** Durable at-least-once jobs. An unacknowledged claim survives process death. */
export class SqliteQueue {
  constructor(database, name, { leaseMs = 300_000, maxAttempts = 12 } = {}) {
    this.database = database; this.name = name; this.leaseMs = leaseMs; this.maxAttempts = maxAttempts;
    database.sqlite.exec('CREATE TABLE IF NOT EXISTS pgmailcryp_jobs (id TEXT PRIMARY KEY, queue TEXT NOT NULL, body TEXT NOT NULL, available INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, attempts INTEGER NOT NULL DEFAULT 0, dead_at INTEGER, error_code TEXT); CREATE INDEX IF NOT EXISTS pgmailcryp_jobs_due ON pgmailcryp_jobs(queue,dead_at,available,lease_until)');
  }
  insert(body, options) {
    const encoded = JSON.stringify(body);
    if (encoded === undefined || Buffer.byteLength(encoded) > 128 * 1024) throw new Error('Invalid queue message');
    const delay = options?.delaySeconds ?? 0;
    if (!Number.isFinite(delay) || delay < 0 || delay > 43200) throw new Error('Invalid queue delay');
    this.database.sqlite.prepare('INSERT INTO pgmailcryp_jobs(id,queue,body,available) VALUES (?,?,?,?)').run(randomUUID(), this.name, encoded, Date.now() + delay * 1000);
  }
  async send(body, options) { this.insert(body, options); }
  async sendBatch(messages) { this.database.transaction(() => { for (const message of messages) this.insert(message.body, message); }); }
  claim(limit = 5, now = Date.now()) {
    return this.database.transaction(() => {
      const rows = this.database.sqlite.prepare('SELECT * FROM pgmailcryp_jobs WHERE queue=? AND dead_at IS NULL AND available<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY available,id LIMIT ?').all(this.name, now, now, limit);
      const claimed = [];
      for (const row of rows) {
        if (row.attempts >= this.maxAttempts) { this.database.sqlite.prepare("UPDATE pgmailcryp_jobs SET dead_at=?,error_code='RETRIES_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE id=?").run(now, row.id); continue; }
        const token = randomUUID();
        this.database.sqlite.prepare('UPDATE pgmailcryp_jobs SET attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?').run(token, now + this.leaseMs, row.id);
        claimed.push({ ...row, body: JSON.parse(row.body), attempts: row.attempts + 1, token });
      }
      return claimed;
    });
  }
  ack(claim) { return this.database.sqlite.prepare('DELETE FROM pgmailcryp_jobs WHERE id=? AND lease_token=?').run(claim.id, claim.token).changes; }
  retry(claim, delaySeconds = Math.min(3600, 5 * 2 ** Math.min(claim.attempts, 10))) {
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 43200) throw new Error('Invalid retry delay');
    return this.database.sqlite.prepare("UPDATE pgmailcryp_jobs SET available=?,lease_until=NULL,lease_token=NULL,error_code='HANDLER_RETRY' WHERE id=? AND lease_token=?").run(Date.now() + delaySeconds * 1000, claim.id, claim.token).changes;
  }
  async drain(handler, limit = 5) {
    const claims = this.claim(limit);
    if (!claims.length) return 0;
    const completed = new Set();
    const heartbeat = setInterval(() => {
      for (const claim of claims) if (!completed.has(claim.id)) this.database.sqlite.prepare('UPDATE pgmailcryp_jobs SET lease_until=? WHERE id=? AND lease_token=?').run(Date.now() + this.leaseMs, claim.id, claim.token);
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    const messages = claims.map((claim) => ({ id: claim.id, body: claim.body, attempts: claim.attempts, timestamp: new Date(claim.available), ack: () => { if (!completed.has(claim.id)) { this.ack(claim); completed.add(claim.id); } }, retry: (options = {}) => { if (!completed.has(claim.id)) { this.retry(claim, options.delaySeconds); completed.add(claim.id); } } }));
    try { await handler({ queue: this.name, messages, ackAll: () => messages.forEach((message) => message.ack()), retryAll: (options) => messages.forEach((message) => message.retry(options)) }); for (const message of messages) if (!completed.has(message.id)) message.ack(); }
    catch { for (const message of messages) if (!completed.has(message.id)) message.retry(); }
    finally { clearInterval(heartbeat); }
    return claims.length;
  }
}
