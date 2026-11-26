// SPDX-License-Identifier: Apache-2.0
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@doota/db/schema';
import * as mail from '@doota/db/mail.schema';

/** Always consult D1: cached grants must not authorize key changes or downloads. */
export async function requirePersonalPgpMailbox(db: DrizzleD1Database<typeof schema>, userId: string | undefined, mailboxId: string, send = false) {
	if (!userId) error(401, 'Not authenticated');
	const [grant, box] = await Promise.all([
		db.query.mailboxAccess.findFirst({ where: and(eq(mail.mailboxAccess.userId, userId), eq(mail.mailboxAccess.mailboxId, mailboxId)) }),
		db.query.mailbox.findFirst({ where: eq(mail.mailbox.id, mailboxId) }),
	]);
	if (!grant || !box?.isPersonal || !box.isActive || box.isService || grant.assignedOnly || (send && !grant.canSend)) {
		error(403, 'An unrestricted grant on an active personal mailbox is required');
	}
	if (send) {
		const org = await db.query.organization.findFirst({ where: eq(schema.organization.id, box.orgId) });
		if (org?.status !== 'active') error(403, 'The sending domain is inactive');
	}
	return box;
}
