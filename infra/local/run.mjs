// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const state = '/runtime';
const secrets = JSON.parse(await readFile(`${state}/secrets.json`, 'utf8'));
function run(args) { return new Promise((resolve, reject) => { const child = spawn('pnpm', args, { cwd: '/app', stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Local runtime command failed (${code})`))); }); }
await run(['--filter', 'doota', 'exec', 'wrangler', 'd1', 'migrations', 'apply', 'pgmailcryp-local', '--local', '--config', `${state}/web.json`, '--persist-to', `${state}/data`]);
const worker = spawn('pnpm', ['--filter', 'doota', 'exec', 'wrangler', 'dev', '--local', '--ip', '0.0.0.0', '--port', '8787', '--persist-to', `${state}/data`, '-c', `${state}/web.json`, '-c', `${state}/inbound.json`, '-c', `${state}/jobs.json`], { cwd: '/app', stdio: 'inherit' });
const timer = setInterval(() => {
  void fetch('http://127.0.0.1:8787/api/cron', { method: 'POST', headers: { authorization: `Bearer ${secrets.CRON_SECRET}` }, signal: AbortSignal.timeout(15_000) }).catch(() => {});
}, 30_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); worker.kill(signal); });
worker.once('exit', (code) => { clearInterval(timer); process.exitCode = code ?? 1; });
