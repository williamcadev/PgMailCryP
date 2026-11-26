// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, chmod } from 'node:fs/promises';

/** Stalwart 1.2.1 JMAP configuration. Never print credential payloads or responses. */
export function stalwartClient(baseUrl, username, password) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Management API must use HTTPS outside loopback');
  return async (object, operation, args = {}) => {
    const response = await fetch(new URL('/jmap/', url), {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: [[`x:${object}/${operation}`, args, 'call']] }),
    });
    if (!response.ok) throw new Error(`Stalwart management HTTP ${response.status}`);
    const result = await response.json();
    const [method, data] = result.methodResponses?.[0] ?? [];
    if (method === 'error' || !data) throw new Error(`Stalwart ${object}/${operation}: ${data?.type ?? 'invalid response'}`);
    for (const key of ['notCreated', 'notUpdated', 'notDestroyed']) {
      if (Object.keys(data[key] ?? {}).length) {
        const errors = Object.values(data[key]).map((item) => ({ type: item.type, properties: item.properties }));
        throw new Error(`Stalwart ${object}/${operation}: ${JSON.stringify(errors)}`);
      }
    }
    return data;
  };
}

export async function bootstrapStalwart({ url, username, password, domain, credentialFile }) {
  const client = stalwartClient(url, username, password);
  const current = await client('Bootstrap', 'get', { ids: ['singleton'] });
  if (!current.list?.length) throw new Error('Not an empty Stalwart bootstrap instance');
  const settings = {
    defaultHostname: `smtp.${domain}`, defaultDomain: domain,
    requestTlsCertificate: false, generateDkimKeys: false,
    dataStore: { '@type': 'RocksDb', path: '/var/lib/stalwart/', bufferSize: 33554432, cacheSize: 67108864 },
    dnsServer: { '@type': 'Manual' },
  };
  const result = await client('Bootstrap', 'set', { update: { singleton: settings } });
  const credentials = result.updated?.singleton;
  if (!credentials?.username || !credentials.secret) throw new Error('Bootstrap did not return administrator credentials');
  await writeFile(credentialFile, JSON.stringify({ username: credentials.username, password: credentials.secret }) + '\n', { mode: 0o600 });
  await chmod(credentialFile, 0o600);
  return { restartRequired: true };
}

/** Test install only: all SMTP binds are loopback in the application's network namespace. */
export async function configureStalwart({ url, domain, credentialFile, smtpPasswordFile, ingressPasswordFile }) {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) throw new Error('Invalid test domain');
  const credentials = JSON.parse(await readFile(credentialFile, 'utf8'));
  const smtpPassword = (await readFile(smtpPasswordFile, 'utf8')).trim();
  const ingressPassword = (await readFile(ingressPasswordFile, 'utf8')).trim();
  if (smtpPassword.length < 32 || ingressPassword.length < 32) throw new Error('Bridge secrets must have at least 32 characters');
  const client = stalwartClient(url, credentials.username, credentials.password);
  const singleton = (object, value) => client(object, 'set', { update: { singleton: value } });
  async function upsert(object, value) {
    const existing = (await client(object, 'get')).list.find((item) => item.name === value.name);
    if (existing) {
      // Route/listener names and tagged object types are immutable on update.
      const { name: _name, '@type': _type, ...patch } = value;
      await client(object, 'set', { update: { [existing.id]: patch } });
      return existing.id;
    }
    const created = await client(object, 'set', { create: { managed: value } });
    const id = created.created?.managed?.id;
    if (!id) throw new Error(`Stalwart ${object}: no created ID`);
    return id;
  }
  const domainId = await upsert('Domain', { name: domain, enable: true, allowRelaying: true, catchAllAddress: null, certificateManagement: { '@type': 'Manual' }, dkimManagement: { '@type': 'Manual' }, dnsManagement: { '@type': 'Manual' }, reportAddressUri: null });
  await upsert('Account', {
    '@type': 'User', name: 'pgmailcryp-transport', domainId,
    roles: { '@type': 'User' },
    credentials: { '0': { '@type': 'Password', secret: smtpPassword } },
  });
  await upsert('MtaRoute', { '@type': 'Relay', name: 'pgmailcryp-ingress', host: '127.0.0.1', port: 2525, protocol: 'smtp', implicitTls: false, allowInvalidCerts: false, authUsername: 'stalwart', authSecret: { '@type': 'Value', secret: ingressPassword } });
  await upsert('MtaTlsStrategy', { name: 'pgmailcryp-loopback', startTls: 'disable', dane: 'disable', mtaSts: 'disable' });
  await singleton('MtaOutboundStrategy', {
    route: { match: { '0': { if: `rcpt_domain == '${domain}'`, then: "'pgmailcryp-ingress'" } }, else: "'mx'" },
    tls: { match: { '0': { if: `rcpt_domain == '${domain}'`, then: "'pgmailcryp-loopback'" } }, else: "'default'" },
  });
  await singleton('MtaStageAuth', {
    saslMechanisms: { else: '[plain, login]' },
    require: { else: 'local_port != 1025' },
    mustMatchSender: { else: `authenticated_as != 'pgmailcryp-transport@${domain}'` },
  });
  await singleton('MtaStageRcpt', { allowRelaying: { else: '!is_empty(authenticated_as)' }, maxRecipients: { else: '50' } });
  await singleton('MtaStageData', { enableSpamFilter: { else: 'false' }, maxMessageSize: { else: '10485760' }, dkimSignDomain: { else: 'false' } });
  const listeners = [
    { name: 'pgmailcryp-smtp', bind: { '127.0.0.1:1025': true }, protocol: 'smtp', useTls: false, implicitTls: false },
    { name: 'pgmailcryp-submit', bind: { '127.0.0.1:1587': true }, protocol: 'smtp', useTls: false, implicitTls: false },
    { name: 'pgmailcryp-admin', bind: { '0.0.0.0:8080': true }, protocol: 'http', useTls: false, implicitTls: false },
  ];
  for (const listener of listeners) await upsert('NetworkListener', listener);
  const extras = (await client('NetworkListener', 'get')).list.filter((item) => !listeners.some((listener) => listener.name === item.name));
  if (extras.length) await client('NetworkListener', 'set', { destroy: extras.map((item) => item.id) });
  const result = await client('Action', 'set', { create: { reload: { '@type': 'ReloadSettings' } } });
  if (Object.keys(result.created?.reload?.warnings ?? {}).length) throw new Error('Stalwart reload returned warnings; inspect locally');
  return { smtpUsername: `pgmailcryp-transport@${domain}`, restartRequired: true };
}
