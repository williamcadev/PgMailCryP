// SPDX-License-Identifier: Apache-2.0
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as mail from '@doota/db/mail.schema';
import { readRecipientKey } from '@doota/mail-core/pgp';
import { resolveRecipient } from '@doota/mail-core/resolver';
import { MAX_PGP_CIPHERTEXT_CHARS, validatePgpCiphertext } from '@doota/mail-core/pgp-wire';
import { enqueuePgpSend } from '@doota/mail-core/pgp-outbound';
import { requirePersonalPgpMailbox } from '$lib/server/pgp';

async function requireMailboxAccess(mailboxId: string, send = false) {
	const { locals } = getRequestEvent();
	await requirePersonalPgpMailbox(locals.db, locals.user?.id, mailboxId, send);
	return locals.db;
}

export const mailboxPgpPublicKey = query(z.string().min(1), async (mailboxId) => {
	const db = await requireMailboxAccess(mailboxId);
	const row = await db.query.mailboxPgpKey.findFirst({
		where: eq(mail.mailboxPgpKey.mailboxId, mailboxId),
		columns: { publicKeyArmored: true, fingerprint: true, updatedAt: true },
	});
	return row ?? null;
});

export const publishMailboxPgpKey = command(
	z.object({ mailboxId: z.string().min(1), publicKeyArmored: z.string().min(1).max(100_000) }),
	async ({ mailboxId, publicKeyArmored }) => {
		const db = await requireMailboxAccess(mailboxId, true);
		let key;
		try { key = await readRecipientKey(publicKeyArmored); }
		catch { error(400, 'A single valid public encryption key is required'); }
		const fingerprint = key.getFingerprint().toUpperCase();
		// First publication is atomic. A concurrent different publication cannot
		// replace this key. Rotation/revocation needs a separate recovery design.
		await db.insert(mail.mailboxPgpKey).values({ mailboxId, publicKeyArmored: key.armor(), fingerprint }).onConflictDoNothing();
		const stored = await db.query.mailboxPgpKey.findFirst({ where: eq(mail.mailboxPgpKey.mailboxId, mailboxId) });
		if (stored?.fingerprint !== fingerprint) error(409, 'Key replacement is not supported; retain the original private key');
		await mailboxPgpPublicKey(mailboxId).refresh();
		return { fingerprint };
	},
);

/** Opaque message list. No sender, subject, snippet or attachment names on server. */
export const pgpInbox = query(z.string().min(1), async (mailboxId) => {
	const db = await requireMailboxAccess(mailboxId);
	return db.query.pgpInboxMessage.findMany({
		where: eq(mail.pgpInboxMessage.mailboxId, mailboxId),
		columns: { id: true, fingerprint: true, receivedAt: true },
		orderBy: [desc(mail.pgpInboxMessage.receivedAt), desc(mail.pgpInboxMessage.id)],
		limit: 50,
	});
});


const MailboxId = z.string().min(1);
const Armor = z.string().min(1).max(MAX_PGP_CIPHERTEXT_CHARS);
const ObjectId = z.uuid();

/** Directory is discovery only: the client must independently pin the fingerprint. */
export const lookupPgpRecipient = query(z.email(), async (address) => {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	const recipient = await resolveRecipient(locals.db, address);
	if (!recipient) return null;
	const box = await locals.db.query.mailbox.findFirst({ where: eq(mail.mailbox.id, recipient.mailboxId) });
	if (!box?.isPersonal || box.isService) return null;
	return await locals.db.query.mailboxPgpKey.findFirst({
		where: eq(mail.mailboxPgpKey.mailboxId, recipient.mailboxId),
		columns: { publicKeyArmored: true, fingerprint: true },
	}) ?? null;
});

function pgpStorage() {
	const env = getRequestEvent().platform?.env;
	if (!env?.MAIL_RAW) error(503, 'Encrypted storage unavailable');
	return env;
}

export const savePgpDraft = command(z.object({ mailboxId: MailboxId, id: ObjectId, revision: z.number().int().min(0), ciphertext: Armor }), async (input) => {
	const db = await requireMailboxAccess(input.mailboxId, true);
	const userId = getRequestEvent().locals.user!.id;
	const key = await db.query.mailboxPgpKey.findFirst({ where: eq(mail.mailboxPgpKey.mailboxId, input.mailboxId) });
	if (!key) error(409, 'Activate the OpenPGP mailbox first');
	try { await validatePgpCiphertext(input.ciphertext); } catch { error(400, 'Only encrypted drafts are accepted'); }
	const row = await db.query.pgpDraft.findFirst({ where: eq(mail.pgpDraft.id, input.id) });
	if (row && (row.userId !== userId || row.mailboxId !== input.mailboxId || row.revision !== input.revision)) error(409, 'Draft revision conflict');
	if (!row && input.revision !== 0) error(409, 'Draft no longer exists');
	const env = pgpStorage();
	const r2Key = `pgp-draft/${input.mailboxId}/${input.id}/${crypto.randomUUID()}`;
	await env.MAIL_RAW.put(r2Key, input.ciphertext, { httpMetadata: { contentType: 'application/pgp-encrypted' } });
	const updatedAt = new Date();
	const written = row
		? await db.update(mail.pgpDraft).set({ r2Key, updatedAt, revision: input.revision + 1 }).where(and(eq(mail.pgpDraft.id, input.id), eq(mail.pgpDraft.userId, userId), eq(mail.pgpDraft.revision, input.revision))).returning()
		: await db.insert(mail.pgpDraft).values({ id: input.id, mailboxId: input.mailboxId, userId, r2Key, updatedAt, revision: 1 }).onConflictDoNothing().returning();
	if (!written.length) { await env.MAIL_RAW.delete(r2Key); error(409, 'Draft revision conflict'); }
	if (row) await env.MAIL_RAW.delete(row.r2Key).catch(() => {}); // ciphertext-only GC; the new revision is already durable
	return { id: input.id, revision: input.revision + 1, updatedAt };
});

export const pgpDrafts = query(MailboxId, async (mailboxId) => {
	const db = await requireMailboxAccess(mailboxId);
	return db.query.pgpDraft.findMany({ where: and(eq(mail.pgpDraft.mailboxId, mailboxId), eq(mail.pgpDraft.userId, getRequestEvent().locals.user!.id)), columns: { id: true, revision: true, updatedAt: true }, orderBy: desc(mail.pgpDraft.updatedAt) });
});

export const deletePgpDraft = command(z.object({ mailboxId: MailboxId, id: ObjectId, revision: z.number().int().positive() }), async (input) => {
	const db = await requireMailboxAccess(input.mailboxId, true);
	const removed = await db.delete(mail.pgpDraft).where(and(eq(mail.pgpDraft.id, input.id), eq(mail.pgpDraft.mailboxId, input.mailboxId), eq(mail.pgpDraft.userId, getRequestEvent().locals.user!.id), eq(mail.pgpDraft.revision, input.revision))).returning();
	if (!removed.length) error(409, 'Draft revision conflict');
	await pgpStorage().MAIL_RAW.delete(removed[0].r2Key).catch(() => {});
	return { deleted: true };
});

export const sendPgpMessage = command(z.object({
	mailboxId: MailboxId, id: ObjectId, to: z.array(z.email()).max(50), cc: z.array(z.email()).max(50), bcc: z.array(z.email()).max(50), ciphertext: Armor,
}), async (input) => {
	const { locals } = getRequestEvent();
	const box = await requirePersonalPgpMailbox(locals.db, locals.user?.id, input.mailboxId, true);
	const key = await locals.db.query.mailboxPgpKey.findFirst({ where: eq(mail.mailboxPgpKey.mailboxId, input.mailboxId) });
	if (!key) error(409, 'Activate the OpenPGP mailbox first');
	const env = pgpStorage();
	if (!env.MAIL_OUT_QUEUE) error(503, 'Outbound queue unavailable');
	if (!input.to.length && !input.cc.length && !input.bcc.length) error(400, 'A recipient is required');
	try { await validatePgpCiphertext(input.ciphertext); } catch { error(400, 'Only encrypted mail is accepted'); }
	try {
		return await enqueuePgpSend(locals.db, env, { ...input, userId: locals.user!.id, from: box.address });
	} catch (cause) {
		if (cause instanceof Error && cause.message === 'SUBMISSION_CONFLICT') error(409, 'Submission ID already used for different content');
		throw cause;
	}
});

export const pgpSent = query(MailboxId, async (mailboxId) => {
	const db = await requireMailboxAccess(mailboxId);
	const rows = await db.query.pgpOutboxMessage.findMany({ where: eq(mail.pgpOutboxMessage.mailboxId, mailboxId), columns: { id: true, createdAt: true }, orderBy: desc(mail.pgpOutboxMessage.createdAt), limit: 50 });
	return Promise.all(rows.map(async (row) => ({ ...row, recipients: await db.query.pgpOutboxRecipient.findMany({ where: eq(mail.pgpOutboxRecipient.submissionId, row.id), columns: { address: true, status: true, errorCode: true, attempts: true } }) })));
});

export const retryPgpSend = command(z.object({ mailboxId: MailboxId, id: ObjectId, confirmPossibleDuplicate: z.boolean().default(false) }), async (input) => {
	const db = await requireMailboxAccess(input.mailboxId, true);
	const row = await db.query.pgpOutboxMessage.findFirst({ where: and(eq(mail.pgpOutboxMessage.mailboxId, input.mailboxId), eq(mail.pgpOutboxMessage.id, input.id), eq(mail.pgpOutboxMessage.userId, getRequestEvent().locals.user!.id)) });
	if (!row) error(404, 'Submission not found');
	const states = await db.query.pgpOutboxRecipient.findMany({ where: eq(mail.pgpOutboxRecipient.submissionId, row.id) });
	if (states.some((state) => state.status === 'uncertain') && !input.confirmPossibleDuplicate) error(409, 'SMTP acceptance is uncertain; a retry can duplicate delivery');
	const env = pgpStorage();
	await db.update(mail.pgpOutboxRecipient).set({ status: 'queued', attempts: 0, nextAttemptAt: null, errorCode: null, generation: sql`${mail.pgpOutboxRecipient.generation} + 1` }).where(and(eq(mail.pgpOutboxRecipient.submissionId, row.id), inArray(mail.pgpOutboxRecipient.status, input.confirmPossibleDuplicate ? ['failed', 'uncertain'] : ['failed'])));
	// A generation is an explicit new attempt; previous accepted receipts remain immutable.
	await env.MAIL_OUT_QUEUE.send({ kind: 'pgp', submissionId: row.id });
	return { queued: true };
});
