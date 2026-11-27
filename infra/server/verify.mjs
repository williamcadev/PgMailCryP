// SPDX-License-Identifier: Apache-2.0
// Run only against a stopped copy. SQLite WAL readers may create sidecar files;
// the copied directory is writable although both databases are opened read-only.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
const state = process.env.PGMAILCRYP_STATE ?? '/runtime';
const db = new DatabaseSync(`${state}/native/mail.sqlite`, { readOnly: true });
try {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Application SQLite integrity failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Application foreign key integrity failed');
  for (const table of ['pgp_inbox_message', 'pgp_draft', 'pgp_outbox_message']) {
    if (db.prepare(`SELECT count(*) AS n FROM ${table} AS message LEFT JOIN pgmailcryp_objects AS object ON object.key=message.r2_key WHERE object.key IS NULL`).get().n) throw new Error('Missing OpenPGP object reference');
  }
  let objects = 0;
  for (const row of db.prepare('SELECT file,etag,size FROM pgmailcryp_objects').all()) {
    if (!/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(row.file)) throw new Error('Invalid stored object path');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of createReadStream(`${state}/native/objects/${row.file}`)) { hash.update(chunk); size += chunk.length; }
    if (hash.digest('hex') !== row.etag || size !== row.size) throw new Error('Stored object integrity failed');
    objects++;
  }
  const file = `${state}/bridge-state/smtp-receipts.sqlite`;
  await access(file);
  const receipts = new DatabaseSync(file, { readOnly: true });
  try { if (receipts.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SMTP receipt SQLite integrity failed'); } finally { receipts.close(); }
  const counts = {};
  for (const table of ['user', 'mailbox', 'mailbox_pgp_key', 'pgp_inbox_message', 'pgp_outbox_message']) counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  console.log(JSON.stringify({ status: 'verified', objects, counts }));
} finally { db.close(); }
