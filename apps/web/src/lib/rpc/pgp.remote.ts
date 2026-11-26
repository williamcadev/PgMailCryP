// SPDX-License-Identifier: Apache-2.0
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as mail from '@doota/db/mail.schema';
import { readRecipientKey } from '@doota/mail-core/pgp';
import { requirePersonalPgpMailbox } from '$lib/server/pgp';

async function requireMailboxAccess(mailboxId: string) {
	const { locals } = getRequestEvent();
	await requirePersonalPgpMailbox(locals.db, locals.user?.id, mailboxId);
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
		const db = await requireMailboxAccess(mailboxId);
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
