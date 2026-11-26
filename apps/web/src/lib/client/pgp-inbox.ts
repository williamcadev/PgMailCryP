// SPDX-License-Identifier: Apache-2.0
import * as openpgp from 'openpgp';
import PostalMime from 'postal-mime';
import { MAX_PGP_WIRE_BYTES, mimeHeader, splitMimeMultipart } from '@doota/mail-core/pgp-wire';
import { base64Bytes, type PgpContact } from './pgp-compose';

type SignatureEvidence = { keyID: string; valid: boolean; known: boolean; fingerprint: string | null };
export type PgpReadOptions = { contacts?: PgpContact[] };

async function verificationKeys(options: PgpReadOptions) {
  return Promise.all((options.contacts ?? []).map(async (contact) => {
    const key = await openpgp.readKey({ armoredKey: contact.publicKeyArmored });
    if (key.isPrivate() || key.getFingerprint().toUpperCase() !== contact.fingerprint.toUpperCase()) throw new Error('Clé de contact incohérente.');
    return { contact, key };
  }));
}

async function signatureEvidence(signatures: openpgp.VerifyMessageResult<Uint8Array>['signatures'], keys: Awaited<ReturnType<typeof verificationKeys>>): Promise<SignatureEvidence[]> {
  return Promise.all(signatures.map(async (signature) => {
    const known = keys.find(({ key }) => key.getKeys().some((part) => part.getKeyID().equals(signature.keyID)));
    try {
      await signature.verified;
      return { keyID: signature.keyID.toHex(), valid: true, known: !!known, fingerprint: known?.key.getFingerprint().toUpperCase() ?? null };
    } catch {
      return { keyID: signature.keyID.toHex(), valid: false, known: !!known, fingerprint: known?.key.getFingerprint().toUpperCase() ?? null };
    }
  }));
}

function mimePartBody(part: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(part);
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator) throw new Error('Partie MIME invalide.');
  const body = part.subarray(separator.index + separator[0].length);
  const encoding = mimeHeader(part, 'content-transfer-encoding')?.toLowerCase();
  if (encoding === 'base64') return base64Bytes(new TextDecoder().decode(body).replace(/\s/g, ''));
  if (encoding && !['7bit', '8bit', 'binary'].includes(encoding)) throw new Error('Encodage de partie OpenPGP non pris en charge.');
  return body;
}

/** Recursively unwrap PGP/MIME; never treat a random .asc attachment as the body. */
export async function readPgpMime(raw: Uint8Array, key: openpgp.PrivateKey, options: PgpReadOptions = {}) {
  if (!key.isDecrypted()) throw new Error('Déverrouille la clé privée sur cet appareil.');
  const originalRaw = raw;
  const keys = await verificationKeys(options);
  const signatures: SignatureEvidence[] = [];
  let encryptedLayers = 0;
  for (let depth = 0; depth < 5; depth++) {
    if (raw.byteLength > MAX_PGP_WIRE_BYTES) throw new Error('MIME déchiffré trop volumineux.');
    const contentType = (mimeHeader(raw, 'content-type') ?? '').toLowerCase();
    if (/^multipart\/encrypted\b/.test(contentType)) {
      if (!/protocol\s*=\s*"?application\/pgp-encrypted(?:"|;|\s|$)/.test(contentType)) throw new Error('Protocole de chiffrement MIME non pris en charge.');
      const parts = splitMimeMultipart(raw);
      if (parts.length !== 2 || mimeHeader(parts[0], 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pgp-encrypted' || !/Version:\s*1/i.test(new TextDecoder().decode(mimePartBody(parts[0])))) throw new Error('Enveloppe PGP/MIME invalide.');
      const encrypted = mimePartBody(parts[1]);
      const armored = new TextDecoder().decode(encrypted).trim();
      const message = armored.startsWith('-----BEGIN PGP MESSAGE-----')
        ? await openpgp.readMessage({ armoredMessage: armored })
        : await openpgp.readMessage({ binaryMessage: encrypted });
      const result = await openpgp.decrypt({ message, decryptionKeys: key, verificationKeys: keys.map(({ key }) => key), format: 'binary', config: { maxDecompressedMessageSize: MAX_PGP_WIRE_BYTES } });
      signatures.push(...await signatureEvidence(result.signatures, keys));
      raw = new Uint8Array(result.data);
      encryptedLayers++;
      continue;
    }
    if (/^multipart\/signed\b/.test(contentType)) {
      if (!/protocol\s*=\s*"?application\/pgp-signature(?:"|;|\s|$)/.test(contentType)) throw new Error('Protocole de signature MIME non pris en charge.');
      const parts = splitMimeMultipart(raw);
      if (parts.length !== 2 || mimeHeader(parts[1], 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pgp-signature') throw new Error('Signature MIME invalide.');
      const signature = await openpgp.readSignature({ armoredSignature: new TextDecoder().decode(mimePartBody(parts[1])) });
      const result = await openpgp.verify({ message: await openpgp.createMessage({ binary: parts[0] }), signature, verificationKeys: keys.map(({ key }) => key), format: 'binary', config: { maxDecompressedMessageSize: MAX_PGP_WIRE_BYTES } });
      signatures.push(...await signatureEvidence(result.signatures, keys));
      raw = parts[0];
      continue;
    }
    const email = await PostalMime.parse(raw, { maxNestingDepth: 30, maxHeadersSize: 128 * 1024 });
    const from = email.from?.address?.toLowerCase();
    const matching = signatures.filter((evidence) => evidence.valid && (options.contacts ?? []).some((contact) => contact.address === from && contact.fingerprint.toUpperCase() === evidence.fingerprint));
    const signatureStatus = signatures.some((item) => item.known && !item.valid) ? 'invalid'
      : matching.length ? 'verified' : signatures.length ? 'unverified' : 'unsigned';
    return { raw: originalRaw, decryptedRaw: raw, email, encryptedLayers, signatureStatus, signerFingerprint: matching[0]?.fingerprint ?? null };
  }
  throw new Error('Trop de couches MIME imbriquées.');
}

/** The first layer is the at-rest envelope; it is not evidence of sender encryption. */
export async function decryptPgpMime(armoredMessage: string, key: openpgp.PrivateKey, options: PgpReadOptions = {}) {
  if (!key.isDecrypted()) throw new Error('Déverrouille la clé privée sur cet appareil.');
  const result = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: armoredMessage }), decryptionKeys: key, format: 'binary', config: { maxDecompressedMessageSize: MAX_PGP_WIRE_BYTES } });
  return readPgpMime(new Uint8Array(result.data), key, options);
}
