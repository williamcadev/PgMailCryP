// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createEgressServer, createReceiptStore, type BridgeConfig } from '../../../mail-bridge/src/server';

const token = 'test-only-token-longer-than-thirty-two-characters';
const config: BridgeConfig = { ingressUrl: 'http://127.0.0.1/ingress/stalwart', ingressToken: token, smtpUser: 'stalwart', smtpPassword: token, recipientDomains: ['example.test'], allowedFromDomains: ['example.test'], httpToken: token, allowInsecureLoopback: true };
async function withHealth(verify: () => Promise<unknown>, check: (url: string, send: ReturnType<typeof vi.fn>) => Promise<void>) {
  const db = createReceiptStore(':memory:'), sendMail = vi.fn();
  const server = createEgressServer(config, db, { sendMail, verify });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, sendMail); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
describe('authenticated transport health', () => {
  it('requires the bridge bearer before any SMTP probe and emits no message', async () => {
    const verify = vi.fn(async () => true);
    await withHealth(verify, async (url, send) => {
      expect((await fetch(`${url}/health`)).status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
      const response = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'READY' });
      expect(verify).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    });
  });
  it('hides SMTP error details and credentials and restricts health to GET', async () => {
    const verify = vi.fn(async () => { throw new Error(`SMTP rejected password ${token}`); });
    await withHealth(verify, async (url, send) => {
      const headers = { authorization: `Bearer ${token}` };
      expect((await fetch(`${url}/health`, { method: 'POST', headers })).status).toBe(405);
      expect(verify).not.toHaveBeenCalled();
      const response = await fetch(`${url}/health`, { headers });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'SMTP_UNAVAILABLE' });
      expect(send).not.toHaveBeenCalled();
    });
  });
});
