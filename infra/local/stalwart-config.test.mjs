// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureStalwart } from './stalwart-config.mjs';

test('a second installation pass preserves Stalwart identities without patching immutable names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgp-stalwart-'));
  const objects = new Map();
  let nextId = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const [method, args, call] = JSON.parse(request.body).methodCalls[0];
    const [object, operation] = method.slice(2).split('/');
    if (!objects.has(object)) objects.set(object, new Map());
    const rows = objects.get(object);
    let data = {};
    if (operation === 'get') data.list = [...rows.values()];
    if (operation === 'set') {
      if (args.create) {
        data.created = {};
        for (const [tag, value] of Object.entries(args.create)) {
          const id = String(++nextId);
          if (object !== 'Action') rows.set(id, { ...value, id });
          data.created[tag] = { id, ...(object === 'Action' ? { warnings: {} } : {}) };
        }
      }
      for (const [id, patch] of Object.entries(args.update ?? {})) {
        if (id === 'singleton') continue;
        assert.ok(rows.has(id));
        assert.ok(!('name' in patch), 'Stalwart route names are immutable in a patch');
        assert.ok(!('@type' in patch), 'tagged configuration types are immutable in a patch');
        rows.set(id, { ...rows.get(id), ...patch });
      }
      for (const id of args.destroy ?? []) rows.delete(id);
    }
    return Response.json({ methodResponses: [[method, data, call]] });
  });
  try {
    const credentialFile = join(directory, 'admin.json'), smtpPasswordFile = join(directory, 'smtp'), ingressPasswordFile = join(directory, 'ingress');
    await writeFile(credentialFile, JSON.stringify({ username: 'admin', password: 'test-only' }));
    await writeFile(smtpPasswordFile, 's'.repeat(32)); await writeFile(ingressPasswordFile, 'i'.repeat(32));
    const config = { url: 'http://127.0.0.1:18809', domain: 'example.net', credentialFile, smtpPasswordFile, ingressPasswordFile };
    await configureStalwart(config);
    const ids = () => [...objects].filter(([name]) => name !== 'Action').map(([name, rows]) => [name, [...rows.keys()]]);
    const originalIds = ids();
    await configureStalwart(config);
    assert.deepEqual(ids(), originalIds);
    assert.equal(objects.get('NetworkListener').size, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
