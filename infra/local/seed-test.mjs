// SPDX-License-Identifier: Apache-2.0
// Explicit disposable test fixtures. No HTTP endpoint or authentication bypass.
import { readFile, writeFile, unlink, stat, chown } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire('/app/apps/web/package.json');
const { hashPassword } = await import(require.resolve('better-auth/crypto'));
const state = '/runtime';
const installation = JSON.parse(await readFile(`${state}/installation.json`, 'utf8'));
if (installation.mode !== 'isolated-local-test') throw new Error('Test accounts require an isolated local installation');
const credentialFile = `${state}/test-accounts.json`;
try { await readFile(credentialFile); console.log('Test credentials already exist; no account changed.'); process.exit(0); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const command = ['--filter', 'doota', 'exec', 'wrangler', 'd1', 'execute', 'pgmailcryp-local', '--local', '--config', `${state}/web.json`, '--persist-to', `${state}/data`];
const result = JSON.parse(execFileSync('pnpm', [...command, '--command', 'SELECT COUNT(*) AS count FROM user', '--json'], { cwd: '/app', encoding: 'utf8' }));
if (result[0]?.results[0]?.count !== 0) throw new Error('Refusing to seed a nonempty installation. Existing accounts retained.');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now(), org = 'pgmailcryp-local-test';
const accounts = await Promise.all(['alice', 'bob'].map(async (name) => {
  const password = randomBytes(24).toString('base64url');
  return { name, email: `${name}@${installation.domain}`, password, hash: await hashPassword(password), mailboxId: `pgmailcryp-test-${name}` };
}));
const statements = [`INSERT INTO organization (id,name,slug,domain,status,created_at) VALUES (${quote(org)},'PgMailCryP local test',${quote(org)},${quote(installation.domain)},'active',${now})`];
for (const account of accounts) {
  const id = account.mailboxId;
  statements.push(
    `INSERT INTO user (id,name,email,email_verified,role,onboarded_at,created_at,updated_at) VALUES (${quote(id)},${quote(account.name)},${quote(account.email)},1,'member',${now},${now},${now})`,
    `INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (${quote(id)},${quote(id)},'credential',${quote(id)},${quote(account.hash)},${now},${now})`,
    `INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (${quote(id)},${quote(org)},${quote(id)},'member',${now})`,
    `INSERT INTO mailbox (id,org_id,local_part,address,is_personal,search_indexed) VALUES (${quote(id)},${quote(org)},${quote(account.name)},${quote(account.email)},1,0)`,
    `INSERT INTO mailbox_access (id,user_id,mailbox_id,can_send,can_manage) VALUES (${quote(id)},${quote(id)},${quote(id)},1,1)`,
  );
}
const seedFile = `${state}/test-seed.sql`;
await writeFile(seedFile, statements.join(';\n') + ';\n', { mode: 0o600 });
try {
  execFileSync('pnpm', [...command, '--file', seedFile, '--json'], { cwd: '/app', stdio: ['ignore', 'ignore', 'pipe'] });
  await writeFile(credentialFile, JSON.stringify(accounts.map(({ hash, ...account }) => account), null, 2), { mode: 0o600 });
  const owner = await stat(state);
  await chown(credentialFile, owner.uid, owner.gid);
} finally { await unlink(seedFile); }
console.log('Alice and Bob test accounts created. Read test-accounts.json locally; create their OpenPGP keys in separate browser profiles.');
