// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { backup, restore } from './maintenance.mjs';
import { renderLocalInstall } from '../local/render.mjs';
import { sealArchive } from './archive.mjs';

test('maintenance refuses existing destinations, nested backup paths and concurrent operations before Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pgmailcryp-maintenance-'));
  try {
    const state = join(root, 'state'), keyFile = join(root, 'key');
    await renderLocalInstall({ output: state, domain: 'example.test' });
    const original = await readFile(join(state, 'secrets.json'));
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    await assert.rejects(backup({ state, output: join(state, 'backup'), keyFile }), /outside/);
    await assert.rejects(restore({ state, input: join(root, 'backup'), keyFile }), /already exists/);
    await mkdir(join(state, '.maintenance-lock'));
    await assert.rejects(renderLocalInstall({ output: state, domain: 'example.test' }), /maintenance/);
    await assert.rejects(backup({ state, output: join(root, 'backup'), keyFile }), /EEXIST/);
    await access(join(state, '.maintenance-lock'));
    assert.deepEqual(await readFile(join(state, 'secrets.json')), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restore authenticates before publishing an installation directory or invoking Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pgmailcryp-restore-guard-'));
  try {
    const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'snapshot.json'), '{}');
    const input = join(root, 'backup'), keyFile = join(root, 'key'), state = join(root, 'new-state');
    await sealArchive(source, input, randomBytes(32));
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    await assert.rejects(restore({ state, input, keyFile }), /authentication/);
    await assert.rejects(access(state), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
