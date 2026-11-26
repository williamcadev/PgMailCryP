// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { eq } from 'drizzle-orm';
import * as schema from '@doota/db/schema';
import { invalidateDomainCache } from '@doota/db/org-domains';
import { makeDb } from './mail-db';
import { setRequestEvent } from './stubs/app-server';
import { encryptPgpMail, encryptPgpDraft, decryptPgpDraft, bytesBase64, verifyContact, type PgpCompose, type PgpContact } from '$lib/client/pgp-compose';
import { decryptPgpMime, readPgpMime } from '$lib/client/pgp-inbox';
import { createIngressServer, createEgressServer, createReceiptStore, createSmtpTransport, type BridgeConfig } from '../../../mail-bridge/src/server';

const state = vi.hoisted(() => ({ databases: new WeakMap<object, any>() }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: (binding: object) => state.databases.get(binding) }));
vi.mock('$app/server', async (original) => ({ ...await original<any>(), command: (_schema: unknown, fn: any) => fn, query: (_schema: unknown, fn: any) => (arg: unknown) => Object.assign(fn(arg), { refresh: async () => {} }) }));
import { publishMailboxPgpKey, sendPgpMessage, savePgpDraft, pgpDrafts, deletePgpDraft, retryPgpSend } from '$lib/rpc/pgp.remote';
import { deliverPgpSubmission, sweepPgpOutbox } from '@doota/mail-core/pgp-outbound';
import { handleOutboundQueue } from '@doota/mail-core/outbound-consumer';
import { handleStalwartWebhook } from '@doota/mail-core/inbound-worker';
import { enqueueSend } from '@doota/mail-core/outbound';
import { createDraft, saveDraft, stageDraftAttachment } from '@doota/mail-core/drafts';
import { GET as downloadObject } from '../routes/api/pgp/[mailboxId]/objects/[kind]/[id]/+server';

let alice: openpgp.PrivateKey, bob: openpgp.PrivateKey;
let aliceContact: PgpContact, bobContact: PgpContact;
let sender: any, receiver: any, senderEnv: any, receiverEnv: any;
let cleanups: (() => Promise<void> | void)[];
let directory: string;
const token = 'local-test-token-with-more-than-32-characters';
const compose = (): PgpCompose => ({ from: 'alice@sender.test', to: ['bob@receiver.test'], cc: [], bcc: [], subject: 'TOP SECRET subject', text: 'TOP SECRET body é', attachments: [{ name: 'TOP SECRET.bin', contentType: 'application/octet-stream', base64: bytesBase64(new Uint8Array([0, 255, 3, 128])) }] });
const login = (db = sender, env = senderEnv, userId: string | null = 'owner') => setRequestEvent({ locals: { db, user: userId ? { id: userId } : null }, platform: { env } });
function bucket() {
  const objects = new Map<string, Uint8Array>();
  return { objects,
    put: vi.fn(async (key: string, value: string | ArrayBuffer | Uint8Array) => { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); }),
    get: vi.fn(async (key: string) => { const bytes = objects.get(key); return bytes ? { body: new Response(new Uint8Array(bytes)).body, arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) } : null; }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
}
async function makeSide(domain: string, address: string, key: openpgp.PrivateKey) {
  const db = await makeDb();
  await db.insert(schema.organization).values({ id: 'org', name: 'Org', slug: domain, domain, status: 'active', createdAt: new Date() });
  await db.insert(schema.user).values({ id: 'owner', name: 'Owner', email: address, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.mailbox).values({ id: 'personal', orgId: 'org', localPart: address.split('@')[0], address, isPersonal: true });
  await db.insert(schema.mailboxAccess).values({ userId: 'owner', mailboxId: 'personal', canSend: true });
  await db.insert(schema.mailboxPgpKey).values({ mailboxId: 'personal', publicKeyArmored: key.toPublic().armor(), fingerprint: key.getFingerprint().toUpperCase() });
  const DB = {};
  state.databases.set(DB, db);
  return { db, env: { DB, MAIL_RAW: bucket(), MAIL_OUT_QUEUE: { send: vi.fn(async () => {}) }, MAIL_QUEUE: { send: vi.fn(async () => {}) }, STALWART_INGRESS_TOKEN: token } };
}
async function requestSend(id = crypto.randomUUID()) {
  const input = compose();
  const encrypted = await encryptPgpMail(input, alice, [bobContact], `<${id}@sender.test>`);
  return { mailboxId: 'personal', id, to: input.to, cc: [], bcc: [], ciphertext: encrypted.ciphertext };
}
async function httpListen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function smtpListen(server: ReturnType<typeof createIngressServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.server.address() as AddressInfo).port;
}
const config = (ingressUrl: string): BridgeConfig => ({ ingressUrl, ingressToken: token, smtpUser: 'stalwart', smtpPassword: token, recipientDomains: ['receiver.test'], allowedFromDomains: ['sender.test'], httpToken: token, allowInsecureLoopback: true });
beforeAll(async () => {
  [alice, bob] = await Promise.all(['alice@sender.test', 'bob@receiver.test'].map(async (email) => (await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email }], format: 'object' })).privateKey));
  aliceContact = await verifyContact('alice@sender.test', alice.toPublic().armor(), alice.getFingerprint());
  bobContact = await verifyContact('bob@receiver.test', bob.toPublic().armor(), bob.getFingerprint());
});
beforeEach(async () => {
  cleanups = []; directory = mkdtempSync(join(tmpdir(), 'pgp-smtp-'));
  invalidateDomainCache();
  const a = await makeSide('sender.test', 'alice@sender.test', alice), b = await makeSide('receiver.test', 'bob@receiver.test', bob);
  sender = a.db; senderEnv = a.env; receiver = b.db; receiverEnv = b.env;
  login();
});
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); invalidateDomainCache(); });

describe('opaque drafts and sender storage', () => {
  it('persists a draft with exact attachment recovery and enforces revision and ownership on read/delete', async () => {
    const id = crypto.randomUUID(), ciphertext = await encryptPgpDraft(compose(), alice);
    const saved = await savePgpDraft({ mailboxId: 'personal', id, revision: 0, ciphertext });
    expect(saved.revision).toBe(1);
    const response = await downloadObject({ locals: { user: { id: 'owner' }, db: sender }, platform: { env: senderEnv }, params: { mailboxId: 'personal', kind: 'draft', id } } as any);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await decryptPgpDraft(await response.text(), alice)).toEqual(compose());
    const row = (await sender.query.pgpDraft.findMany())[0];
    expect(JSON.stringify(row)).not.toContain('TOP SECRET');
    expect([...senderEnv.MAIL_RAW.objects.values()].every((raw) => !new TextDecoder().decode(raw).includes('TOP SECRET'))).toBe(true);
    await expect(savePgpDraft({ mailboxId: 'personal', id, revision: 0, ciphertext })).rejects.toMatchObject({ status: 409 });
    await expect(deletePgpDraft({ mailboxId: 'personal', id, revision: 2 })).rejects.toMatchObject({ status: 409 });
    await expect(downloadObject({ locals: { user: { id: 'other' }, db: sender }, params: { mailboxId: 'personal', kind: 'draft', id } } as any)).rejects.toMatchObject({ status: 403 });
    await deletePgpDraft({ mailboxId: 'personal', id, revision: 1 });
    expect(await pgpDrafts('personal')).toEqual([]);
  });
  it('rejects literal packets pretending to be encrypted drafts and sends', async () => {
    const ciphertext = (await openpgp.createMessage({ text: 'readable plaintext' })).armor();
    await expect(savePgpDraft({ mailboxId: 'personal', id: crypto.randomUUID(), revision: 0, ciphertext })).rejects.toMatchObject({ status: 400 });
    await expect(sendPgpMessage({ ...await requestSend(), ciphertext })).rejects.toMatchObject({ status: 400 });
    expect(senderEnv.MAIL_RAW.put).not.toHaveBeenCalled();
  });
  it('survives a failed queue enqueue and keeps an exact immutable sent copy', async () => {
    const input = await requestSend();
    senderEnv.MAIL_OUT_QUEUE.send.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(sendPgpMessage(input)).rejects.toThrow('queue unavailable');
    expect(await sender.query.pgpOutboxMessage.findMany()).toHaveLength(1);
    await sendPgpMessage(input);
    expect(await sender.query.pgpOutboxMessage.findMany()).toHaveLength(1);
    const changed = await requestSend(input.id);
    await expect(sendPgpMessage(changed)).rejects.toMatchObject({ status: 409 });
    const response = await downloadObject({ locals: { user: { id: 'owner' }, db: sender }, platform: { env: senderEnv }, params: { mailboxId: 'personal', kind: 'sent', id: input.id } } as any);
    const read = await readPgpMime(new Uint8Array(await response.arrayBuffer()), alice, { contacts: [aliceContact] });
    expect(read.signatureStatus).toBe('verified'); expect(read.email.subject).toBe(compose().subject);
    const row = (await sender.query.pgpOutboxMessage.findMany())[0];
    const bcc = { ...input, bcc: ['eve@outside.test'] };
    await expect(sendPgpMessage(bcc)).rejects.toMatchObject({ status: 409 });
    expect((await sender.query.pgpOutboxMessage.findMany())[0].r2Key).toBe(row.r2Key);
  });
  it('repairs durable intents interrupted before recipient creation and does not need MAIL_DEK', async () => {
    const input = await requestSend(); await sendPgpMessage(input);
    await sender.delete(schema.pgpOutboxRecipient);
    await sender.update(schema.pgpOutboxMessage).set({ prepared: false });
    expect(await sweepPgpOutbox(sender, senderEnv.MAIL_OUT_QUEUE)).toBe(1);
    expect(await sender.query.pgpOutboxRecipient.findMany()).toHaveLength(1);
    expect(senderEnv.MAIL_DEK).toBeUndefined();
  });
  it('blocks legacy draft/body/attachment and outbound writes for activated mailboxes', async () => {
    await expect(createDraft(sender, null as any, 'owner', { mailboxId: 'personal', kind: 'new', subject: 'must not persist' })).rejects.toMatchObject({ status: 409 });
    await expect(enqueueSend(sender, senderEnv, { mailboxId: 'personal', orgId: 'org', createdByUserId: 'owner', fromAddress: 'alice@sender.test', to: ['bob@receiver.test'], subject: 'must not persist', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    await sender.insert(schema.draft).values({ id: 'old', orgId: 'org', mailboxId: 'personal', createdByUserId: 'owner', kind: 'new' });
    await expect(saveDraft(sender, null as any, 'owner', { draftId: 'old', clientRevision: 0, body: 'must not persist' })).rejects.toMatchObject({ status: 409 });
    await expect(stageDraftAttachment(sender, senderEnv, 'old', 'owner', { name: 'private.txt', type: 'text/plain', size: 3, bytes: new Uint8Array([1, 2, 3]).buffer })).rejects.toMatchObject({ status: 409 });
    expect(senderEnv.MAIL_RAW.put).not.toHaveBeenCalled();
    expect(await sender.query.message.findMany()).toHaveLength(0);
  });
});

describe('queue recipient states', () => {
  it('uses the Workers-compatible manual redirect mode and never follows a relay redirect', async () => {
    const input = await requestSend(); await sendPgpMessage(input);
    senderEnv.PGP_SMTP_RELAY_URL = 'http://127.0.0.1:9999/send'; senderEnv.PGP_SMTP_RELAY_TOKEN = token;
    const relay = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { location: 'https://another-host.invalid' } });
    });
    await deliverPgpSubmission(sender, senderEnv, input.id);
    expect(relay).toHaveBeenCalledTimes(1);
    expect((await sender.query.pgpOutboxRecipient.findMany())[0]).toMatchObject({ status: 'queued', attempts: 1 });
  });
  it('stops stale claims when the sending organization becomes inactive', async () => {
    const input = await requestSend(); await sendPgpMessage(input);
    await sender.update(schema.pgpOutboxRecipient).set({ status: 'sending', attempts: 1, lastAttemptAt: new Date(Date.now() - 11 * 60_000) });
    await sender.update(schema.organization).set({ status: 'error' });
    const send = vi.spyOn(globalThis, 'fetch');
    await deliverPgpSubmission(sender, senderEnv, input.id);
    expect(send).not.toHaveBeenCalled();
    expect((await sender.query.pgpOutboxRecipient.findMany())[0]).toMatchObject({ status: 'failed', errorCode: 'ACCESS_REVOKED' });
    expect(await sweepPgpOutbox(sender, senderEnv.MAIL_OUT_QUEUE)).toBe(0);
  });
  it('keeps retryable relay failures queued, fences concurrent workers and stops revoked send access', async () => {
    const input = await requestSend(); await sendPgpMessage(input);
    senderEnv.PGP_SMTP_RELAY_URL = 'http://127.0.0.1:9999/send'; senderEnv.PGP_SMTP_RELAY_TOKEN = token;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    await Promise.all([deliverPgpSubmission(sender, senderEnv, input.id), deliverPgpSubmission(sender, senderEnv, input.id)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await sender.query.pgpOutboxRecipient.findMany())[0]).toMatchObject({ status: 'queued', attempts: 1 });
    await sender.update(schema.mailboxAccess).set({ canSend: false });
    await deliverPgpSubmission(sender, senderEnv, input.id);
    expect((await sender.query.pgpOutboxRecipient.findMany())[0]).toMatchObject({ status: 'failed', errorCode: 'ACCESS_REVOKED' });
  });
  it('requires explicit acknowledgement to retry uncertain SMTP acceptance and uses a new generation', async () => {
    const input = await requestSend(); await sendPgpMessage(input);
    senderEnv.PGP_SMTP_RELAY_URL = 'http://127.0.0.1:9999/send'; senderEnv.PGP_SMTP_RELAY_TOKEN = token;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 409 }));
    await deliverPgpSubmission(sender, senderEnv, input.id);
    await expect(retryPgpSend({ mailboxId: 'personal', id: input.id, confirmPossibleDuplicate: false })).rejects.toMatchObject({ status: 409 });
    await retryPgpSend({ mailboxId: 'personal', id: input.id, confirmPossibleDuplicate: true });
    expect((await sender.query.pgpOutboxRecipient.findMany())[0]).toMatchObject({ status: 'queued', generation: 1 });
  });
});

describe('real loopback SMTP path', () => {
  it('delivers browser ciphertext over HTTP→SMTP→authenticated ingress→R2 and decrypts only at the recipient', async () => {
    const worker = createServer((req, res) => { void (async () => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      invalidateDomainCache();
      const response = await handleStalwartWebhook(new Request('https://worker/ingress/stalwart', { method: 'POST', headers: { authorization: req.headers.authorization ?? '' }, body: new Uint8Array(Buffer.concat(chunks)) }), receiverEnv);
      res.writeHead(response.status); res.end(await response.text());
    })().catch(() => { res.writeHead(503); res.end(); }); });
    const workerUrl = await httpListen(worker);
    const settings = config(workerUrl);
    const smtp = createIngressServer(settings);
    const port = await smtpListen(smtp);
    const transport = createSmtpTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: { user: 'stalwart', pass: token } });
    cleanups.push(() => transport.close());
    const receiptPath = join(directory, 'receipts.sqlite');
    const receipts = createReceiptStore(receiptPath); cleanups.push(() => receipts.close());
    const relay = createEgressServer(settings, receipts, transport);
    const relayUrl = await httpListen(relay);
    senderEnv.PGP_SMTP_RELAY_URL = `${relayUrl}/send`; senderEnv.PGP_SMTP_RELAY_TOKEN = token;
    const input = await requestSend(); await sendPgpMessage(input);
    invalidateDomainCache();
    const job = { body: { kind: 'pgp' as const, submissionId: input.id }, ack: vi.fn(), retry: vi.fn() };
    await handleOutboundQueue({ messages: [job] }, senderEnv);
    expect(job.ack).toHaveBeenCalled(); expect(job.retry).not.toHaveBeenCalled();
    expect((await sender.query.pgpOutboxRecipient.findMany())[0].status).toBe('sent');
    expect(await receiver.query.pgpInboxMessage.findMany()).toHaveLength(1);
    const stored = (await receiver.query.pgpInboxMessage.findMany())[0];
    const content = await receiverEnv.MAIL_RAW.get(stored.r2Key);
    const read = await decryptPgpMime(await content.text(), bob, { contacts: [aliceContact] });
    expect(read.email.subject).toBe(compose().subject);
    expect(read.email.text?.trim()).toBe(compose().text);
    expect(read.signatureStatus).toBe('verified');
    expect(new Uint8Array(read.email.attachments[0].content as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 3, 128]));
    for (const side of [sender, receiver]) {
      for (const table of ['message', 'attachment', 'notification', 'correspondent', 'calendarEvent']) expect(await side.query[table].findMany()).toHaveLength(0);
    }
    const out = (await sender.query.pgpOutboxMessage.findMany())[0];
    expect(await (await senderEnv.MAIL_RAW.get(out.r2Key)).text()).not.toContain('TOP SECRET');
    expect(receiverEnv.MAIL_QUEUE.send).not.toHaveBeenCalled();
    // A retried transport request with the same delivery ID is acknowledged from SQLite, without resending SMTP.
    const recipient = (await sender.query.pgpOutboxRecipient.findMany())[0];
    await sender.update(schema.pgpOutboxRecipient).set({ status: 'queued', nextAttemptAt: null });
    invalidateDomainCache();
    await deliverPgpSubmission(sender, senderEnv, input.id);
    expect(await receiver.query.pgpInboxMessage.findMany()).toHaveLength(1);
    expect(receipts.prepare('SELECT state FROM smtp_receipt').all()).toHaveLength(1);
    expect(recipient.attempts).toBe(1);
  }, 20_000);
  it('returns SMTP 451 when ingress fails and 550 for an unknown recipient; never sends 250 early', async () => {
    let code = 503;
    const smtp = createIngressServer(config('http://127.0.0.1/ingress'), vi.fn(async () => new Response('', { status: code })) as any);
    const port = await smtpListen(smtp);
    const transport = createSmtpTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: { user: 'stalwart', pass: token } });
    cleanups.push(() => transport.close());
    const message = { envelope: { from: 'alice@sender.test', to: ['bob@receiver.test'] }, raw: Buffer.from('From: alice@sender.test\r\nTo: bob@receiver.test\r\n\r\nordinary mail') };
    await expect(transport.sendMail(message)).rejects.toMatchObject({ responseCode: 451 });
    code = 422;
    await expect(transport.sendMail(message)).rejects.toMatchObject({ responseCode: 550 });
  });
});
