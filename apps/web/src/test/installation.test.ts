// SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@doota/db/schema';
import { makeDb } from './mail-db';
import { setRequestEvent } from './stubs/app-server';
import { createBundledGenesis } from '$lib/server/auth/escape-hatches';
import { bundledInstallation, installationStatus, transportHealth } from '$lib/server/installation';
import { getOnboardingStatus } from '$lib/server/onboarding';
import { invalidateDomainCache } from '@doota/db/org-domains';

let db: any, adapter: any;
const env = { PGMAILCRYP_INSTALL_MODE: 'isolated-local-test', PGMAILCRYP_DOMAIN: 'example.test', PGP_SMTP_RELAY_URL: 'http://127.0.0.1:8788/send', PGP_SMTP_RELAY_TOKEN: 'test-bridge-secret' };
const input = () => ({ setupToken: 'test-setup-token', name: 'Admin', email: 'admin@external.test', password: 'a-strong-test-password', mailboxLocalPart: 'hello' });
function event(environment: unknown = env) { setRequestEvent({ locals: { db, auth: { $context: Promise.resolve({ internalAdapter: adapter, password: { hash: async () => 'test-password-hash' } }) } }, platform: { env: environment } }); }
beforeEach(async () => {
  db = await makeDb(); invalidateDomainCache();
  adapter = {
    createUser: vi.fn(async (value: any) => { const id = crypto.randomUUID(); await db.insert(schema.user).values({ ...value, id, role: 'superadmin' }); return { id }; }),
    linkAccount: vi.fn(async (value: any) => { await db.insert(schema.account).values({ ...value, id: crypto.randomUUID(), updatedAt: new Date() }); }),
    deleteUser: vi.fn(async (id: string) => { await db.delete(schema.user).where(eq(schema.user.id, id)); }),
  };
  event();
});
afterEach(() => { vi.restoreAllMocks(); invalidateDomainCache(); setRequestEvent(undefined); });

describe('bundled first-run configuration', () => {
  it('creates the administrator, domain, owner membership and personal mailbox without private keys or DNS calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await createBundledGenesis(input());
    expect((await db.query.organization.findMany())[0]).toMatchObject({ domain: 'example.test', status: 'active', zoneId: null });
    expect((await db.query.member.findMany())[0]).toMatchObject({ userId: result.id, role: 'owner' });
    expect((await db.query.mailbox.findMany())[0]).toMatchObject({ id: result.mailboxId, address: 'hello@example.test', isPersonal: true, searchIndexed: false });
    expect((await db.query.mailboxAccess.findMany())[0]).toMatchObject({ userId: result.id, mailboxId: result.mailboxId, canSend: true, assignedOnly: false });
    expect(await db.query.mailboxPgpKey.findMany()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    const status = await getOnboardingStatus(db, { id: result.id, role: 'superadmin' });
    expect(status.steps.find((step) => step.id === 'onboard-domain')?.done).toBe(true);
    expect(status.steps.find((step) => step.id === 'secure-account')?.done).toBe(false);
    expect(status.complete).toBe(false);
  });
  it('rejects incorrect tokens, hosted admin login addresses and requests outside the explicit bundled mode', async () => {
    await expect(createBundledGenesis({ ...input(), setupToken: 'wrong' })).rejects.toMatchObject({ status: 403 });
    await expect(createBundledGenesis({ ...input(), email: 'admin@example.test' })).rejects.toMatchObject({ status: 400 });
    await expect(createBundledGenesis({ ...input(), email: 'admin@sub.example.test' })).rejects.toMatchObject({ status: 400 });
    await expect(createBundledGenesis({ ...input(), mailboxLocalPart: 'bad..name' })).rejects.toBeDefined();
    event({ ...env, PGMAILCRYP_DOMAIN: [63, 63, 63, 60].map((size) => 'a'.repeat(size)).join('.') });
    await expect(createBundledGenesis(input())).rejects.toMatchObject({ status: 400 });
    event({}); await expect(createBundledGenesis(input())).rejects.toMatchObject({ status: 400 });
    expect(await db.$count(schema.user)).toBe(0); expect(await db.$count(schema.organization)).toBe(0);
    expect(adapter.createUser).not.toHaveBeenCalled();
  });
  it('fences concurrent setup and locks permanently after the first account exists', async () => {
    const results = await Promise.allSettled([createBundledGenesis(input()), createBundledGenesis({ ...input(), email: 'other@external.test' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(adapter.createUser).toHaveBeenCalledTimes(1);
    expect(await db.$count(schema.organization)).toBe(1); expect(await db.$count(schema.mailbox)).toBe(1);
    await expect(createBundledGenesis(input())).rejects.toMatchObject({ status: 409 });
  });
  it('rolls back failed password linkage and leaves setup retryable', async () => {
    adapter.linkAccount.mockRejectedValueOnce(new Error('password-store unavailable'));
    await expect(createBundledGenesis(input())).rejects.toThrow('password-store unavailable');
    expect(await db.$count(schema.user)).toBe(0); expect(await db.$count(schema.organization)).toBe(0);
    expect(await db.$count(schema.mailbox)).toBe(0);
    await expect(createBundledGenesis(input())).resolves.toHaveProperty('mailboxId');
  });
  it('rolls back account and domain if the mailbox batch fails', async () => {
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(createBundledGenesis(input())).rejects.toThrow('storage unavailable');
    expect(await db.$count(schema.user)).toBe(0); expect(await db.$count(schema.organization)).toBe(0);
    expect(await db.$count(schema.mailboxAccess)).toBe(0);
  });
  it('retains an interrupted reservation for operator recovery instead of overwriting it', async () => {
    await db.insert(schema.organization).values({ id: 'pgmailcryp-bundled', name: 'Existing', slug: 'pgmailcryp-bundled', domain: 'example.test', status: 'active', createdAt: new Date() });
    await expect(createBundledGenesis(input())).rejects.toMatchObject({ status: 409 });
    expect(adapter.createUser).not.toHaveBeenCalled(); expect(await db.$count(schema.organization)).toBe(1);
  });
});

describe('installation status boundaries', () => {
  it('requires a fresh superadmin role, TOTP and a passkey before probing transport', async () => {
    const { id } = await createBundledGenesis(input());
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 'READY' }));
    await expect(installationStatus(db, undefined, env)).rejects.toMatchObject({ status: 401 });
    await expect(installationStatus(db, id, env)).rejects.toMatchObject({ status: 403 });
    await db.update(schema.user).set({ twoFactorEnabled: true });
    await expect(installationStatus(db, id, env)).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
    await db.insert(schema.passkey).values({ id: 'pk', publicKey: 'public-test', userId: id, credentialID: 'credential-test', counter: 0, deviceType: 'multiDevice', backedUp: true });
    const status = await installationStatus(db, id, env);
    expect(status.transport.state).toBe('ready'); expect(status.mailboxes[0].address).toBe('hello@example.test');
    expect(JSON.stringify(status)).not.toContain(env.PGP_SMTP_RELAY_TOKEN);
    await db.update(schema.user).set({ role: 'member' });
    await expect(installationStatus(db, id, env)).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed for invalid installer configuration and remote insecure transport', async () => {
    expect(bundledInstallation({})).toBeNull();
    expect(() => bundledInstallation({ ...env, PGMAILCRYP_DOMAIN: 'a..test' })).toThrow();
    expect(() => bundledInstallation({ ...env, PGMAILCRYP_INSTALL_MODE: 'production' })).toThrow();
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await transportHealth({ ...env, PGP_SMTP_RELAY_URL: 'http://remote.test/send' })).state).toBe('unconfigured');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('authenticates a fixed health path, refuses redirects and returns no transport secrets', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://remote.test' } }));
    expect(await transportHealth(env)).toEqual({ state: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]?.toString()).toBe('http://127.0.0.1:8788/health');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', headers: { authorization: `Bearer ${env.PGP_SMTP_RELAY_TOKEN}` } });
  });
});
