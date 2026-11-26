// SPDX-License-Identifier: Apache-2.0
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import * as mail from '@doota/db/mail.schema';
import { requirePersonalPgpMailbox } from '$lib/server/pgp';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, platform, params }) => {
	await requirePersonalPgpMailbox(locals.db, locals.user?.id, params.mailboxId);
	const row = await locals.db.query.pgpInboxMessage.findFirst({
		where: and(eq(mail.pgpInboxMessage.mailboxId, params.mailboxId), eq(mail.pgpInboxMessage.id, params.id)),
	});
	if (!row) error(404, 'Message not found');
	if (!platform?.env.MAIL_RAW) error(503, 'Storage unavailable');
	const object = await platform.env.MAIL_RAW.get(row.r2Key);
	if (!object) error(503, 'Message storage unavailable');
	return new Response(object.body, { headers: {
		'Content-Type': 'application/pgp-encrypted',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
	} });
};
