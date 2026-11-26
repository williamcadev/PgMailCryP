// SPDX-License-Identifier: Apache-2.0
import * as openpgp from 'openpgp';
import { MAX_PGP_ATTACHMENT_BYTES, MAX_PGP_WIRE_BYTES, buildPgpWire, pgpAddress, pgpRecipients } from '@doota/mail-core/pgp-wire';

export type PgpAttachment = { name: string; contentType: string; base64: string };
export type PgpCompose = {
  from: string; to: string[]; cc: string[]; bcc: string[];
  subject: string; text: string; attachments: PgpAttachment[];
  inReplyTo?: string; references?: string;
};
export type PgpContact = { address: string; fingerprint: string; publicKeyArmored: string };

export function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function base64Bytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
const encodedHeader = (text: string) => {
  // Short UTF-8 chunks keep each encoded-word below RFC 2047's 75-char limit.
  const chunks: string[] = [];
  let current = '';
  for (const char of text) {
    if (new TextEncoder().encode(current + char).length > 39) { chunks.push(current); current = ''; }
    current += char;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${bytesBase64(new TextEncoder().encode(chunk))}?=`).join('\r\n ');
};
const wrap64 = (base64: string) => base64.match(/.{1,76}/g)?.join('\r\n') ?? '';

export function buildProtectedMime(input: PgpCompose): Uint8Array {
  const from = pgpAddress(input.from);
  const to = input.to.map(pgpAddress), cc = input.cc.map(pgpAddress);
  pgpRecipients([...to, ...cc, ...input.bcc]);
  if (input.subject.length > 1000 || input.text.length > 200_000 || input.attachments.length > 20) throw new Error('Message trop volumineux.');
  const total = input.attachments.reduce((sum, part) => sum + base64Bytes(part.base64).byteLength, 0);
  if (total > MAX_PGP_ATTACHMENT_BYTES) throw new Error('Les pièces jointes dépassent 4 Mio.');
  const boundary = `protected-${crypto.randomUUID()}`;
  const replyHeaders: string[] = [];
  for (const [name, value] of [['In-Reply-To', input.inReplyTo], ['References', input.references]]) {
    if (value) {
      if (value.length > 2000 || /[\r\n\0]/.test(value)) throw new Error('En-tête de réponse invalide.');
      replyHeaders.push(`${name}: ${value}`);
    }
  }
  const parts = [
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + wrap64(bytesBase64(new TextEncoder().encode(input.text))),
    ...input.attachments.map((part) => {
      if (!part.name || part.name.length > 200 || /[\r\n\0]/.test(part.name) || !/^[\w.+-]+\/[\w.+-]+$/.test(part.contentType)) throw new Error('Pièce jointe invalide.');
      const filename = encodeURIComponent(part.name).replace(/'/g, '%27');
      return `Content-Type: ${part.contentType}\r\nContent-Disposition: attachment; filename*=utf-8''${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap64(part.base64)}`;
    }),
  ];
  return new TextEncoder().encode([
    `From: ${from}`, `To: ${to.join(',\r\n ') || 'undisclosed-recipients:;'}`,
    ...(cc.length ? [`Cc: ${cc.join(',\r\n ')}`] : []), `Subject: ${encodedHeader(input.subject)}`,
    ...replyHeaders, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; protected-headers="v1"; boundary="${boundary}"`, '',
    `--${boundary}`, parts.join(`\r\n--${boundary}\r\n`), `--${boundary}--`, '',
  ].join('\r\n'));
}

/** Pin a public certificate only after independently comparing its full fingerprint. */
export async function verifyContact(address: string, armored: string, expectedFingerprint: string): Promise<PgpContact> {
  const normalized = armored.trim();
  if (!normalized.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----') || (normalized.match(/-----BEGIN PGP /g) ?? []).length !== 1) throw new Error('Une clé publique unique est nécessaire.');
  const keys = await openpgp.readKeys({ armoredKeys: normalized });
  if (keys.length !== 1 || keys[0].isPrivate()) throw new Error('Clé publique invalide.');
  await keys[0].getEncryptionKey();
  const fingerprint = keys[0].getFingerprint().toUpperCase();
  if (fingerprint !== expectedFingerprint.replace(/\s/g, '').toUpperCase()) throw new Error('L’empreinte ne correspond pas.');
  return { address: pgpAddress(address), fingerprint, publicKeyArmored: keys[0].armor() };
}

export async function encryptPgpMail(input: PgpCompose, senderKey: openpgp.PrivateKey, contacts: PgpContact[], messageId = `<${crypto.randomUUID()}@${pgpAddress(input.from).split('@')[1]}>`) {
  if (!senderKey.isDecrypted()) throw new Error('Déverrouille ta clé privée.');
  const recipients = pgpRecipients([...input.to, ...input.cc, ...input.bcc]);
  const encryptionKeys: openpgp.PublicKey[] = [senderKey.toPublic()];
  const fingerprints = new Set([senderKey.getFingerprint()]);
  for (const recipient of recipients) {
    if (recipient === pgpAddress(input.from)) continue;
    const contact = contacts.find((item) => item.address === recipient);
    if (!contact) throw new Error(`Vérifie d’abord la clé publique de ${recipient}.`);
    const checked = await verifyContact(recipient, contact.publicKeyArmored, contact.fingerprint);
    const key = await openpgp.readKey({ armoredKey: checked.publicKeyArmored });
    if (!fingerprints.has(key.getFingerprint())) { fingerprints.add(key.getFingerprint()); encryptionKeys.push(key); }
  }
  const ciphertext = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: buildProtectedMime(input) }),
    encryptionKeys, signingKeys: senderKey, wildcard: true, format: 'armored',
  });
  const raw = buildPgpWire({ from: input.from, to: input.to, cc: input.cc, messageId, ciphertext });
  if (raw.byteLength > MAX_PGP_WIRE_BYTES) throw new Error('Message chiffré trop volumineux.');
  return { ciphertext, messageId, raw, recipients };
}

/** Draft serialization happens before encryption; only armor leaves the browser. */
export async function encryptPgpDraft(input: PgpCompose, senderKey: openpgp.PrivateKey): Promise<string> {
  if (!senderKey.isDecrypted()) throw new Error('Déverrouille ta clé privée.');
  // Drafts can be incomplete: no recipient key is needed to save one.
  const data = JSON.stringify({ version: 1, compose: input });
  if (new TextEncoder().encode(data).byteLength > 6 * 1024 * 1024) throw new Error('Brouillon trop volumineux.');
  return openpgp.encrypt({ message: await openpgp.createMessage({ text: data }), encryptionKeys: senderKey.toPublic(), signingKeys: senderKey, wildcard: true, format: 'armored' });
}

export async function decryptPgpDraft(armored: string, senderKey: openpgp.PrivateKey): Promise<PgpCompose> {
  const result = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: armored }), decryptionKeys: senderKey, verificationKeys: senderKey.toPublic(), expectSigned: true, config: { maxDecompressedMessageSize: MAX_PGP_WIRE_BYTES } });
  await Promise.all(result.signatures.map((signature) => signature.verified));
  const parsed = JSON.parse(result.data as string);
  if (parsed.version !== 1 || typeof parsed.compose?.subject !== 'string' || typeof parsed.compose?.text !== 'string' || !Array.isArray(parsed.compose?.attachments) || !Array.isArray(parsed.compose?.to) || !Array.isArray(parsed.compose?.cc) || !Array.isArray(parsed.compose?.bcc)) throw new Error('Brouillon invalide.');
  return parsed.compose;
}
