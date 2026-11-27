// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase, migrate } from '../src/sqlite.mjs';
import { FileObjects } from '../src/objects.mjs';
import { SqliteKv } from '../src/kv.mjs';
import { SqliteQueue } from '../src/queue.mjs';
import { runtimeDatabase, databaseSchema as schema } from '../dist/jobs.mjs';
const migrations = resolve('../../drizzle');
async function fixture(check) {
  const path = await mkdtemp(join(tmpdir(), 'pgp-native-')); const db = new SqliteDatabase(join(path, 'mail.sqlite'));
  try { await check(db, path); } finally { db.close(); await rm(path, { recursive: true, force: true }); }
}

test('all real migrations and Drizzle relational queries work on native SQLite; repeat migration retains data', async () => fixture(async (binding) => {
  migrate(binding, migrations);
  const db = runtimeDatabase(binding);
  await db.insert(schema.organization).values({ id: 'org', name: 'Test', domain: 'example.test', slug: 'example', status: 'active', createdAt: new Date() });
  await db.insert(schema.user).values({ id: 'user', name: 'User', email: 'owner@external.test', createdAt: new Date(), updatedAt: new Date() });
  await db.batch([
    db.insert(schema.mailbox).values({ id: 'box', orgId: 'org', localPart: 'owner', address: 'owner@example.test', isPersonal: true }),
    db.insert(schema.mailboxAccess).values({ userId: 'user', mailboxId: 'box', canSend: true }),
  ]);
  assert.equal((await db.query.mailbox.findFirst()).address, 'owner@example.test');
  assert.equal((await db.query.mailboxAccess.findFirst()).canSend, true);
  migrate(binding, migrations);
  assert.equal(await db.$count(schema.user), 1);
  assert.equal(await db.$count(schema.mailbox), 1);
  await assert.rejects(db.batch([
    db.insert(schema.mailbox).values({ id: 'rolled-back', orgId: 'org', localPart: 'other', address: 'other@example.test' }),
    db.insert(schema.mailboxAccess).values({ userId: 'missing-user', mailboxId: 'rolled-back' }),
  ]));
  assert.equal(await db.$count(schema.mailbox), 1);
}));

test('migration rollback retains prior schema and detects changed or missing history', async () => fixture(async (db, path) => {
  const dir = join(path, 'migrations'); await cp(migrations, dir, { recursive: true });
  migrate(db, dir);
  await writeFile(join(dir, '0061_bad.sql'), 'CREATE TABLE must_rollback (id TEXT); --> statement-breakpoint\nINSERT INTO nonexistent VALUES(1);');
  assert.throws(() => migrate(db, dir));
  assert.equal(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='must_rollback'").get(), undefined);
  await rm(join(dir, '0061_bad.sql'));
  const old = await readFile(join(dir, '0060_pgp_end_to_end.sql'), 'utf8');
  await writeFile(join(dir, '0060_pgp_end_to_end.sql'), old + '\n-- changed');
  assert.throws(() => migrate(db, dir), /changed/);
  await rm(join(dir, '0060_pgp_end_to_end.sql'));
  assert.throws(() => migrate(db, dir), /missing/);
}));

test('duplicate columns, parameter binding, raw and RETURNING preserve SQLite values and transaction results', async () => fixture(async (db) => {
  await db.exec('CREATE TABLE values_test(id INTEGER PRIMARY KEY, value TEXT, bytes BLOB)');
  const insert = await db.prepare('INSERT INTO values_test(value,bytes) VALUES (?,?) RETURNING id,value').bind('é', new Uint8Array([0, 255])).all();
  assert.equal(insert.results[0].value, 'é'); assert.equal(insert.meta.changes, 1);
  assert.deepEqual(await db.prepare('SELECT id AS x, value AS x FROM values_test').raw(), [[1, 'é']]);
  assert.equal(await db.prepare('SELECT value FROM values_test WHERE id=?').bind(1).first('value'), 'é');
  assert.equal((await db.prepare('SELECT * FROM values_test').all()).results[0].bytes[1], 255);
}));

test('immutable file versions, binary bodies, ranges and hashed keys survive reopen; no path traversal', async () => fixture(async (db, path) => {
  const bucket = new FileObjects(db, join(path, 'objects'));
  const bytes = new Uint8Array([0, 255, 128, 5]);
  await bucket.put('../../escape', bytes, { httpMetadata: { contentType: 'application/pgp-encrypted' }, customMetadata: { marker: 'opaque' } });
  const old = await bucket.get('../../escape');
  await bucket.put('../../escape', 'replacement');
  assert.deepEqual(new Uint8Array(await old.arrayBuffer()), bytes);
  assert.equal(await (await new FileObjects(db, join(path, 'objects')).get('../../escape')).text(), 'replacement');
  assert.equal(await (await bucket.get('../../escape', { range: { offset: 1, length: 3 } })).text(), 'epl');
  assert.equal((await bucket.list({ prefix: '../' })).objects.length, 1);
  assert.equal((await stat(join(path, 'mail.sqlite'))).mode & 0o777, 0o600);
  await bucket.verify();
  db.sqlite.prepare('UPDATE pgmailcryp_objects SET file=?').run('../../outside');
  await assert.rejects(bucket.get('../../escape'), /Invalid stored object path/);
}));

test('KV sessions persist with expiration, JSON, metadata and prefix pagination', async () => fixture(async (db) => {
  const kv = new SqliteKv(db);
  await kv.put('session:one', JSON.stringify({ user: 'owner' }), { metadata: { scope: 'account' } });
  await kv.put('session:two', 'second');
  await kv.put('session:expired', 'secret', { expiration: 1 });
  assert.deepEqual(await new SqliteKv(db).get('session:one', 'json'), { user: 'owner' });
  assert.equal(await kv.get('session:expired'), null);
  const page = await kv.list({ prefix: 'session:', limit: 1 });
  assert.equal(page.keys[0].name, 'session:one'); assert.equal(page.list_complete, false);
  assert.equal((await kv.list({ prefix: 'session:', cursor: page.cursor })).keys[0].name, 'session:two');
  await kv.delete('session:one'); assert.equal(await kv.get('session:one'), null);
}));

test('jobs survive reopen, expired claims are redriven and stale acknowledgements cannot erase a new claim', async () => fixture(async (db) => {
  const queue = new SqliteQueue(db, 'outbound', { leaseMs: 5 });
  await queue.send({ kind: 'pgp', submissionId: 'opaque-id' });
  const first = queue.claim(1)[0]; assert.equal(first.attempts, 1);
  assert.equal(new SqliteQueue(db, 'outbound').claim(1).length, 0);
  const second = queue.claim(1, Date.now() + 1000)[0]; assert.equal(second.attempts, 2);
  assert.equal(Number(queue.ack(first)), 0);
  assert.equal(Number(queue.ack(second)), 1);
  assert.equal(queue.claim(1).length, 0);
}));

test('handler errors remain durable, batch sends roll back and exhausted jobs become retained dead letters', async () => fixture(async (db) => {
  const queue = new SqliteQueue(db, 'outbound', { maxAttempts: 1 });
  await assert.rejects(queue.sendBatch([{ body: { id: 1 } }, { body: undefined }]));
  assert.equal(queue.claim().length, 0);
  await queue.send({ id: 2 });
  await queue.drain(async () => { throw new Error('transport down'); });
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM pgmailcryp_jobs').get().n, 1);
  queue.claim(1, Date.now() + 100000);
  assert.equal(db.sqlite.prepare('SELECT error_code FROM pgmailcryp_jobs').get().error_code, 'RETRIES_EXHAUSTED');
  assert.ok(db.sqlite.prepare('SELECT dead_at FROM pgmailcryp_jobs').get().dead_at);
}));

test('closing and reopening the database preserves accounts, objects, sessions and in-flight delivery claims', async () => fixture(async (first, path) => {
  migrate(first, migrations);
  const db = runtimeDatabase(first);
  await db.insert(schema.user).values({ id: 'retained-user', name: 'Retained', email: 'retained@external.test', createdAt: new Date(), updatedAt: new Date() });
  const original = new Uint8Array([0, 17, 255, 128]);
  await new FileObjects(first, join(path, 'objects')).put('ciphertext-object', original);
  await new SqliteKv(first).put('session', JSON.stringify({ userId: 'retained-user' }));
  const queue = new SqliteQueue(first, 'mail-outbound', { leaseMs: 5 });
  await queue.send({ kind: 'pgp', submissionId: 'retained-intent' });
  const abandoned = queue.claim(1)[0];
  first.close();
  const reopened = new SqliteDatabase(join(path, 'mail.sqlite'));
  try {
    migrate(reopened, migrations);
    assert.equal((await runtimeDatabase(reopened).query.user.findFirst()).id, 'retained-user');
    assert.deepEqual(new Uint8Array(await (await new FileObjects(reopened, join(path, 'objects')).get('ciphertext-object')).arrayBuffer()), original);
    assert.equal((await new SqliteKv(reopened).get('session', 'json')).userId, 'retained-user');
    const replay = new SqliteQueue(reopened, 'mail-outbound', { leaseMs: 5 });
    const claim = replay.claim(1, Date.now() + 1000)[0];
    assert.equal(claim.body.submissionId, 'retained-intent');
    assert.equal(claim.attempts, 2);
    assert.equal(Number(replay.ack(abandoned)), 0);
    assert.equal(Number(replay.ack(claim)), 1);
  } finally { reopened.close(); }
}));

test('direct clients cannot spoof rate-limit identity with Cloudflare or forwarded headers', async () => {
  const { setClientAddress } = await import('../src/client-address.mjs');
  const request = { socket: { remoteAddress: '::ffff:192.0.2.10' }, headers: { 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.3', 'x-real-ip': '198.51.100.4' } };
  assert.equal(setClientAddress(request), '192.0.2.10');
  assert.equal(request.headers['cf-connecting-ip'], '192.0.2.10');
  assert.equal(request.headers['x-real-ip'], undefined);
});

test('proxy trust is explicit, loopback-only and rejects ambiguous forwarded chains', async () => {
  const { setClientAddress } = await import('../src/client-address.mjs');
  const req = (peer, value) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': value } });
  assert.equal(setClientAddress(req('127.0.0.1', '192.0.2.11'), true), '192.0.2.11');
  assert.equal(setClientAddress(req('192.0.2.99', '192.0.2.11'), true), '192.0.2.99');
  assert.equal(setClientAddress(req('127.0.0.1', '192.0.2.11, 192.0.2.12'), true), '127.0.0.1');
});
