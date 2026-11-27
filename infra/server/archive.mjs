// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readdir, lstat, mkdir, mkdtemp, readFile, appendFile, link, unlink, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('PGMAILCRYP-BACKUP-1\n');
const maxManifest = 16 * 1024 * 1024;
const safePath = (path) => typeof path === 'string' && path.length < 4096 && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part && part !== '.' && part !== '..');
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export async function recoveryKey(path) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('Recovery key must be a private regular file (chmod 600)');
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('Recovery key must contain exactly 32 random bytes');
  return key;
}
async function inventory(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!safePath(path)) throw new Error('Invalid archive path');
    const info = await lstat(join(root, path));
    if (info.isDirectory()) result.push(...await inventory(root, path));
    else if (info.isFile()) result.push({ path, size: info.size, sha256: await digest(join(root, path)) });
    else throw new Error('Snapshot contains a symbolic link or special file');
  }
  return result;
}
async function syncFile(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }

/** Streaming archive; no plaintext tar file, absolute paths or link entries. */
export async function sealArchive(root, output, key) {
  const files = await inventory(root);
  const manifest = Buffer.from(JSON.stringify({ version: 1, files }));
  if (manifest.length > maxManifest) throw new Error('Too many snapshot files');
  const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
  const iv = randomBytes(12), header = Buffer.concat([magic, iv]);
  const temporary = join(dirname(resolve(output)), `.pgmailcryp-archive-${randomBytes(12).toString('hex')}`);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
  async function* payload() {
    yield length; yield manifest;
    for (const file of files) yield* createReadStream(join(root, file.path));
  }
  try {
    const file = await open(temporary, 'wx', 0o600); await file.writeFile(header); await file.close();
    await pipeline(Readable.from(payload()), cipher, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    await appendFile(temporary, cipher.getAuthTag()); await syncFile(temporary);
    // An existing backup is never overwritten, even by a competing process.
    await link(temporary, output); await syncFile(dirname(resolve(output)));
  } finally { await unlink(temporary).catch(() => {}); }
  return { files: files.length };
}

/** Authenticate the entire archive before creating any restored file. */
export async function openArchive(input, output, key) {
  const parent = dirname(resolve(output));
  const scratch = await mkdtemp(join(parent, '.pgmailcryp-decrypt-'));
  let created = false;
  try {
    const info = await lstat(input), header = Buffer.alloc(magic.length + 12), tag = Buffer.alloc(16);
    if (!info.isFile() || info.size < header.length + 20) throw new Error('Invalid backup');
    const source = await open(input, 'r');
    try { await source.read(header, 0, header.length, 0); await source.read(tag, 0, 16, info.size - 16); } finally { await source.close(); }
    if (!header.subarray(0, magic.length).equals(magic)) throw new Error('Unsupported backup format');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length)); decipher.setAAD(header); decipher.setAuthTag(tag);
    const plain = join(scratch, 'payload');
    try { await pipeline(createReadStream(input, { start: header.length, end: info.size - 17 }), decipher, createWriteStream(plain, { flags: 'wx', mode: 0o600 })); }
    catch { throw new Error('Backup authentication failed: incorrect key or damaged backup'); }
    const file = await open(plain, 'r');
    try {
      const length = Buffer.alloc(4); await file.read(length, 0, 4, 0);
      const size = length.readUInt32BE();
      if (size > maxManifest || size < 2) throw new Error('Invalid backup manifest');
      const body = Buffer.alloc(size); if ((await file.read(body, 0, size, 4)).bytesRead !== size) throw new Error('Truncated backup manifest');
      const manifest = JSON.parse(body.toString('utf8'));
      if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported backup manifest');
      const seen = new Set(); let total = 4 + size;
      for (const entry of manifest.files) {
        if (!safePath(entry.path) || seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid backup entry');
        seen.add(entry.path); total += entry.size;
        if (!Number.isSafeInteger(total)) throw new Error('Backup too large');
      }
      if (total !== (await file.stat()).size) throw new Error('Backup length mismatch');
      await mkdir(output, { mode: 0o700 }); created = true;
      let offset = 4 + size;
      for (const entry of manifest.files) {
        const path = join(output, entry.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const target = await open(path, 'wx', 0o600), hash = createHash('sha256');
        try {
          let left = entry.size;
          while (left) {
            const chunk = Buffer.alloc(Math.min(left, 1024 * 1024));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
            if (bytesRead !== chunk.length) throw new Error('Truncated backup');
            await target.writeFile(chunk); hash.update(chunk); left -= bytesRead; offset += bytesRead;
          }
          await target.sync();
        } finally { await target.close(); }
        if (hash.digest('hex') !== entry.sha256) throw new Error('Backup file checksum mismatch');
      }
      return { files: manifest.files.length };
    } finally { await file.close(); }
  } catch (error) { if (created) await rm(output, { recursive: true, force: true }); throw error; }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
