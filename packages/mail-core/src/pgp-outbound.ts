// SPDX-License-Identifier: Apache-2.0
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@doota/db/schema';
import { buildPgpWire, pgpAddress, pgpRecipients, validatePgpCiphertext } from './pgp-wire';
import { resolveRecipient } from './resolver';
import { routingForHost } from '@doota/db/org-domains';
import { storePgpIncoming } from './pgp';
import type { OutboundJob } from './outbound';

type Db = DrizzleD1Database<typeof schema>;
export type PgpOutboundEnv = {
  MAIL_RAW: R2Bucket;
  MAIL_OUT_QUEUE: Queue<OutboundJob>;
  PGP_SMTP_RELAY_URL?: string;
  PGP_SMTP_RELAY_TOKEN?: string;
  PGP_LOCAL_DELIVERY?: "direct" | "smtp";
};
const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;

export async function pgpHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Actor and sending identity must already be checked by the boundary. */
export async function enqueuePgpSend(db: Db, env: PgpOutboundEnv, input: {
  id: string; mailboxId: string; userId: string; from: string;
  to: string[]; cc: string[]; bcc: string[]; ciphertext: string;
}) {
  if (!/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error('Invalid submission ID');
  const from = pgpAddress(input.from);
  const recipients = pgpRecipients([...input.to, ...input.cc, ...input.bcc]);
  await validatePgpCiphertext(input.ciphertext);
  const raw = buildPgpWire({ from, to: input.to, cc: input.cc, ciphertext: input.ciphertext, messageId: `<${input.id}@${from.split('@')[1]}>` });
  // Include BCC envelope in idempotency binding without putting it into MIME.
  const requestHash = await pgpHash(new TextEncoder().encode(JSON.stringify({ from, recipients, raw: base64(raw) })));
  let row = await db.query.pgpOutboxMessage.findFirst({ where: eq(schema.pgpOutboxMessage.id, input.id) });
  if (row && (row.mailboxId !== input.mailboxId || row.userId !== input.userId || row.requestHash !== requestHash)) throw new Error('SUBMISSION_CONFLICT');
  if (!row) {
    const r2Key = `pgp-outbox/${input.mailboxId}/${input.id}/${requestHash}`;
    await env.MAIL_RAW.put(r2Key, raw, { httpMetadata: { contentType: 'application/octet-stream' } });
    // Unique IDs and immutable blob paths also fence concurrent, differing requests.
    await db.insert(schema.pgpOutboxMessage).values({ id: input.id, mailboxId: input.mailboxId, userId: input.userId, fromAddress: from, r2Key, requestHash, envelopeRecipients: JSON.stringify(recipients) }).onConflictDoNothing();
    row = await db.query.pgpOutboxMessage.findFirst({ where: eq(schema.pgpOutboxMessage.id, input.id) });
    if (!row || row.mailboxId !== input.mailboxId || row.userId !== input.userId || row.requestHash !== requestHash) throw new Error('SUBMISSION_CONFLICT');
  }
  await preparePgpRecipients(db, row);
  // A failed enqueue does not erase the durable intent; same-ID retry repairs it,
  // and the scheduled sweep re-drives any recipients that were already written.
  await env.MAIL_OUT_QUEUE.send({ kind: 'pgp', submissionId: input.id });
  return { id: input.id };
}

async function preparePgpRecipients(db: Db, row: typeof schema.pgpOutboxMessage.$inferSelect) {
  for (const address of pgpRecipients(JSON.parse(row.envelopeRecipients))) {
    await db.insert(schema.pgpOutboxRecipient).values({ submissionId: row.id, address }).onConflictDoNothing();
  }
  await db.update(schema.pgpOutboxMessage).set({ prepared: true }).where(eq(schema.pgpOutboxMessage.id, row.id));
}

/** Queue and cron use the same per-recipient compare-and-set claim. */
export async function deliverPgpSubmission(db: Db, env: PgpOutboundEnv, submissionId: string) {
  const row = await db.query.pgpOutboxMessage.findFirst({ where: eq(schema.pgpOutboxMessage.id, submissionId) });
  if (!row) return;
  const [grant, box] = await Promise.all([
    db.query.mailboxAccess.findFirst({ where: and(eq(schema.mailboxAccess.userId, row.userId), eq(schema.mailboxAccess.mailboxId, row.mailboxId)) }),
    db.query.mailbox.findFirst({ where: eq(schema.mailbox.id, row.mailboxId) }),
  ]);
  const organization = box ? await db.query.organization.findFirst({ where: eq(schema.organization.id, box.orgId) }) : undefined;
  if (!row.prepared) await preparePgpRecipients(db, row);
  if (!grant?.canSend || grant.assignedOnly || !box?.isActive || !box.isPersonal || box.isService || organization?.status !== 'active') {
    await db.update(schema.pgpOutboxRecipient).set({ status: 'failed', errorCode: 'ACCESS_REVOKED' }).where(and(
      eq(schema.pgpOutboxRecipient.submissionId, row.id),
      or(eq(schema.pgpOutboxRecipient.status, 'queued'), and(eq(schema.pgpOutboxRecipient.status, 'sending'), or(isNull(schema.pgpOutboxRecipient.lastAttemptAt), lte(schema.pgpOutboxRecipient.lastAttemptAt, new Date(Date.now() - LEASE_MS))))),
    ));
    return;
  }
  const recipients = await db.query.pgpOutboxRecipient.findMany({ where: eq(schema.pgpOutboxRecipient.submissionId, submissionId) });
  const blob = await env.MAIL_RAW.get(row.r2Key);
  if (!blob) throw new Error('PGP_BLOB_UNAVAILABLE');
  const raw = new Uint8Array(await blob.arrayBuffer());
  for (const recipient of recipients) {
    if (!['queued', 'sending'].includes(recipient.status)) continue;
    const now = new Date();
    if (recipient.nextAttemptAt && recipient.nextAttemptAt > now) continue;
    const claim = await db.update(schema.pgpOutboxRecipient).set({
      status: 'sending', attempts: recipient.attempts + 1, lastAttemptAt: now,
    }).where(and(
      eq(schema.pgpOutboxRecipient.submissionId, submissionId), eq(schema.pgpOutboxRecipient.address, recipient.address),
      eq(schema.pgpOutboxRecipient.attempts, recipient.attempts),
      or(eq(schema.pgpOutboxRecipient.status, 'queued'), and(eq(schema.pgpOutboxRecipient.status, 'sending'), or(isNull(schema.pgpOutboxRecipient.lastAttemptAt), lte(schema.pgpOutboxRecipient.lastAttemptAt, new Date(now.getTime() - LEASE_MS))))),
    )).returning();
    if (!claim.length) continue;
    let state = 'sent', errorCode: string | null = null;
    try {
      const local = await resolveRecipient(db, recipient.address);
      if (local && env.PGP_LOCAL_DELIVERY !== "smtp") {
        if (!await storePgpIncoming(db, env.MAIL_RAW, local.mailboxId, raw.slice().buffer)) {
          state = 'failed'; errorCode = 'LOCAL_RECIPIENT_NOT_ENABLED';
        }
      } else if (!local && await routingForHost(db, recipient.address.split('@')[1])) {
        state = 'failed'; errorCode = 'LOCAL_RECIPIENT_UNAVAILABLE';
      } else {
        if (!env.PGP_SMTP_RELAY_URL || !env.PGP_SMTP_RELAY_TOKEN) throw new Error('RELAY_NOT_CONFIGURED');
        const url = new URL(env.PGP_SMTP_RELAY_URL);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('RELAY_URL_INVALID');
        const deliveryId = `${submissionId}:${await pgpHash(new TextEncoder().encode(recipient.address))}:${recipient.generation}`;
        const response = await fetch(url, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
          headers: { authorization: `Bearer ${env.PGP_SMTP_RELAY_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ deliveryId, envelopeFrom: row.fromAddress, envelopeTo: recipient.address, rawBase64: base64(raw) }),
        });
        if (response.status === 409) { state = 'uncertain'; errorCode = 'SMTP_ACCEPTANCE_UNCERTAIN'; }
        else if (response.status === 400) { state = 'failed'; errorCode = 'RELAY_MESSAGE_INVALID'; }
        else if (response.status === 413) { state = 'failed'; errorCode = 'RELAY_MESSAGE_TOO_LARGE'; }
        else if (response.status === 401) { state = 'failed'; errorCode = 'RELAY_AUTHENTICATION_FAILED'; }
        else if (response.status === 403) { state = 'failed'; errorCode = 'RELAY_POLICY_DENIED'; }
        else if (response.status === 422) { state = 'failed'; errorCode = 'SMTP_RECIPIENT_REJECTED'; }
        else if (response.status !== 202) throw new Error('RELAY_UNAVAILABLE');
      }
    } catch (cause) {
      state = recipient.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'queued';
      const code = cause instanceof Error ? cause.message : '';
      errorCode = ['RELAY_NOT_CONFIGURED', 'RELAY_URL_INVALID'].includes(code) ? code : state === 'failed' ? 'RETRIES_EXHAUSTED' : 'DELIVERY_TEMPORARY_FAILURE';
    }
    const retryAt = state === 'queued' ? new Date(Date.now() + Math.min(3600, 30 * 2 ** recipient.attempts) * 1000) : null;
    await db.update(schema.pgpOutboxRecipient).set({ status: state, errorCode, nextAttemptAt: retryAt }).where(and(
      eq(schema.pgpOutboxRecipient.submissionId, submissionId), eq(schema.pgpOutboxRecipient.address, recipient.address),
      eq(schema.pgpOutboxRecipient.attempts, recipient.attempts + 1), eq(schema.pgpOutboxRecipient.status, 'sending'),
    ));
  }
}

export async function sweepPgpOutbox(db: Db, queue: Queue<OutboundJob>) {
  const incomplete = await db.query.pgpOutboxMessage.findMany({ where: eq(schema.pgpOutboxMessage.prepared, false), limit: 100 });
  for (const row of incomplete) await preparePgpRecipients(db, row);
  const due = await db.select({ submissionId: schema.pgpOutboxRecipient.submissionId }).from(schema.pgpOutboxRecipient).where(or(
    and(eq(schema.pgpOutboxRecipient.status, 'queued'), or(isNull(schema.pgpOutboxRecipient.nextAttemptAt), lte(schema.pgpOutboxRecipient.nextAttemptAt, new Date()))),
    and(eq(schema.pgpOutboxRecipient.status, 'sending'), lte(schema.pgpOutboxRecipient.lastAttemptAt, new Date(Date.now() - LEASE_MS))),
  )).groupBy(schema.pgpOutboxRecipient.submissionId).limit(100);
  for (const item of due) await queue.send({ kind: 'pgp', submissionId: item.submissionId });
  return due.length;
}
