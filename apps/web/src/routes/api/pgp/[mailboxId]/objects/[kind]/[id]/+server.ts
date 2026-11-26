// SPDX-License-Identifier: Apache-2.0
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import * as mail from '@doota/db/mail.schema';
import { requirePersonalPgpMailbox } from '$lib/server/pgp';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, platform }) => {
  await requirePersonalPgpMailbox(locals.db, locals.user?.id, params.mailboxId);
  const row = params.kind === 'draft'
    ? await locals.db.query.pgpDraft.findFirst({ where: and(eq(mail.pgpDraft.id, params.id), eq(mail.pgpDraft.mailboxId, params.mailboxId), eq(mail.pgpDraft.userId, locals.user!.id)) })
    : params.kind === 'sent'
      ? await locals.db.query.pgpOutboxMessage.findFirst({ where: and(eq(mail.pgpOutboxMessage.id, params.id), eq(mail.pgpOutboxMessage.mailboxId, params.mailboxId)) })
      : null;
  if (!row) error(404, 'Encrypted object not found');
  if (!platform?.env.MAIL_RAW) error(503, 'Storage unavailable');
  const object = await platform.env.MAIL_RAW.get(row.r2Key);
  if (!object) error(503, 'Encrypted object unavailable');
  return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
};
