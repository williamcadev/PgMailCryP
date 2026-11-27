// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderLocalInstall } from './render.mjs';

test('isolated installs require their own domain and retain stable private secrets', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pgmailcryp-config-'));
  try {
    await assert.rejects(renderLocalInstall({ output }), /domain/);
    const metadata = await renderLocalInstall({ output, domain: 'example.net' });
    const secrets = await readFile(join(output, 'secrets.json'), 'utf8');
    await renderLocalInstall({ output, domain: 'example.net' });
    assert.equal(await readFile(join(output, 'secrets.json'), 'utf8'), secrets);
    assert.equal((await stat(join(output, 'secrets.json'))).mode & 0o777, 0o600);
    await assert.rejects(renderLocalInstall({ output, domain: 'another.test' }), /another installation/);
    const compose = JSON.parse(await readFile(join(output, 'compose.json'), 'utf8'));
    assert.deepEqual(Object.keys(compose.services).sort(), ['app', 'bridge', 'network', 'stalwart']);
    assert.ok(compose.services.network.ports.every((port) => port.startsWith('127.0.0.1:')));
    for (const name of ['app', 'bridge', 'stalwart']) assert.equal(compose.services[name].network_mode, 'service:network');
    assert.equal(metadata.domain, 'example.net');
    const other = await renderLocalInstall({ output: join(output, 'second-instance'), domain: 'example.net' });
    assert.notEqual(other.project, metadata.project, 'separate state directories must not share Docker volumes');
    assert.ok((await readFile(join(output, 'bridge.env'), 'utf8')).includes('BRIDGE_RECIPIENT_DOMAINS=example.net'));
    const workerVars = await readFile(join(output, '.dev.vars'), 'utf8');
    assert.ok(workerVars.includes('PGMAILCRYP_DOMAIN="example.net"'));
    assert.ok(workerVars.includes('PGMAILCRYP_INSTALL_MODE="isolated-local-test"'));
    assert.ok(!workerVars.includes('SMTP_RELAY_PASSWORD='));
    for (const worker of ['web', 'inbound', 'jobs']) {
      const config = JSON.parse(await readFile(join(output, `${worker}.json`), 'utf8'));
      assert.ok(!JSON.stringify(config).includes('"remote":true'));
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('fresh installs select native SQLite; existing pilot state cannot switch runtimes implicitly', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pgmailcryp-runtime-'));
  try {
    const fresh = await renderLocalInstall({ output, domain: 'example.net' });
    assert.equal(fresh.runtime, 'node');
    assert.equal(JSON.parse(await readFile(join(output, 'compose.json'), 'utf8')).services.app.build.dockerfile, 'infra/server/Dockerfile');
    await assert.rejects(renderLocalInstall({ output, domain: 'example.net', runtime: 'wrangler' }), /migration/);
    const legacy = join(output, 'legacy');
    await renderLocalInstall({ output: legacy, domain: 'example.net', runtime: 'wrangler' });
    const path = join(legacy, 'installation.json');
    const metadata = JSON.parse(await readFile(path, 'utf8')); delete metadata.runtime;
    await writeFile(path, JSON.stringify(metadata));
    assert.equal((await renderLocalInstall({ output: legacy, domain: 'example.net' })).runtime, 'wrangler');
    await assert.rejects(renderLocalInstall({ output: legacy, domain: 'example.net', runtime: 'node' }), /migration/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).runtime, 'wrangler');
  } finally { await rm(output, { recursive: true, force: true }); }
});
