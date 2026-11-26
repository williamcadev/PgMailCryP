// SPDX-License-Identifier: Apache-2.0
import * as openpgp from 'openpgp';

export const MAX_PGP_WIRE_BYTES = 10 * 1024 * 1024;
export const MAX_PGP_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_PGP_CIPHERTEXT_CHARS = 9 * 1024 * 1024;

/** Bare SMTP addresses only; never let routing data add MIME header lines. */
export function pgpAddress(value: string): string {
  const address = value.trim().toLowerCase();
  if (address.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(address) || !address.includes('.')) {
    throw new Error('Invalid mail address');
  }
  return address;
}

export function pgpRecipients(addresses: string[]): string[] {
  const unique = [...new Set(addresses.map(pgpAddress))];
  if (!unique.length || unique.length > 50) throw new Error('Between 1 and 50 recipients are required');
  return unique;
}

/** An armor label is not proof of encryption: prohibit literal/unprotected packets. */
export async function validatePgpCiphertext(armored: string): Promise<void> {
  if (armored.length > MAX_PGP_CIPHERTEXT_CHARS ||
      !/^-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----\s*$/.test(armored) ||
      (armored.match(/-----BEGIN PGP /g) ?? []).length !== 1) throw new Error('Invalid encrypted payload');
  const message = await openpgp.readMessage({ armoredMessage: armored });
  const pk = message.packets.filterByTag(openpgp.enums.packet.publicKeyEncryptedSessionKey).length;
  const encrypted = message.packets.filterByTag(openpgp.enums.packet.symEncryptedIntegrityProtectedData, openpgp.enums.packet.aeadEncryptedData).length;
  if (!pk || encrypted !== 1 || message.packets.length !== pk + encrypted) {
    throw new Error('An integrity-protected public-key encrypted message is required');
  }
}

/** Fixed public envelope. Subject, filenames, body and optional reply headers are encrypted. */
export function buildPgpWire(input: { from: string; to: string[]; cc?: string[]; messageId: string; ciphertext: string }): Uint8Array {
  const from = pgpAddress(input.from);
  const to = input.to.map(pgpAddress);
  const cc = (input.cc ?? []).map(pgpAddress);
  if (!/^<[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+>$/.test(input.messageId)) throw new Error('Invalid Message-ID');
  const boundary = `pgmailcryp-${input.messageId.slice(1, input.messageId.indexOf('@')).slice(0, 80)}`;
  return new TextEncoder().encode([
    `From: ${from}`, `To: ${to.length ? to.join(',\r\n ') : 'undisclosed-recipients:;'}`,
    ...(cc.length ? [`Cc: ${cc.join(',\r\n ')}`] : []),
    'Subject: Message OpenPGP', `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0', `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: application/pgp-encrypted', '', 'Version: 1',
    `--${boundary}`, 'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Disposition: inline; filename="encrypted.asc"', '', input.ciphertext.trim().replace(/\r?\n/g, '\r\n'),
    `--${boundary}--`, '',
  ].join('\r\n'));
}

export function mimeHeader(raw: Uint8Array, name: string): string | null {
  const text = new TextDecoder().decode(raw.subarray(0, 128 * 1024));
  const split = text.search(/\r?\n\r?\n/);
  if (split < 0) throw new Error('Missing MIME headers');
  const headers = text.slice(0, split).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  const found = headers.filter((line) => line.slice(0, line.indexOf(':')).toLowerCase() === name.toLowerCase());
  if (found.length > 1) throw new Error('Duplicate MIME header');
  return found[0]?.slice(found[0].indexOf(':') + 1).trim() ?? null;
}

/** Preserve exact bytes for detached PGP/MIME signature verification. */
export function splitMimeMultipart(raw: Uint8Array): Uint8Array[] {
  const contentType = mimeHeader(raw, 'content-type') ?? '';
  const boundary = /(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 200) throw new Error('Invalid MIME boundary');
  // latin1 decoding keeps one code unit per byte; only offsets are used below.
  const text = new TextDecoder('latin1').decode(raw);
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
  const matches = [...text.matchAll(expression)];
  if (matches.length < 2 || matches.at(-1)?.[1] !== '--' || matches.length > 100) throw new Error('Incomplete MIME multipart');
  return matches.slice(0, -1).map((match, i) => raw.slice(match.index! + match[0].length, matches[i + 1].index));
}
