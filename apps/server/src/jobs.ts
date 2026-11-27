// SPDX-License-Identifier: Apache-2.0
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@doota/db/schema';
import { handleOutboundQueue } from '@doota/mail-core/outbound-consumer';
import { handleQueue } from '@doota/mail-core/queue-consumer';
import { runScheduledSweeps } from '@doota/mail-core/cron';
import { handleWebhookQueue } from '@doota/mail-core/webhooks';
export { schema as databaseSchema };
export function runtimeDatabase(binding: any) { return drizzle(binding, { schema }); }
export function jobHandlers(env: any) {
  const db = runtimeDatabase(env.DB);
  return { outbound: (batch: any) => handleOutboundQueue(batch, env), inbound: (batch: any) => handleQueue(batch, env), webhook: (batch: any) => handleWebhookQueue(batch, env), sweep: () => runScheduledSweeps(db, env) };
}
