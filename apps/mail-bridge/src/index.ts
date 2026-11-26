// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { createEgressServer, createIngressServer, createReceiptStore, type BridgeConfig } from './server.ts';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const secret = (name: string) => { const value = required(name); if (value.length < 32) throw new Error(`${name} must have at least 32 characters`); return value; };
const domains = (name: string) => required(name).split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean);
const local = process.env.BRIDGE_ALLOW_INSECURE_LOOPBACK === '1';
const smtpHost = process.env.BRIDGE_SMTP_HOST ?? '127.0.0.1';
const httpHost = process.env.BRIDGE_HTTP_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(httpHost)) throw new Error('Bind the HTTP API to loopback and use an HTTPS reverse proxy or tunnel');
if (local && (![smtpHost, httpHost].every((host) => ['127.0.0.1', '::1', 'localhost'].includes(host)))) throw new Error('Insecure test mode can bind only to loopback');
const config: BridgeConfig = {
  ingressUrl: required('STALWART_INGRESS_URL'), ingressToken: secret('STALWART_INGRESS_TOKEN'),
  smtpUser: process.env.BRIDGE_SMTP_USER ?? 'stalwart', smtpPassword: secret('BRIDGE_SMTP_PASSWORD'),
  recipientDomains: domains('BRIDGE_RECIPIENT_DOMAINS'), allowedFromDomains: domains('BRIDGE_ALLOWED_FROM_DOMAINS'),
  ...(process.env.BRIDGE_ALLOWED_TO_DOMAINS ? { allowedToDomains: domains('BRIDGE_ALLOWED_TO_DOMAINS') } : {}),
  httpToken: secret('PGP_SMTP_RELAY_TOKEN'), allowInsecureLoopback: local,
  tls: local ? undefined : { cert: readFileSync(required('BRIDGE_TLS_CERT'), 'utf8'), key: readFileSync(required('BRIDGE_TLS_KEY'), 'utf8') },
};
const stateDir = required('BRIDGE_STATE_DIR');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const statePath = join(stateDir, 'smtp-receipts.sqlite');
const receipts = createReceiptStore(statePath);
chmodSync(statePath, 0o600);
const relayHost = required('SMTP_RELAY_HOST');
const secure = process.env.SMTP_RELAY_SECURE === '1';
const relayLocal = local && ['127.0.0.1', '::1', 'localhost'].includes(relayHost);
const relayUser = process.env.SMTP_RELAY_USER;
const relay = nodemailer.createTransport({
  name: process.env.SMTP_EHLO_NAME ?? `pgmailcryp.${config.allowedFromDomains[0]}`,
  host: relayHost, port: Number(process.env.SMTP_RELAY_PORT ?? (secure ? 465 : 587)), secure,
  requireTLS: !secure && !relayLocal, tls: { rejectUnauthorized: true },
  ...(relayUser ? { auth: { user: relayUser, pass: required('SMTP_RELAY_PASSWORD') } } : {}),
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  logger: false, debug: false,
});
const incoming = createIngressServer(config);
const outgoing = createEgressServer(config, receipts, relay);
incoming.on('error', () => { console.error('SMTP bridge listener failed'); process.exitCode = 1; });
outgoing.on('error', () => { console.error('HTTP bridge listener failed'); process.exitCode = 1; });
incoming.listen(Number(process.env.BRIDGE_SMTP_PORT ?? 2525), smtpHost);
outgoing.listen(Number(process.env.BRIDGE_HTTP_PORT ?? 8788), httpHost);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  incoming.close(() => {});
  outgoing.close(() => { relay.close(); receipts.close(); });
});
