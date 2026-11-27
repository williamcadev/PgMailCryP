// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPlatform } from './platform.mjs';
import { setClientAddress } from './client-address.mjs';

const state = resolve(process.env.PGMAILCRYP_STATE ?? '/runtime');
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const secrets = JSON.parse(await readFile(join(state, 'secrets.json'), 'utf8'));
const installation = JSON.parse(await readFile(join(state, 'installation.json'), 'utf8'));
if (!installation.domain || !installation.origin) throw new Error('Installation metadata is incomplete');
if (installation.runtime !== 'node') throw new Error('This installation requires a verified migration before using the native runtime');
const variables = {
  ORIGINS: installation.origin, SETUP_TOKEN: secrets.SETUP_TOKEN, PGMAILCRYP_INSTALL_MODE: installation.mode,
  PGMAILCRYP_DOMAIN: installation.domain, PGP_LOCAL_DELIVERY: 'smtp',
  PGP_SMTP_RELAY_URL: 'http://127.0.0.1:8788/send', LOG_LEVEL: 'warn',
};
// SvelteKit explicit env variables are initialized from process.env by adapter-node.
for (const [key, value] of Object.entries({ ...secrets, ...variables })) process.env[key] = String(value);
process.env.ORIGIN = installation.origin;
process.env.BODY_SIZE_LIMIT = '16M';
const platform = createPlatform({ directory: join(state, 'native'), migrations: process.env.PGMAILCRYP_MIGRATIONS ?? join(workspace, 'drizzle'), secrets, variables });
Object.defineProperty(globalThis, Symbol.for('pgmailcryp.platform'), { value: () => platform.requestPlatform() });
const { jobHandlers } = await import('../dist/jobs.mjs');
const handlers = jobHandlers(platform.env);
const { handler } = await import(pathToFileURL(process.env.PGMAILCRYP_WEB_BUILD ?? join(workspace, 'apps/web/build-node/handler.js')).href);
let draining = false, sweeping = false;
const active = new Set();
const track = (promise) => { const task = Promise.resolve(promise).catch(() => { console.error('Native maintenance task failed; durable jobs retained'); }).finally(() => active.delete(task)); active.add(task); };
const jobs = setInterval(() => { if (draining) return; draining = true; track((async () => { try { await platform.outbound.drain(handlers.outbound); await platform.inbound.drain(handlers.inbound); await platform.webhook.drain(handlers.webhook); } finally { draining = false; } })()); }, 1000);
const cron = setInterval(() => { if (sweeping) return; sweeping = true; track(Promise.resolve().then(handlers.sweep).finally(() => { sweeping = false; })); }, 30_000);
const server = createServer((req, res) => {
  setClientAddress(req, process.env.PGMAILCRYP_TRUST_LOOPBACK_PROXY === '1');
  if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"status":"ready","runtime":"node-sqlite"}'); return; }
  handler(req, res);
});
server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', () => console.log('PgMailCryP native server ready'));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (stopping) return; stopping = true;
  clearInterval(jobs); clearInterval(cron);
  const deadline = setTimeout(() => process.exit(1), 25_000); deadline.unref();
  server.close(async () => { await Promise.allSettled([...active]); await platform.close(); clearTimeout(deadline); });
  server.closeIdleConnections();
});
