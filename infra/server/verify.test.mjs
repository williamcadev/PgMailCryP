// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase, migrate } from '../../apps/server/src/sqlite.mjs';
import { FileObjects } from '../../apps/server/src/objects.mjs';

test('recovery verifier checks real schema and refuses a corrupted stored object', async () => {
  const state = await mkdtemp(join(tmpdir(), 'pgmailcryp-verifier-'));
  try {
    const db = new SqliteDatabase(join(state, 'native', 'mail.sqlite'));
    migrate(db, fileURLToPath(new URL('../../drizzle', import.meta.url)));
    const objects = new FileObjects(db, join(state, 'native', 'objects'));
    await objects.put('encrypted-object', new Uint8Array([0, 255, 17]));
    const file = db.sqlite.prepare('SELECT file FROM pgmailcryp_objects').get().file; db.close();
    await mkdir(join(state, 'bridge-state'));
    const receipts = new DatabaseSync(join(state, 'bridge-state', 'smtp-receipts.sqlite'));
    receipts.exec('CREATE TABLE smtp_receipt (id TEXT PRIMARY KEY)'); receipts.close();
    const verify = () => spawnSync(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url))], { env: { ...process.env, PGMAILCRYP_STATE: state }, encoding: 'utf8' });
    const good = verify(); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).objects, 1);
    await writeFile(join(state, 'native', 'objects', file), 'damaged');
    const bad = verify(); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /object integrity failed/);
  } finally { await rm(state, { recursive: true, force: true }); }
});
