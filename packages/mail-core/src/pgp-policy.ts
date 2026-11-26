// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@doota/db/schema';

/** Activated mailboxes cannot silently fall back to server-readable compose storage. */
export async function assertLegacyMailAllowed(db: DrizzleD1Database<typeof schema>, mailboxId: string) {
  const key = await db.query.mailboxPgpKey.findFirst({ where: eq(schema.mailboxPgpKey.mailboxId, mailboxId), columns: { mailboxId: true } });
  if (key) error(409, 'Use the OpenPGP composer for this mailbox; plaintext drafts and sends are disabled');
}
