// SPDX-License-Identifier: Apache-2.0
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SqliteDatabase, migrate } from './sqlite.mjs';
import { FileObjects } from './objects.mjs';
import { SqliteKv } from './kv.mjs';
import { SqliteQueue } from './queue.mjs';

export function createPlatform({ directory, migrations, secrets, variables = {} }) {
  process.umask(0o077);
  directory = resolve(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new SqliteDatabase(join(directory, 'mail.sqlite'));
  migrate(database, migrations);
  const objects = new FileObjects(database, join(directory, 'objects'));
  const outbound = new SqliteQueue(database, 'mail-outbound');
  const inbound = new SqliteQueue(database, 'mail-inbound');
  const webhook = new SqliteQueue(database, 'webhooks');
  const pending = new Set();
  const env = { ...secrets, ...variables, DB: database, MAIL_RAW: objects, AUTH_KV: new SqliteKv(database), MAIL_QUEUE: inbound, MAIL_OUT_QUEUE: outbound, WEBHOOK_QUEUE: webhook,
    // Never fall through to the historical development mailer that logs bodies.
    EMAIL_SENDER: { async send() { throw new Error('Native transactional SMTP sender is not configured'); } },
  };
  return { database, objects, outbound, inbound, webhook, env, directory,
    requestPlatform() { return { env, ctx: { waitUntil(promise) { const task = Promise.resolve(promise).catch(() => {}).finally(() => pending.delete(task)); pending.add(task); }, passThroughOnException() {}, props: {} } }; },
    async close() { while (pending.size) await Promise.allSettled([...pending]); database.close(); },
  };
}
