// SPDX-License-Identifier: Apache-2.0
/**
 * Auth boundary — escape hatches.
 *
 * The only place in app code allowed to reach Better Auth internals
 * (`$context` / `internalAdapter`) or write Better Auth-owned tables directly.
 * Each function here exists because the sanctioned paths (auth.api mutations /
 * databaseHooks) can't express it; the reason is documented inline. Everything
 * else must import from the boundary, never from Better Auth guts.
 *
 * A grep guard (scripts/check-auth-boundary.mjs, run in `pnpm check`) blocks
 * `$context` / `internalAdapter` / auth-schema imports anywhere outside
 * `src/lib/server/auth/`, so this can't regress.
 */
import { and, eq, gt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getRequestEvent } from "$app/server";
import * as schema from "@doota/db/schema";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { tryCatch } from "$lib/utils/try-catch.js";
import type { Auth } from "$lib/server/auth.js";
import type { ZoneOnboardStatus } from "$lib/server/cloudflare.js";
import { SETUP_TOKEN } from '$app/env/private';
import { error } from '@sveltejs/kit';
import { bundledInstallation } from '$lib/server/installation';
import * as mail from '@doota/db/mail.schema';
import { setupSchema } from '$lib/shared/model/auth.zod.schema';

type Ctx = Awaited<Auth["$context"]>;
type Db = DrizzleD1Database<typeof schema>;

/**
 * Better Auth context + db for the current request. `$context` lives only here.
 * Every escape hatch runs inside a request (remote functions / load), so
 * getRequestEvent is always available.
 */
async function reqCtx(): Promise<{ db: Db; ctx: Ctx }> {
  const { locals } = getRequestEvent();
  return { db: locals.db, ctx: await locals.auth.$context };
}

// ---------------------------------------------------------------------------
// D1 — genesis super-admin
// ---------------------------------------------------------------------------

/**
 * Escape hatch — create the first super-admin (web setup wizard).
 *
 * Why no sanctioned path: at genesis there is no admin session to authorize
 * `auth.api.createUser` (admin plugin), and `emailAndPassword.disableSignUp`
 * blocks `auth.api.signUpEmail`. So the first credentialed account must be
 * minted through the internal adapter. `databaseHooks.user.create.before` still
 * runs and forces role=superadmin for the first user, so the role isn't set here.
 *
 * Atomic: if the password link fails the user is rolled back, otherwise the
 * userCount === 0 gate would wedge on retry behind an orphaned, passwordless row.
 *
 * (The break-glass CLI `scripts/reset-admin.mjs` is a separate floor: it runs
 * outside the Worker runtime with no bindings, so it uses raw wrangler SQL and
 * cannot route through here.)
 */
export async function createGenesisSuperadmin(input: {
  name: string;
  email: string;
  password: string;
  image?: string;
}): Promise<{ id: string }> {
  const { ctx } = await reqCtx();
  const createdUser = await ctx.internalAdapter.createUser({
    email: input.email,
    name: input.name,
    image: input.image,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  if (!createdUser) throw new Error("Genesis createUser returned no user.");

  const { error: linkError } = await tryCatch(
    ctx.internalAdapter.linkAccount({
      providerId: "credential",
      accountId: createdUser.id,
      userId: createdUser.id,
      password: await ctx.password.hash(input.password),
    }),
  );
  if (linkError) {
    await tryCatch(ctx.internalAdapter.deleteUser(createdUser.id));
    throw linkError;
  }
  return { id: createdUser.id };
}

/**
 * Bundled genesis, authorized by the deployer's one-time token and an empty DB.
 * No authenticated organization API exists yet. Reserve the organization before
 * creating the first user to fence concurrent setup requests, then atomically
 * attach ownership, personal mailbox and grant. "active" means LOCAL routing;
 * it does not assert public DNS or Cloudflare verification. MFA is not bypassed.
 */
export async function createBundledGenesis(input: Parameters<typeof setupSchema.parse>[0]) {
  const value = setupSchema.parse(input);
  if (!SETUP_TOKEN || value.setupToken !== SETUP_TOKEN) error(403, 'Jeton de configuration invalide.');
  const { locals, platform } = getRequestEvent();
  const config = bundledInstallation(platform?.env);
  if (!config || !value.mailboxLocalPart) error(400, 'Installation groupée ou adresse locale manquante.');
  if (`${value.mailboxLocalPart}@${config.domain}`.length > 254) error(400, 'Adresse de messagerie trop longue.');
  const emailDomain = value.email.toLowerCase().split('@')[1];
  if (emailDomain === config.domain || emailDomain.endsWith(`.${config.domain}`)) error(400, 'Utilise une adresse de connexion externe au domaine installé.');
  const db = locals.db;
  if (await db.$count(schema.user)) error(409, 'La configuration initiale est déjà terminée.');
  const orgId = 'pgmailcryp-bundled';
  const claim = await db.insert(schema.organization).values({ id: orgId, name: config.domain, slug: orgId, domain: config.domain, status: 'active', metadata: JSON.stringify({ mode: config.mode }), createdAt: new Date() }).onConflictDoNothing().returning();
  if (!claim.length) error(409, 'Une configuration est déjà en cours ou interrompue. Les données existantes sont conservées.');
  invalidateDomainCache();
  let actorId: string | undefined;
  try {
    actorId = (await createGenesisSuperadmin(value)).id;
    const mailboxId = crypto.randomUUID();
    await db.batch([
      db.insert(schema.member).values({ id: crypto.randomUUID(), organizationId: orgId, userId: actorId, role: 'owner', createdAt: new Date() }),
      db.insert(mail.mailbox).values({ id: mailboxId, orgId, localPart: value.mailboxLocalPart, address: `${value.mailboxLocalPart}@${config.domain}`, displayName: value.name, isPersonal: true, searchIndexed: false }),
      db.insert(mail.mailboxAccess).values({ userId: actorId, mailboxId, canManage: true, canSend: true }),
    ]);
    return { id: actorId, mailboxId };
  } catch (cause) {
    // A failed account/password or batch must leave genesis retryable. If cleanup
    // itself fails, stop and retain the reservation rather than create duplicates.
    if (actorId) {
      const { ctx } = await reqCtx();
      await ctx.internalAdapter.deleteUser(actorId);
    }
    if (await db.$count(schema.user)) throw cause;
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    invalidateDomainCache();
    throw cause;
  }
}

// ---------------------------------------------------------------------------
// D2 — namespaced token store (recovery-email links, pwreset codes, throttles)
// ---------------------------------------------------------------------------

/**
 * Escape hatch — mint/read/consume short-lived tokens in Better Auth's
 * `verification` table under namespaced identifiers.
 *
 * Why no sanctioned path: Better Auth exposes no `auth.api` to write arbitrary
 * verification values. Our recovery-email verification links, password-reset
 * codes, and per-user send throttles reuse this BA-owned table rather than add a
 * parallel one. All reads/writes are confined here.
 */
export const tokenStore = {
  /** Store a token; expires after ttlMs. */
  async issue(identifier: string, value: string, ttlMs: number): Promise<void> {
    const { ctx } = await reqCtx();
    await ctx.internalAdapter.createVerificationValue({
      identifier,
      value,
      expiresAt: new Date(Date.now() + ttlMs),
    });
  },
  /** One-shot: return + delete the record for an identifier (null if absent). */
  async consume(identifier: string): Promise<{ value: string } | null> {
    const { ctx } = await reqCtx();
    const rec = await ctx.internalAdapter.consumeVerificationValue(identifier);
    return rec ? { value: rec.value } : null;
  },
  /** Read the active (unexpired) record for an identifier without consuming. */
  async peek(
    identifier: string,
  ): Promise<{ id: string; value: string } | null> {
    const { db } = await reqCtx();
    const rec = await db.query.verification.findFirst({
      where: and(
        eq(schema.verification.identifier, identifier),
        gt(schema.verification.expiresAt, new Date()),
      ),
    });
    return rec ? { id: rec.id, value: rec.value } : null;
  },
  /** Delete every record with this identifier (e.g. drop a prior reset code). */
  async dropByIdentifier(identifier: string): Promise<void> {
    const { db } = await reqCtx();
    await db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, identifier));
  },
  /** Delete a single record by row id (consume-on-success for peeked codes). */
  async dropById(id: string): Promise<void> {
    const { db } = await reqCtx();
    await db.delete(schema.verification).where(eq(schema.verification.id, id));
  },
};

/**
 * Per-key send throttle over the token store: true = allowed (marker set),
 * false = a live marker already exists (caller should back off). Dedupes the
 * "one request per window" pattern shared by recovery-email + password-reset.
 */
export async function throttleAllows(
  identifier: string,
  windowMs: number,
): Promise<boolean> {
  if (await tokenStore.peek(identifier)) return false;
  await tokenStore.issue(identifier, "1", windowMs);
  return true;
}

// ---------------------------------------------------------------------------
// D3 — app-owned user flags stored on the Better Auth `user` row
// ---------------------------------------------------------------------------

type UserAuthFlags = Partial<{
  recoveryEmailVerified: boolean;
  recoveryEmailVerifiedAt: number | null;
  mustChangePassword: boolean;
  onboardedAt: number;
  /** Inviter's user id, stamped once at provision time (invite chain). */
  invitedByUserId: string;
}>;

/**
 * Escape hatch — set app-owned boolean/timestamp flags that live on the BA
 * `user` row (recoveryEmailVerified, mustChangePassword, onboardedAt, ...).
 *
 * Why no sanctioned path: `auth.api` has no way to set custom additionalFields
 * on a user by id (self-update only covers input:true fields; these are
 * input:false, server-managed). Uses the internal adapter so
 * `databaseHooks.user.update.*` still runs.
 */
export async function setUserAuthFlags(
  userId: string,
  flags: UserAuthFlags,
): Promise<void> {
  const { ctx } = await reqCtx();
  await ctx.internalAdapter.updateUser(userId, flags);
}

/**
 * Escape hatch — stamp onboardedAt via the internal adapter so the session's
 * cached user (KV secondary storage + cookie cache) is refreshed alongside it
 * (updateUser → refreshUserSessions). A raw D1 write would leave the KV session
 * snapshot reporting onboardedAt=null, defeating the request-hook fast path.
 *
 * Takes the auth instance explicitly rather than via getRequestEvent: the caller
 * is the request hook, and `$context` resolves independent of the request event.
 * An onboardedAt-only update triggers no user.update side effect (the hook reacts
 * only to a recoveryEmail change).
 */
export async function stampOnboarded(auth: Auth, userId: string): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(userId, { onboardedAt: Date.now() });
}

/**
 * Escape hatch — purge a user's org memberships.
 *
 * Why no sanctioned path: admin.removeUser deletes the user + sessions + accounts
 * but doesn't cascade the organization plugin's `member` table, and D1's FK
 * cascade is unreliable at runtime. `auth.api.removeMember` keys on a
 * member-id/email (version-fragile), so a direct delete-by-userId is the robust
 * purge. Call before auth.api.removeUser so no orphan membership rows survive.
 */
export async function purgeUserMemberships(userId: string): Promise<void> {
  const { db } = await reqCtx();
  await db.delete(schema.member).where(eq(schema.member.userId, userId));
}

// ---------------------------------------------------------------------------
// D4 — organization onboarding lifecycle fields
// ---------------------------------------------------------------------------

/**
 * Escape hatch — write an org's onboarding lifecycle fields (status, zoneId).
 *
 * Why no sanctioned path: these are `input:false` org additionalFields, so
 * `auth.api.updateOrganization` refuses to set them. Written via Drizzle, then
 * `invalidateDomainCache()` to mirror the org plugin's afterUpdateOrganization
 * hook. A raw write would skip it and leave the served-domain cache stale after
 * a domain goes active (finding F1).
 */
export async function setOrgLifecycle(
  orgId: string,
  status: ZoneOnboardStatus,
  zoneId?: string,
): Promise<void> {
  const { db } = await reqCtx();
  await db
    .update(schema.organization)
    .set(zoneId ? { status, zoneId } : { status })
    .where(eq(schema.organization.id, orgId));
  invalidateDomainCache();
}
