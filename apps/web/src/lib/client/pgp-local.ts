// SPDX-License-Identifier: Apache-2.0
import * as openpgp from 'openpgp';
import type { PgpContact } from './pgp-compose';
import { validatePgpCiphertext } from '@doota/mail-core/pgp-wire';

export type DevicePgpKey = { privateKeyArmored: string; publicKeyArmored: string; fingerprint: string };
const keyName = (userId: string, mailboxId: string) => `pgmailcryp:key:${encodeURIComponent(userId)}:${encodeURIComponent(mailboxId)}`;
export function loadDeviceKey(storage: Storage, userId: string, mailboxId: string): DevicePgpKey | null {
  const raw = storage.getItem(keyName(userId, mailboxId));
  return raw ? JSON.parse(raw) as DevicePgpKey : null;
}
export async function saveDeviceKey(storage: Storage, userId: string, mailboxId: string, privateKeyArmored: string): Promise<DevicePgpKey> {
  const key = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  if (key.getKeys().some((part) => 'isDecrypted' in part.keyPacket && part.keyPacket.isDecrypted())) throw new Error('La clé privée doit être protégée avant sauvegarde.');
  const record = { privateKeyArmored: key.armor(), publicKeyArmored: key.toPublic().armor(), fingerprint: key.getFingerprint().toUpperCase() };
  storage.setItem(keyName(userId, mailboxId), JSON.stringify(record));
  return record;
}
export function loadPgpContacts(storage: Storage, userId: string): PgpContact[] {
  const saved = storage.getItem(`pgmailcryp:contacts:${encodeURIComponent(userId)}`);
  return saved ? JSON.parse(saved) as PgpContact[] : [];
}
export function savePgpContacts(storage: Storage, userId: string, contacts: PgpContact[]) {
  storage.setItem(`pgmailcryp:contacts:${encodeURIComponent(userId)}`, JSON.stringify(contacts));
}
export type LocalPgpDraft = { scope: string; id: string; revision: number; ciphertext: string; updatedAt: number; kind: 'draft' | 'pending'; routing?: { to: string[]; cc: string[]; bcc: string[] } };
const scopeName = (userId: string, mailboxId: string) => `${encodeURIComponent(userId)}:${encodeURIComponent(mailboxId)}`;
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pgmailcryp-encrypted-v1', 2);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('objects') ? request.transaction!.objectStore('objects') : request.result.createObjectStore('objects', { keyPath: ['scope', 'kind', 'id'] });
      if (!store.indexNames.contains('scope')) store.createIndex('scope', 'scope');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Le stockage local est bloqué par un autre onglet.'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('objects', mode);
    const request = action(tx.objectStore('objects'));
    let value: T;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Écriture locale annulée.')); };
  });
}
export async function saveLocalPgpDraft(userId: string, mailboxId: string, input: Omit<LocalPgpDraft, 'scope'>) {
  await validatePgpCiphertext(input.ciphertext);
  return transaction('readwrite', (store) => store.put({ ...input, scope: scopeName(userId, mailboxId) }));
}
export async function localPgpDrafts(userId: string, mailboxId: string): Promise<LocalPgpDraft[]> {
  const all = await transaction<LocalPgpDraft[]>('readonly', (store) => store.index('scope').getAll(scopeName(userId, mailboxId)));
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function removeLocalPgpDraft(userId: string, mailboxId: string, id: string, kind: LocalPgpDraft['kind'] = 'draft') {
  return transaction('readwrite', (store) => store.delete([scopeName(userId, mailboxId), kind, id]));
}
