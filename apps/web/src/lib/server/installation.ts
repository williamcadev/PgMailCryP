// SPDX-License-Identifier: Apache-2.0
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import * as schema from '@doota/db/schema';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

type InstallationEnv = { PGMAILCRYP_INSTALL_MODE?: string; PGMAILCRYP_DOMAIN?: string; PGP_SMTP_RELAY_URL?: string; PGP_SMTP_RELAY_TOKEN?: string };
export function bundledInstallation(env: InstallationEnv | undefined) {
  if (!env?.PGMAILCRYP_INSTALL_MODE) return null;
  const domain = env.PGMAILCRYP_DOMAIN ?? '';
  if (env.PGMAILCRYP_INSTALL_MODE !== 'isolated-local-test' || domain.length > 253 || !domain.includes('.') || !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    error(503, 'Configuration de l’installation groupée invalide.');
  }
  return { mode: 'isolated-local-test' as const, domain };
}

/** Only fixed health data crosses the bridge; never credentials or SMTP replies. */
export async function transportHealth(env: InstallationEnv | undefined) {
  if (!env?.PGP_SMTP_RELAY_URL || !env.PGP_SMTP_RELAY_TOKEN) return { state: 'unconfigured' as const };
  try {
    const url = new URL(env.PGP_SMTP_RELAY_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) return { state: 'unconfigured' as const };
    url.pathname = '/health'; url.search = ''; url.hash = '';
    const response = await fetch(url, { headers: { authorization: `Bearer ${env.PGP_SMTP_RELAY_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const ready = response.status === 200 && (await response.json() as { code?: string }).code === 'READY';
    return { state: ready ? 'ready' as const : 'unavailable' as const };
  } catch { return { state: 'unavailable' as const }; }
}

export async function installationStatus(db: DrizzleD1Database<typeof schema>, userId: string | undefined, env: InstallationEnv | undefined) {
  if (!userId) error(401, 'Authentification requise.');
  const actor = await db.query.user.findFirst({ where: eq(schema.user.id, userId) });
  if (actor?.role !== 'superadmin' || !actor.twoFactorEnabled || !await db.$count(schema.passkey, eq(schema.passkey.userId, userId))) error(403, 'Administrateur avec double authentification et passkey requis.');
  const config = bundledInstallation(env);
  if (!config) error(404, 'Installation groupée non configurée.');
  const organization = await db.query.organization.findFirst({ where: eq(schema.organization.domain, config.domain) });
  const boxes = organization ? await db.select({ id: schema.mailbox.id, address: schema.mailbox.address, fingerprint: schema.mailboxPgpKey.fingerprint })
    .from(schema.mailbox).innerJoin(schema.mailboxAccess, eq(schema.mailboxAccess.mailboxId, schema.mailbox.id))
    .leftJoin(schema.mailboxPgpKey, eq(schema.mailboxPgpKey.mailboxId, schema.mailbox.id))
    .where(and(eq(schema.mailbox.orgId, organization.id), eq(schema.mailboxAccess.userId, userId), eq(schema.mailbox.isPersonal, true), eq(schema.mailbox.isService, false), eq(schema.mailbox.isActive, true), eq(schema.mailboxAccess.canSend, true), eq(schema.mailboxAccess.assignedOnly, false))) : [];
  return { ...config, transport: await transportHealth(env), mailboxes: boxes, domainConfigured: !!organization && organization.status === 'active' };
}
