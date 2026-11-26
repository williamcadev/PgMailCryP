// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function renderLocalInstall({ domain, output, port = 18787 }) {
  domain = String(domain ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) || domain.includes('..')) throw new Error('Provide this installation’s domain with --domain');
  if (!Number.isInteger(port) || port < 1024 || port > 65513) throw new Error('Invalid application port');
  const directory = resolve(output);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const metadataPath = join(directory, 'installation.json');
  let previous;
  try { previous = JSON.parse(await readFile(metadataPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (previous.domain !== domain || previous.port !== port)) throw new Error('This state directory belongs to another installation; choose a different --output');
  async function privateFile(name, value) { const path = join(directory, name); await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600); }
  let secrets;
  try { secrets = JSON.parse(await readFile(join(directory, 'secrets.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secrets = Object.fromEntries(['BETTER_AUTH_SECRET', 'MAIL_DEK', 'MAIL_SEARCH_KEY', 'SETUP_TOKEN', 'CRON_SECRET', 'STALWART_INGRESS_TOKEN', 'PGP_SMTP_RELAY_TOKEN', 'BRIDGE_SMTP_PASSWORD', 'SMTP_RELAY_PASSWORD'].map((name) => [name, randomBytes(32).toString('base64')]));
    await privateFile('secrets.json', JSON.stringify(secrets));
  }
  const project = previous?.project ?? `pgmailcryp-${createHash('sha256').update(`${domain}\0${directory}\0${port}`).digest('hex').slice(0, 10)}`;
  const origin = `http://localhost:${port}`;
  const { BRIDGE_SMTP_PASSWORD: _bridgePassword, SMTP_RELAY_PASSWORD: _relayPassword, ...workerSecrets } = secrets;
  const vars = { ...workerSecrets, PGMAILCRYP_INSTALL_MODE: 'isolated-local-test', PGMAILCRYP_DOMAIN: domain, ORIGINS: origin, PGP_SMTP_RELAY_URL: 'http://127.0.0.1:8788/send', PGP_LOCAL_DELIVERY: 'smtp', LOG_LEVEL: 'warn' };
  await privateFile('.dev.vars', Object.entries(vars).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n');
  const base = {
    compatibility_date: '2026-04-28', compatibility_flags: ['nodejs_als', 'nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: 'pgmailcryp-local', database_id: '00000000-0000-4000-8000-000000000001', migrations_dir: '/app/drizzle' }],
    r2_buckets: [{ binding: 'MAIL_RAW', bucket_name: 'pgmailcryp-local' }],
  };
  const producers = [{ binding: 'MAIL_QUEUE', queue: 'doota-mail-inbound-local' }, { binding: 'MAIL_OUT_QUEUE', queue: 'doota-mail-outbound-local' }];
  const web = { ...base, name: 'pgmailcryp-web-local', main: '/app/apps/web/.svelte-kit/cloudflare/_worker.js', assets: { binding: 'ASSETS', directory: '/app/apps/web/.svelte-kit/cloudflare' }, kv_namespaces: [{ binding: 'AUTH_KV', id: '00000000000000000000000000000001' }], queues: { producers }, durable_objects: { bindings: [{ name: 'MAIL_EVENTS', class_name: 'MailEventHub', script_name: 'doota-mail-jobs-local' }] } };
  const inbound = { ...base, name: 'doota-mail-inbound-local', main: '/app/apps/mail-in/src/index.ts', queues: { producers, consumers: [{ queue: 'doota-mail-inbound-local', max_batch_size: 1, max_retries: 5 }] } };
  const jobs = { ...base, name: 'doota-mail-jobs-local', main: '/app/apps/mail-jobs/src/index.ts', queues: { producers: [producers[1]], consumers: [{ queue: 'doota-mail-outbound-local', max_batch_size: 1, max_retries: 5 }] }, durable_objects: { bindings: [{ name: 'MAIL_EVENTS', class_name: 'MailEventHub' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['MailEventHub'] }] };
  for (const [name, config] of Object.entries({ web, inbound, jobs })) await privateFile(`${name}.json`, JSON.stringify(config, null, 2));
  const bridge = {
    STALWART_INGRESS_URL: 'http://127.0.0.1:8787/ingress/stalwart', STALWART_INGRESS_TOKEN: secrets.STALWART_INGRESS_TOKEN,
    BRIDGE_SMTP_HOST: '127.0.0.1', BRIDGE_SMTP_PORT: '2525', BRIDGE_SMTP_USER: 'stalwart', BRIDGE_SMTP_PASSWORD: secrets.BRIDGE_SMTP_PASSWORD,
    BRIDGE_RECIPIENT_DOMAINS: domain, BRIDGE_ALLOWED_FROM_DOMAINS: domain, BRIDGE_ALLOWED_TO_DOMAINS: domain,
    BRIDGE_HTTP_HOST: '127.0.0.1', BRIDGE_HTTP_PORT: '8788', PGP_SMTP_RELAY_TOKEN: secrets.PGP_SMTP_RELAY_TOKEN,
    BRIDGE_STATE_DIR: '/runtime/bridge-state', BRIDGE_ALLOW_INSECURE_LOOPBACK: '1',
    SMTP_RELAY_HOST: '127.0.0.1', SMTP_RELAY_PORT: '1587', SMTP_RELAY_SECURE: '0', SMTP_RELAY_USER: `pgmailcryp-transport@${domain}`, SMTP_RELAY_PASSWORD: secrets.SMTP_RELAY_PASSWORD,
    SMTP_EHLO_NAME: `pgmailcryp.${domain}`,
  };
  await privateFile('bridge.env', Object.entries(bridge).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  await privateFile('smtp-password', secrets.SMTP_RELAY_PASSWORD);
  await privateFile('ingress-password', secrets.BRIDGE_SMTP_PASSWORD);
  const versions = JSON.parse(await readFile(new URL('./versions.json', import.meta.url), 'utf8'));
  const source = fileURLToPath(new URL('../..', import.meta.url));
  const compose = {
    name: project,
    services: {
      network: { image: versions.node, command: ['node', '--max-old-space-size=16', '-e', 'setInterval(() => {}, 3600000)'], restart: 'unless-stopped', init: true, mem_limit: '64m', cpus: 0.1,
        ports: [`127.0.0.1:${port}:8787`, `127.0.0.1:${port + 22}:8080`] },
      app: { build: { context: source, dockerfile: 'infra/local/Dockerfile' }, image: `${project}:local`, network_mode: 'service:network', depends_on: ['network'], restart: 'unless-stopped', init: true, mem_limit: '2304m', cpus: 1.5,
        volumes: [`${directory}:/runtime`],
        environment: { WRANGLER_SEND_METRICS: 'false', CI: 'true' } },
      bridge: { image: `${project}:local`, command: ['node', 'apps/mail-bridge/src/index.ts'], network_mode: 'service:network', depends_on: ['network', 'app'], restart: 'unless-stopped', init: true, mem_limit: '256m',
        env_file: [`${directory}/bridge.env`], volumes: [`${directory}:/runtime`] },
      stalwart: { image: versions.stalwart, network_mode: 'service:network', depends_on: ['network', 'app'], restart: 'unless-stopped', mem_limit: '768m', cpus: 1,
        volumes: ['stalwart-config:/etc/stalwart', 'stalwart-data:/var/lib/stalwart'] },
    },
    volumes: { 'stalwart-config': {}, 'stalwart-data': {} },
  };
  await privateFile('compose.json', JSON.stringify(compose, null, 2));
  const metadata = { version: 1, domain, port, adminPort: port + 22, origin, project, mode: 'isolated-local-test' };
  await privateFile('installation.json', JSON.stringify(metadata, null, 2));
  return metadata;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => { if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]); return pairs; }, []));
  if (!args.domain || !args.output) throw new Error('Usage: node infra/local/render.mjs --domain YOUR_DOMAIN --output STATE_DIRECTORY [--port 18787]');
  console.log(JSON.stringify(await renderLocalInstall({ domain: args.domain, output: args.output, port: Number(args.port ?? 18787) })));
}
