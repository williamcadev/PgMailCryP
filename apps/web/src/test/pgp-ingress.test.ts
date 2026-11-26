// SPDX-License-Identifier: Apache-2.0
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as openpgp from 'openpgp';
import { eq } from 'drizzle-orm';
import * as schema from '@doota/db/schema';
import { makeDb } from './mail-db';
import { invalidateDomainCache } from '@doota/db/org-domains';
import { setRequestEvent } from './stubs/app-server';
import { decryptPgpMime } from '$lib/client/pgp-inbox';
import { decodeStalwartWebhook } from '@doota/mail-core/ingress';

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => state.db }));
vi.mock('$app/server', async (importOriginal) => ({
  ...await importOriginal<any>(),
  command: (_schema: unknown, fn: any) => fn,
  query: (_schema: unknown, fn: any) => (arg: unknown) => Object.assign(fn(arg), { refresh: async () => {} }),
}));
import { handleEmail, handleStalwartWebhook } from '@doota/mail-core/inbound-worker';
import { publishMailboxPgpKey, mailboxPgpPublicKey, pgpInbox } from '$lib/rpc/pgp.remote';
import { GET } from '../routes/api/pgp/[mailboxId]/[id]/+server';

let pair: { privateKey: string; publicKey: string; revocationCertificate: string };
let privateKey: openpgp.PrivateKey;
const raw = new TextEncoder().encode([
  'From: Sender <sender@outside.test>', 'To: owner@example.test',
  'Subject: secret subject', 'Message-ID: <original@outside.test>',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test"', '',
  '--test', 'Content-Type: text/plain; charset=utf-8', '', 'secret body é',
  '--test', 'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="secret.bin"', 'Content-Transfer-Encoding: base64', '',
  'AAECA/8=', '--test--', '',
].join('\r\n'));
let objects: Map<string, string>;
let env: any;
const auth = (id: string | undefined = 'owner') => setRequestEvent({ locals: { user: id ? { id } : null, db: state.db } });
const publish = () => publishMailboxPgpKey({ mailboxId: 'personal', publicKeyArmored: pair.publicKey });
const request = (payload: unknown = {}, token = 'test-secret') => new Request('https://local/ingress/stalwart', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
});
const payload = () => ({ rawBase64: Buffer.from(raw).toString('base64'), envelopeFrom: '', envelopeTo: 'owner@example.test', messageId: 'transport-id' });

beforeAll(async () => {
  pair = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'owner@example.test' }], passphrase: 'strong test passphrase' });
  privateKey = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: pair.privateKey }), passphrase: 'strong test passphrase' });
});
beforeEach(async () => {
  state.db = await makeDb();
  invalidateDomainCache();
  await state.db.insert(schema.organization).values({ id: 'org', name: 'Org', slug: 'example-test', domain: 'example.test', status: 'active', createdAt: new Date() });
  for (const id of ['owner', 'other']) {
    await state.db.insert(schema.user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }
  await state.db.insert(schema.mailbox).values([
    { id: 'personal', orgId: 'org', localPart: 'owner', address: 'owner@example.test', isPersonal: true },
    { id: 'shared', orgId: 'org', localPart: 'shared', address: 'shared@example.test', isPersonal: false },
    { id: 'other', orgId: 'org', localPart: 'other', address: 'other@example.test', isPersonal: true },
  ]);
  await state.db.insert(schema.mailboxAccess).values([
    { userId: 'owner', mailboxId: 'personal' }, { userId: 'owner', mailboxId: 'shared' }, { userId: 'other', mailboxId: 'other' },
  ]);
  objects = new Map();
  env = { STALWART_INGRESS_TOKEN: 'test-secret', DB: {},
    MAIL_RAW: {
      put: vi.fn(async (key: string, value: string) => { objects.set(key, value); }),
      get: vi.fn(async (key: string) => objects.has(key) ? { body: new Response(objects.get(key)).body } : null),
    },
    MAIL_QUEUE: { send: vi.fn() },
    // Deliberately no MAIL_DEK: sealed receipt must never need it.
  };
  auth();
});

describe('personal key registration', () => {
  it('publishes only public armor and supports idempotent publication', async () => {
    await publish(); await publish();
    const key = await mailboxPgpPublicKey('personal');
    expect(key?.fingerprint).toBe(privateKey.getFingerprint().toUpperCase());
    expect(key?.publicKeyArmored).not.toContain('PRIVATE');
    expect(await state.db.query.mailboxPgpKey.findMany()).toHaveLength(1);
  });
  it('rejects unauthenticated, foreign, shared, restricted and revoked access', async () => {
    setRequestEvent({ locals: { user: null, db: state.db } });
    await expect(publish()).rejects.toMatchObject({ status: 401 });
    auth('other'); await expect(publish()).rejects.toMatchObject({ status: 403 });
    auth(); await expect(publishMailboxPgpKey({ mailboxId: 'shared', publicKeyArmored: pair.publicKey })).rejects.toMatchObject({ status: 403 });
    await state.db.update(schema.mailboxAccess).set({ assignedOnly: true }).where(eq(schema.mailboxAccess.mailboxId, 'personal'));
    await expect(publish()).rejects.toMatchObject({ status: 403 });
    await state.db.delete(schema.mailboxAccess).where(eq(schema.mailboxAccess.mailboxId, 'personal'));
    await expect(mailboxPgpPublicKey('personal')).rejects.toMatchObject({ status: 403 });
  });
  it('rejects private, multiple, revoked, expired certificates and replacement', async () => {
    await expect(publishMailboxPgpKey({ mailboxId: 'personal', publicKeyArmored: pair.privateKey })).rejects.toMatchObject({ status: 400 });
    await expect(publishMailboxPgpKey({ mailboxId: 'personal', publicKeyArmored: pair.publicKey + '\n' + pair.publicKey })).rejects.toMatchObject({ status: 400 });
    const revoked = await openpgp.revokeKey({ key: privateKey });
    await expect(publishMailboxPgpKey({ mailboxId: 'personal', publicKeyArmored: revoked.publicKey })).rejects.toMatchObject({ status: 400 });
    const expired = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'owner@example.test' }], date: new Date('2020-01-01'), keyExpirationTime: 1 });
    await expect(publishMailboxPgpKey({ mailboxId: 'personal', publicKeyArmored: expired.publicKey })).rejects.toMatchObject({ status: 400 });
    await publish();
    const other = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'other@example.test' }] });
    await expect(publishMailboxPgpKey({ mailboxId: 'personal', publicKeyArmored: other.publicKey })).rejects.toMatchObject({ status: 409 });
  });
});

describe('sealed ingress to local MIME reader', () => {
  it('accepts Stalwart only after storage; retries dedupe and client recovers exact MIME and binary attachments', async () => {
    await publish();
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(202);
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(202);
    const rows = await pgpInbox('personal');
    expect(rows).toHaveLength(1);
    expect(objects.size).toBe(1);
    const ciphertext = [...objects.values()][0];
    expect(ciphertext).not.toContain('secret subject');
    expect(ciphertext).not.toContain('secret body');
    expect(ciphertext).not.toContain('secret.bin');
    expect(env.MAIL_QUEUE.send).not.toHaveBeenCalled();
    for (const table of ['message', 'attachment', 'thread', 'delivery', 'notification', 'calendarEvent', 'correspondent']) {
      expect(await state.db.query[table].findMany()).toHaveLength(0);
    }
    const response = await GET({ locals: { db: state.db, user: { id: 'owner' } }, platform: { env }, params: { mailboxId: 'personal', id: rows[0].id } } as any);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await decryptPgpMime(await response.text(), privateKey);
    expect(result.raw).toEqual(raw);
    expect(result.email.subject).toBe('secret subject');
    expect(result.email.text).toContain('secret body é');
    expect(new Uint8Array(result.email.attachments[0].content as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2, 3, 255]));
    const locked = await openpgp.readPrivateKey({ armoredKey: pair.privateKey });
    await expect(decryptPgpMime(ciphertext, locked)).rejects.toThrow('Déverrouille');
  });
  it('checks authorization on list and download, including access revocation', async () => {
    await publish(); await handleStalwartWebhook(request(payload()), env);
    const row = (await pgpInbox('personal'))[0];
    auth('other'); await expect(pgpInbox('personal')).rejects.toMatchObject({ status: 403 });
    await expect(GET({ locals: { db: state.db, user: { id: 'other' } }, params: { mailboxId: 'personal', id: row.id } } as any)).rejects.toMatchObject({ status: 403 });
    await state.db.delete(schema.mailboxAccess).where(eq(schema.mailboxAccess.mailboxId, 'personal'));
    await expect(GET({ locals: { db: state.db, user: { id: 'owner' } }, params: { mailboxId: 'personal', id: row.id } } as any)).rejects.toMatchObject({ status: 403 });
  });
  it('preserves retryability on storage and database failure with no plaintext fallback', async () => {
    await publish();
    env.MAIL_RAW.put.mockRejectedValueOnce(new Error('R2 unavailable'));
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(503);
    expect(await pgpInbox('personal')).toHaveLength(0);
    const insert = state.db.insert.bind(state.db);
    vi.spyOn(state.db, 'insert').mockImplementationOnce(() => { throw new Error('D1 unavailable'); });
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(503);
    state.db.insert = insert;
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(202);
    expect(await pgpInbox('personal')).toHaveLength(1);
    expect(env.MAIL_QUEUE.send).not.toHaveBeenCalled();
  });
  it('does not fall back when a registered key becomes unusable', async () => {
    await publish();
    await state.db.update(schema.mailboxPgpKey).set({ publicKeyArmored: 'corrupt certificate' });
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(503);
    expect(env.MAIL_RAW.put).not.toHaveBeenCalled();
    expect(env.MAIL_QUEUE.send).not.toHaveBeenCalled();
    expect(await pgpInbox('personal')).toHaveLength(0);
  });
  it('stores a separate ciphertext for another keyed recipient and denies cross-mailbox IDs', async () => {
    await publish();
    const other = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'other@example.test' }] });
    auth('other');
    await publishMailboxPgpKey({ mailboxId: 'other', publicKeyArmored: other.publicKey });
    expect((await handleStalwartWebhook(request({ ...payload(), envelopeTo: 'other@example.test' }), env)).status).toBe(202);
    const otherRow = (await pgpInbox('other'))[0];
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(202);
    expect(objects.size).toBe(2);
    const stored = await state.db.query.pgpInboxMessage.findMany();
    const otherCipher = objects.get(stored.find((row: any) => row.mailboxId === 'other').r2Key)!;
    await expect(decryptPgpMime(otherCipher, privateKey)).rejects.toThrow();
    // Both rows have the same MIME hash, but access must still use the mailbox.
    await expect(GET({ locals: { db: state.db, user: { id: 'owner' } }, params: { mailboxId: 'other', id: otherRow.id } } as any)).rejects.toMatchObject({ status: 403 });
    auth(); expect(await pgpInbox('personal')).toHaveLength(1);
  });
  it('retains the unkeyed legacy queue contract and its real MIME Message-ID', async () => {
    // supply a DEK only for the legacy path
    env.MAIL_DEK = btoa('0123456789abcdef0123456789abcdef');
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(202);
    expect(env.MAIL_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ messageIdHeader: '<original@outside.test>' }));
    env.MAIL_QUEUE.send.mockRejectedValueOnce(new Error('Queue unavailable'));
    expect((await handleStalwartWebhook(request(payload()), env)).status).toBe(503);
  });
  it('also seals Cloudflare receipt, including aliases', async () => {
    await publish();
    await state.db.insert(schema.alias).values({ orgId: 'org', mailboxId: 'personal', localPart: 'hidden', address: 'hidden@example.test' });
    await handleEmail({ from: 'sender@outside.test', to: 'hidden@example.test', headers: new Headers(), raw: new Response(raw).body!, setReject: vi.fn() }, env);
    expect(await pgpInbox('personal')).toHaveLength(1);
    expect(env.MAIL_QUEUE.send).not.toHaveBeenCalled();
  });
});

describe('Stalwart bridge contract', () => {
  it('rejects missing or wrong auth, invalid payloads, wrong method and unknown recipient', async () => {
    expect((await handleStalwartWebhook(request(payload()), { ...env, STALWART_INGRESS_TOKEN: '' })).status).toBe(503);
    expect((await handleStalwartWebhook(request(payload(), 'wrong'), env)).status).toBe(401);
    expect((await handleStalwartWebhook(new Request('https://local/ingress/stalwart', { headers: { authorization: 'Bearer test-secret' } }), env)).status).toBe(405);
    for (const bad of [{}, { ...payload(), envelopeTo: 42 }, { ...payload(), receivedAt: 'now' }, { ...payload(), authenticationResults: {} }, { ...payload(), rawBase64: 'x' }]) {
      expect((await handleStalwartWebhook(request(bad), env)).status).toBe(400);
    }
    expect((await handleStalwartWebhook(request({ ...payload(), envelopeTo: 'missing@example.test' }), env)).status).toBe(422);
    expect(env.MAIL_RAW.put).not.toHaveBeenCalled();
  });
  it('bounds a streaming request without Content-Length and retries interrupted transfers', async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.close();
    } });
    const req = new Request('https://local/ingress/stalwart', { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: stream, duplex: 'half' } as any);
    expect((await handleStalwartWebhook(req, env)).status).toBe(413);
    const broken = new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } });
    const brokenReq = new Request('https://local/ingress/stalwart', { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: broken, duplex: 'half' } as any);
    expect((await handleStalwartWebhook(brokenReq, env)).status).toBe(503);
  });
  it('supports SMTP null reverse-path and rejects oversized bodies', async () => {
    expect(decodeStalwartWebhook(payload()).envelopeFrom).toBe('');
    const req = request(payload());
    req.headers.set('content-length', String(20 * 1024 * 1024));
    expect((await handleStalwartWebhook(req, env)).status).toBe(413);
  });
});
