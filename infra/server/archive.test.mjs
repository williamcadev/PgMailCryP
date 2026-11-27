// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { sealArchive, openArchive, recoveryKey } from './archive.mjs';
async function fixture(action) { const root = await mkdtemp(join(tmpdir(), 'pgmailcryp-backup-test-')); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }

test('encrypted streaming snapshot restores binary files, empty files and private secrets exactly', async () => fixture(async (root) => {
  const source = join(root, 'source'); await mkdir(join(source, 'state', 'objects'), { recursive: true });
  const binary = randomBytes(2 * 1024 * 1024 + 3);
  await writeFile(join(source, 'state', 'objects', 'ciphertext'), binary);
  await writeFile(join(source, 'state', 'secrets.json'), 'DO_NOT_EXPOSE_THIS_SECRET');
  await writeFile(join(source, 'empty'), '');
  const key = randomBytes(32), archive = join(root, 'backup.pgm');
  assert.equal((await sealArchive(source, archive, key)).files, 3);
  assert.equal((await readFile(archive)).includes(Buffer.from('DO_NOT_EXPOSE_THIS_SECRET')), false);
  const restored = join(root, 'restored'); await openArchive(archive, restored, key);
  assert.deepEqual(await readFile(join(restored, 'state', 'objects', 'ciphertext')), binary);
  assert.equal((await readFile(join(restored, 'empty'))).length, 0);
  await assert.rejects(sealArchive(source, archive, key), /EEXIST/);
  await assert.rejects(openArchive(archive, restored, key), /EEXIST/);
  assert.deepEqual(await readFile(join(restored, 'state', 'objects', 'ciphertext')), binary);
}));

test('wrong keys and tampered/truncated archives fail before creating restored files', async () => fixture(async (root) => {
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'secret'), randomBytes(2048));
  const key = randomBytes(32), archive = join(root, 'backup.pgm'); await sealArchive(source, archive, key);
  const target = join(root, 'target');
  await assert.rejects(openArchive(archive, target, randomBytes(32)), /authentication/);
  await assert.rejects(access(target), /ENOENT/);
  const body = await readFile(archive); body[Math.floor(body.length / 2)] ^= 1; await writeFile(join(root, 'damaged'), body);
  await assert.rejects(openArchive(join(root, 'damaged'), target, key), /authentication/);
  await writeFile(join(root, 'truncated'), body.subarray(0, 10));
  await assert.rejects(openArchive(join(root, 'truncated'), target, key), /Invalid backup/);
  await assert.rejects(access(target), /ENOENT/);
}));

test('links are rejected and recovery key permissions and length are enforced', async () => fixture(async (root) => {
  const source = join(root, 'source'); await mkdir(source); await symlink('/etc/passwd', join(source, 'link'));
  await assert.rejects(sealArchive(source, join(root, 'bad'), randomBytes(32)), /symbolic link/);
  const key = join(root, 'key'); await writeFile(key, randomBytes(32), { mode: 0o600 });
  assert.equal((await recoveryKey(key)).length, 32);
  await chmod(key, 0o644); await assert.rejects(recoveryKey(key), /private/);
  await chmod(key, 0o600); await writeFile(key, 'short'); await assert.rejects(recoveryKey(key), /32/);
}));

test('authenticated archives still reject traversal, duplicate entries and incorrect file digests', async () => fixture(async (root) => {
  const key = randomBytes(32), content = Buffer.from('x');
  const entry = { path: 'safe', size: 1, sha256: createHash('sha256').update(content).digest('hex') };
  for (const [index, files] of [ [{ ...entry, path: '../escape' }], [entry, entry], [{ ...entry, sha256: '0'.repeat(64) }] ].entries()) {
    const manifest = Buffer.from(JSON.stringify({ version: 1, files }));
    const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
    const iv = randomBytes(12), header = Buffer.concat([Buffer.from('PGMAILCRYP-BACKUP-1\n'), iv]);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([length, manifest, ...files.map(() => content)])), cipher.final()]);
    const archive = join(root, `malformed-${index}`), target = join(root, `target-${index}`);
    await writeFile(archive, Buffer.concat([header, encrypted, cipher.getAuthTag()]));
    await assert.rejects(openArchive(archive, target, key), /Invalid backup entry|checksum mismatch/);
    await assert.rejects(access(target), /ENOENT/);
  }
  await assert.rejects(access(join(root, 'escape')), /ENOENT/);
}));
