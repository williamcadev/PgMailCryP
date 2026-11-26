// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import * as openpgp from 'openpgp';
import { buildPgpWire, validatePgpCiphertext } from '@doota/mail-core/pgp-wire';
import { base64Bytes, bytesBase64, decryptPgpDraft, encryptPgpDraft, encryptPgpMail, verifyContact, type PgpCompose, type PgpContact } from '$lib/client/pgp-compose';
import { decryptPgpMime, readPgpMime } from '$lib/client/pgp-inbox';

let alice: openpgp.PrivateKey, bob: openpgp.PrivateKey, eve: openpgp.PrivateKey;
let aliceContact: PgpContact, bobContact: PgpContact;
const input = (): PgpCompose => ({ from: 'alice@example.test', to: ['bob@example.test'], cc: [], bcc: [], subject: 'Confidentiel : été 🗝️', text: 'Bonjour Bob, contenu privé.\nDeuxième ligne.', attachments: [{ name: 'données été.bin', contentType: 'application/octet-stream', base64: bytesBase64(new Uint8Array([0, 1, 2, 128, 255])) }] });
beforeAll(async () => {
  const make = async (email: string) => (await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email }], format: 'object' })).privateKey;
  [alice, bob, eve] = await Promise.all([make('alice@example.test'), make('bob@example.test'), make('eve@example.test')]);
  aliceContact = await verifyContact('alice@example.test', alice.toPublic().armor(), alice.getFingerprint());
  bobContact = await verifyContact('bob@example.test', bob.toPublic().armor(), bob.getFingerprint());
});

describe('browser OpenPGP compose and MIME reader', () => {
  it('encrypts subject, body and binary attachments, signs them and lets both sender and receiver read their copies', async () => {
    const sent = await encryptPgpMail(input(), alice, [bobContact]);
    await validatePgpCiphertext(sent.ciphertext);
    const wire = new TextDecoder().decode(sent.raw);
    expect(wire).not.toContain(input().subject);
    expect(wire).not.toContain('contenu privé');
    expect(wire).not.toContain('données');
    for (const key of [alice, bob]) {
      const result = await readPgpMime(sent.raw, key, { contacts: [aliceContact] });
      expect(result.encryptedLayers).toBe(1);
      expect(result.signatureStatus).toBe('verified');
      expect(result.signerFingerprint).toBe(alice.getFingerprint().toUpperCase());
      expect(result.email.subject).toBe(input().subject);
      expect(result.email.text?.trim()).toBe(input().text);
      expect(result.email.attachments[0].filename).toBe('données été.bin');
      expect(new Uint8Array(result.email.attachments[0].content as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2, 128, 255]));
    }
    await expect(readPgpMime(sent.raw, eve)).rejects.toThrow();
  });
  it('hides BCC headers and key IDs while keeping the BCC recipient able to decrypt', async () => {
    const contact = await verifyContact('eve@example.test', eve.toPublic().armor(), eve.getFingerprint());
    const sent = await encryptPgpMail({ ...input(), bcc: ['eve@example.test'] }, alice, [bobContact, contact]);
    expect(new TextDecoder().decode(sent.raw)).not.toContain('eve@example.test');
    const message = await openpgp.readMessage({ armoredMessage: sent.ciphertext });
    expect(message.getEncryptionKeyIDs().every((id) => id.toHex() === '0000000000000000')).toBe(true);
    const read = await readPgpMime(sent.raw, eve, { contacts: [aliceContact] });
    expect(read.email.bcc).toBeUndefined();
    expect(read.email.to?.[0].address).toBe('bob@example.test');
  });
  it('refuses absent/unpinned recipient keys and mismatched fingerprints', async () => {
    await expect(encryptPgpMail(input(), alice, [])).rejects.toThrow('clé publique');
    await expect(verifyContact('bob@example.test', bob.toPublic().armor(), alice.getFingerprint())).rejects.toThrow('empreinte');
    await expect(verifyContact('bob@example.test', bob.armor(), bob.getFingerprint())).rejects.toThrow('publique');
  });
  it('never labels an unknown or mismatched identity signature as verified', async () => {
    const sent = await encryptPgpMail(input(), alice, [bobContact]);
    expect((await readPgpMime(sent.raw, bob)).signatureStatus).toBe('unverified');
    const wrongBinding = { ...aliceContact, address: 'eve@example.test' };
    expect((await readPgpMime(sent.raw, bob, { contacts: [wrongBinding] })).signatureStatus).toBe('unverified');
  });
  it('supports independent RFC 3156 encrypted-then-detached-signed MIME bytes', async () => {
    const part = new TextEncoder().encode('From: alice@example.test\r\nSubject: Signed inner subject\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+bytesBase64(new TextEncoder().encode('External MIME body')));
    const signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: part }), signingKeys: alice, detached: true, format: 'armored' });
    const signed = new TextEncoder().encode(`Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="external"\r\n\r\n--external\r\n${new TextDecoder().decode(part)}\r\n--external\r\nContent-Type: application/pgp-signature\r\n\r\n${signature}\r\n--external--\r\n`);
    const ciphertext = await openpgp.encrypt({ message: await openpgp.createMessage({ binary: signed }), encryptionKeys: bob.toPublic(), format: 'armored' });
    const raw = buildPgpWire({ from: 'alice@example.test', to: ['bob@example.test'], messageId: '<external@example.test>', ciphertext });
    const result = await readPgpMime(raw, bob, { contacts: [aliceContact] });
    expect(result.signatureStatus).toBe('verified');
    expect(result.email.subject).toBe('Signed inner subject');
    expect(result.email.text?.trim()).toBe('External MIME body');
    const modified = new TextDecoder().decode(signed).replace('Signed inner subject', 'Tampered subject');
    const bad = await openpgp.encrypt({ message: await openpgp.createMessage({ text: modified }), encryptionKeys: bob.toPublic(), format: 'armored' });
    const tampered = await readPgpMime(buildPgpWire({ from: 'alice@example.test', to: ['bob@example.test'], messageId: '<external@example.test>', ciphertext: bad }), bob, { contacts: [aliceContact] });
    expect(tampered.signatureStatus).toBe('invalid');
  });
  it('treats the storage wrapper separately from sender encryption and parses both layers', async () => {
    const ordinary = new TextEncoder().encode('From: alice@example.test\r\nSubject: ordinary\r\nContent-Type: text/plain\r\n\r\nnot encrypted by sender');
    const wrap = async (raw: Uint8Array) => openpgp.encrypt({ message: await openpgp.createMessage({ binary: raw }), encryptionKeys: bob.toPublic(), format: 'armored' });
    expect((await decryptPgpMime(await wrap(ordinary), bob)).encryptedLayers).toBe(0);
    const sent = await encryptPgpMail(input(), alice, [bobContact]);
    const received = await decryptPgpMime(await wrap(sent.raw), bob, { contacts: [aliceContact] });
    expect(received.encryptedLayers).toBe(1);
    expect(received.signatureStatus).toBe('verified');
  });
  it('rejects message armor containing readable literal packets', async () => {
    const plain = (await openpgp.createMessage({ text: 'secret plaintext' })).armor();
    await expect(validatePgpCiphertext(plain)).rejects.toThrow('encrypted');
    const sent = await encryptPgpMail(input(), alice, [bobContact]);
    await expect(validatePgpCiphertext(sent.ciphertext + '\n' + plain)).rejects.toThrow();
  });
  it('rejects malformed encrypted MIME rather than displaying its ciphertext as plaintext', async () => {
    const bad = new TextEncoder().encode('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="x"\r\n\r\n--x\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--x--\r\n');
    await expect(readPgpMime(bad, bob)).rejects.toThrow('invalide');
  });
});

describe('encrypted draft serialization', () => {
  it('saves incomplete draft content and attachments without needing recipient keys', async () => {
    const compose = { ...input(), to: [], subject: 'Brouillon privé' };
    const cipher = await encryptPgpDraft(compose, alice);
    await validatePgpCiphertext(cipher);
    expect(cipher).not.toContain('Brouillon');
    expect(cipher).not.toContain('données');
    expect(await decryptPgpDraft(cipher, alice)).toEqual(compose);
    await expect(decryptPgpDraft(cipher, bob)).rejects.toThrow();
    expect(base64Bytes(compose.attachments[0].base64)).toEqual(new Uint8Array([0, 1, 2, 128, 255]));
  });
});
