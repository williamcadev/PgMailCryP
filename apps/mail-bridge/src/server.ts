// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { SMTPServer } from 'smtp-server';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { MAX_PGP_WIRE_BYTES, mimeHeader, pgpAddress, splitMimeMultipart, validatePgpCiphertext } from '@doota/mail-core/pgp-wire';

export const createSmtpTransport = (options: SMTPTransport.Options) => nodemailer.createTransport(options);

export type BridgeConfig = {
  ingressUrl: string; ingressToken: string;
  smtpUser: string; smtpPassword: string;
  recipientDomains: string[]; allowedFromDomains: string[]; allowedToDomains?: string[];
  httpToken: string;
  allowInsecureLoopback?: boolean;
  tls?: { key: string; cert: string };
};
const digest = (text: string) => createHash('sha256').update(text).digest();
const matches = (provided: string, expected: string) => timingSafeEqual(digest(provided), digest(expected));
const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });
const domainAllowed = (address: string, domains: string[]) => domains.includes(pgpAddress(address).split('@')[1]);

export function createIngressServer(config: BridgeConfig, send: typeof fetch = fetch) {
  if (!config.allowInsecureLoopback && !config.tls) throw new Error('SMTP TLS certificate and key are required');
  const url = new URL(config.ingressUrl);
  if (url.protocol !== 'https:' && !(config.allowInsecureLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('Ingress URL must use HTTPS');
  return new SMTPServer({
    name: 'pgmailcryp-bridge', banner: 'PgMailCryP authenticated delivery bridge',
    size: MAX_PGP_WIRE_BYTES, authOptional: false, logger: false,
    key: config.tls?.key, cert: config.tls?.cert,
    disabledCommands: config.allowInsecureLoopback ? ['STARTTLS'] : [],
    allowInsecureAuth: !!config.allowInsecureLoopback,
    onAuth(auth, _session, callback) {
      if (!matches(auth.username ?? '', config.smtpUser) || !matches(auth.password ?? '', config.smtpPassword)) return callback(smtpError(535, 'Authentication failed'));
      callback(null, { user: config.smtpUser });
    },
    onRcptTo(address, session, callback) {
      // SMTP has one final DATA response. Restrict transactions to one RCPT so
      // a partial multi-recipient HTTP failure cannot acknowledge or bounce peers.
      if (session.envelope.rcptTo.length >= 1) return callback(smtpError(452, 'One recipient per transaction; defer remaining recipients'));
      try { if (!domainAllowed(address.address, config.recipientDomains)) return callback(smtpError(550, 'Recipient domain not handled')); }
      catch { return callback(smtpError(550, 'Invalid recipient')); }
      callback();
    },
    onData(stream, session, callback) {
      let completed = false;
      const finish: typeof callback = (...args) => { if (!completed) { completed = true; callback(...args); } };
      let size = 0;
      let chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_PGP_WIRE_BYTES) chunks.push(chunk); else chunks = []; });
      stream.once('error', () => finish(smtpError(451, 'Transfer interrupted; retain delivery')));
      stream.once('end', () => {
        void (async () => {
          if (completed) return;
          if (stream.sizeExceeded || size > MAX_PGP_WIRE_BYTES) return finish(smtpError(552, 'Message too large'));
          const recipient = session.envelope.rcptTo[0]?.address;
          if (!recipient) return finish(smtpError(550, 'Recipient required'));
          try {
            const response = await send(config.ingressUrl, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
              headers: { authorization: `Bearer ${config.ingressToken}`, 'content-type': 'application/json' },
              body: JSON.stringify({ rawBase64: Buffer.concat(chunks).toString('base64'), envelopeFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', envelopeTo: recipient }),
            });
            if (response.status === 202) finish(null, 'Persisted by PgMailCryP');
            else if (response.status === 422) finish(smtpError(550, 'Recipient unavailable'));
            else if ([400, 413].includes(response.status)) finish(smtpError(554, 'Invalid or oversized delivery'));
            else finish(smtpError(451, 'Ingress unavailable; retain and retry delivery'));
          } catch { finish(smtpError(451, 'Ingress unavailable; retain and retry delivery')); }
        })();
      });
    },
  });
}

export function createReceiptStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS smtp_receipt (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return db;
}
type Receipt = { id: string; payload_hash: string; state: string; updated_at: number };
const reply = (res: ServerResponse, status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ code })); };
async function readPayload(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_PGP_WIRE_BYTES * 1.4) throw new Error('TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

/** Authenticated HTTP → SMTP transport. Receipts survive service restarts. */
export function createEgressServer(config: BridgeConfig, db: DatabaseSync, transport: Pick<Transporter<SMTPTransport.SentMessageInfo>, 'sendMail'>) {
  return createServer((req, res) => {
    void (async () => {
      if (req.url !== '/send') return reply(res, 404, 'NOT_FOUND');
      if (!matches(req.headers.authorization ?? '', `Bearer ${config.httpToken}`)) return reply(res, 401, 'UNAUTHORIZED');
      if (req.method !== 'POST') return reply(res, 405, 'POST_REQUIRED');
      let input: Record<string, unknown>, from: string, to: string, raw: Buffer, id: string;
      try {
        input = await readPayload(req);
        if (typeof input.deliveryId !== 'string' || !/^[a-f0-9-]{36}:[a-f0-9]{64}(?::\d+)?$/i.test(input.deliveryId)) throw new Error('Invalid ID');
        id = input.deliveryId;
        if (typeof input.envelopeFrom !== 'string' || typeof input.envelopeTo !== 'string' || typeof input.rawBase64 !== 'string' || input.rawBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.rawBase64)) throw new Error('Invalid envelope');
        from = pgpAddress(input.envelopeFrom); to = pgpAddress(input.envelopeTo);
        if (!domainAllowed(from, config.allowedFromDomains)) return reply(res, 403, 'SENDER_DOMAIN_DENIED');
        if (config.allowedToDomains?.length && !domainAllowed(to, config.allowedToDomains)) return reply(res, 403, 'RECIPIENT_DOMAIN_DENIED');
        raw = Buffer.from(input.rawBase64, 'base64');
        if (raw.length > MAX_PGP_WIRE_BYTES) return reply(res, 413, 'TOO_LARGE');
        const contentType = mimeHeader(raw, 'content-type') ?? '';
        if (!/^multipart\/encrypted\b/i.test(contentType) || !/application\/pgp-encrypted/i.test(contentType)) throw new Error('Only PGP/MIME accepted');
        const parts = splitMimeMultipart(raw);
        if (parts.length !== 2) throw new Error('Invalid encrypted MIME');
        const text = new TextDecoder().decode(parts[1]);
        const split = /\r?\n\r?\n/.exec(text);
        if (!split) throw new Error('Missing ciphertext');
        await validatePgpCiphertext(text.slice(split.index + split[0].length).trim());
        if (mimeHeader(raw, 'from') !== from) throw new Error('Sender mismatch');
      } catch (cause) { return reply(res, cause instanceof Error && cause.message === 'TOO_LARGE' ? 413 : 400, 'INVALID_ENCRYPTED_MESSAGE'); }
      const hash = createHash('sha256').update(from).update('\0').update(to).update('\0').update(raw).digest('hex');
      const previous = db.prepare('SELECT * FROM smtp_receipt WHERE id = ?').get(id) as Receipt | undefined;
      if (previous) {
        if (previous.payload_hash !== hash) return reply(res, 409, 'IDEMPOTENCY_CONFLICT');
        if (previous.state === 'accepted') return reply(res, 202, 'ALREADY_ACCEPTED');
        if (previous.state === 'in_flight' && Date.now() - previous.updated_at < 120_000) return reply(res, 503, 'IN_FLIGHT');
        return reply(res, 409, 'SMTP_ACCEPTANCE_UNCERTAIN');
      }
      db.prepare('INSERT INTO smtp_receipt (id, payload_hash, state, updated_at) VALUES (?, ?, ?, ?)').run(id, hash, 'in_flight', Date.now());
      try {
        const info = await transport.sendMail({ envelope: { from, to: [to] }, raw });
        if (!info.accepted.map(String).map((address) => address.toLowerCase()).includes(to)) {
          db.prepare('DELETE FROM smtp_receipt WHERE id = ?').run(id);
          return reply(res, 422, 'RECIPIENT_REJECTED');
        }
        db.prepare('UPDATE smtp_receipt SET state = ?, updated_at = ? WHERE id = ?').run('accepted', Date.now(), id);
        return reply(res, 202, 'ACCEPTED_BY_SMTP');
      } catch (cause) {
        const err = cause as { responseCode?: number; command?: string };
        const beforeData = ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(err.command ?? '');
        if (err.responseCode || beforeData) {
          db.prepare('DELETE FROM smtp_receipt WHERE id = ?').run(id);
          return reply(res, err.responseCode && err.responseCode >= 500 && ![530, 535].includes(err.responseCode) ? 422 : 503, 'SMTP_REJECTED_OR_UNAVAILABLE');
        }
        // An interrupted DATA acknowledgement can mean the MTA accepted the
        // mail. Do not blindly resend; expose uncertainty for an explicit retry.
        db.prepare('UPDATE smtp_receipt SET state = ?, updated_at = ? WHERE id = ?').run('uncertain', Date.now(), id);
        return reply(res, 409, 'SMTP_ACCEPTANCE_UNCERTAIN');
      }
    })().catch(() => { if (!res.headersSent) reply(res, 503, 'BRIDGE_UNAVAILABLE'); else res.end(); });
  });
}
