// SPDX-License-Identifier: Apache-2.0
import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as openpgp from 'openpgp';
import * as mail from '@doota/db/mail.schema';
import { getAuthz } from '$lib/server/authz.js';

async function requireMailboxAccess(mailboxId: string) {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	const { mailboxIds } = await getAuthz();
	if (!mailboxIds.includes(mailboxId)) error(403, 'Mailbox access required');
	const box = await locals.db.query.mailbox.findFirst({
		where: eq(mail.mailbox.id, mailboxId),
		columns: { isPersonal: true },
	});
	if (!box) error(404, 'Mailbox not found');
	return locals.db;
}

export const mailboxPgpPublicKey = query(z.string(), async (mailboxId) => {
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
		const box = await db.query.mailbox.findFirst({
			where: eq(mail.mailbox.id, mailboxId),
			columns: { isPersonal: true },
		});
		if (!box?.isPersonal) error(400, 'OpenPGP keys are currently supported for personal mailboxes only.');
		let key: openpgp.PublicKey;
		try {
			key = await openpgp.readKey({ armoredKey: publicKeyArmored });
		} catch {
			error(400, 'Invalid OpenPGP public key');
		}
		const normalized = key.armor();
		const fingerprint = key.getFingerprint().toUpperCase();
		await db.insert(mail.mailboxPgpKey).values({ mailboxId, publicKeyArmored: normalized, fingerprint })
			.onConflictDoUpdate({ target: mail.mailboxPgpKey.mailboxId, set: { publicKeyArmored: normalized, fingerprint, updatedAt: new Date() } });
		return { fingerprint };
	},
);
