// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderLocalInstall } from './render.mjs';
import { bootstrapStalwart, configureStalwart, stalwartClient } from './stalwart-config.mjs';

const flags = process.argv.slice(2);
const value = (name) => { const index = flags.indexOf(name); return index < 0 ? undefined : flags[index + 1]; };
if (!value('--domain')) throw new Error('Usage: node infra/local/install.mjs --domain YOUR_DOMAIN [--state DIRECTORY] [--port 18787]');
const state = resolve(value('--state') ?? '.pgmailcryp-local');
const installation = await renderLocalInstall({ domain: value('--domain'), output: state, port: Number(value('--port') ?? 18787) });
const base = ['compose', '-f', join(state, 'compose.json')];
async function docker(args, extra = []) {
  await new Promise((accept, reject) => {
    const child = spawn('docker', [...base, ...extra, ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Docker command failed (${code}); existing data retained in ${state}`)));
  });
}
async function ready(check, label) {
  for (let i = 0; i < 90; i++) {
    try { if (await check()) return; } catch { /* Services may still be booting. */ }
    await delay(2000);
  }
  throw new Error(`${label} not ready; inspect docker compose logs locally (they may contain setup credentials)`);
}
const adminUrl = `http://127.0.0.1:${installation.adminPort}`;
const credentialFile = join(state, 'stalwart-admin.json');
let initialized = false;
try { await access(credentialFile); initialized = true; } catch { /* first install */ }
console.log(`Preparing isolated PgMailCryP + Stalwart for ${installation.domain}; no DNS changes or external mail.`);
if (!flags.includes('--skip-build')) await docker(['build', 'app']);
await docker(['up', '-d', 'app', 'bridge']);
if (!initialized) {
  // Keep the recovery value only through first bootstrap. Never put it in argv.
  const recoveryPath = join(state, 'bootstrap-recovery.env');
  let password;
  try { password = (await readFile(recoveryPath, 'utf8')).trim().split('admin:')[1]; }
  catch { password = randomBytes(32).toString('base64url'); await writeFile(recoveryPath, `STALWART_RECOVERY_ADMIN=admin:${password}\n`, { mode: 0o600 }); }
  if (!password) throw new Error('Invalid private bootstrap recovery file');
  const override = join(state, 'bootstrap-compose.json');
  await writeFile(override, JSON.stringify({ services: { stalwart: { env_file: [recoveryPath] } } }), { mode: 0o600 });
  await docker(['up', '-d', 'stalwart'], ['-f', override]);
  await ready(async () => { await stalwartClient(adminUrl, 'admin', password)('Bootstrap', 'get', { ids: ['singleton'] }); return true; }, 'Stalwart bootstrap');
  await bootstrapStalwart({ url: adminUrl, username: 'admin', password, domain: installation.domain, credentialFile });
}
await docker(['up', '-d', 'stalwart']);
const credentials = JSON.parse(await readFile(credentialFile, 'utf8'));
await ready(async () => { await stalwartClient(adminUrl, credentials.username, credentials.password)('Domain', 'get'); return true; }, 'Stalwart management');
await configureStalwart({ url: adminUrl, domain: installation.domain, credentialFile, smtpPasswordFile: join(state, 'smtp-password'), ingressPasswordFile: join(state, 'ingress-password') });
await docker(['up', '-d', '--force-recreate', 'stalwart']);
await unlink(join(state, 'bootstrap-recovery.env')).catch(() => {});
await unlink(join(state, 'bootstrap-compose.json')).catch(() => {});
await ready(async () => (await fetch(`${installation.origin}/login`, { signal: AbortSignal.timeout(5000) })).ok, 'PgMailCryP');
if (flags.includes('--test-accounts')) await docker(['exec', '-T', 'app', 'node', 'infra/local/seed-test.mjs']);
console.log(`Local services ready at ${installation.origin}. Private setup token: ${state}/secrets.json (SETUP_TOKEN).`);
console.log('Open /setup?token=YOUR_SETUP_TOKEN. This test install accepts mail only for its configured domain.');
