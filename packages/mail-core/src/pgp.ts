// SPDX-License-Identifier: Apache-2.0
import * as openpgp from "openpgp";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";

/** Accept exactly one public, currently usable encryption certificate. */
export async function readRecipientKey(armored: string) {
  armored = armored.trim();
  if (!armored.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") ||
      !armored.endsWith("-----END PGP PUBLIC KEY BLOCK-----") ||
      (armored.match(/-----BEGIN PGP /g) ?? []).length !== 1) {
    throw new Error("A public OpenPGP key is required");
  }
  const keys = await openpgp.readKeys({ armoredKeys: armored });
  if (keys.length !== 1 || keys[0].isPrivate()) throw new Error("Exactly one public key is required");
  await keys[0].getEncryptionKey(); // rejects revoked, expired and signing-only keys
  return keys[0];
}

/**
 * Separate reader contract: the browser decrypts and parses the original MIME.
 * Never feed this ciphertext to the legacy MIME/materialize/search pipeline.
 * R2 first, D1 second; acknowledge only after both writes. Retrying converges.
 */
export async function storePgpIncoming(
  db: DrizzleD1Database<typeof schema>, bucket: R2Bucket,
  mailboxId: string, raw: ArrayBuffer,
): Promise<boolean> {
  const row = await db.query.mailboxPgpKey.findFirst({
    where: eq(schema.mailboxPgpKey.mailboxId, mailboxId),
  });
  if (!row) return false;
  const box = await db.query.mailbox.findFirst({ where: eq(schema.mailbox.id, mailboxId) });
  if (!box?.isPersonal || !box.isActive || box.isService) throw new Error("Invalid OpenPGP mailbox");
  const key = await readRecipientKey(row.publicKeyArmored);
  const fingerprint = key.getFingerprint().toUpperCase();
  if (fingerprint !== row.fingerprint) throw new Error("OpenPGP fingerprint mismatch");
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const id = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const r2Key = `pgp/${mailboxId}/${id}/${fingerprint}`;
  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: new Uint8Array(raw) }),
    encryptionKeys: key, format: "armored",
  });
  await bucket.put(r2Key, encrypted, { httpMetadata: { contentType: "application/pgp-encrypted" } });
  await db.insert(schema.pgpInboxMessage).values({ id, mailboxId, fingerprint, r2Key }).onConflictDoNothing();
  return true;
}
