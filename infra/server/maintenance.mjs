// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm, mkdtemp, access } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { sealArchive, openArchive, recoveryKey } from './archive.mjs';
import { renderLocalInstall } from '../local/render.mjs';

function run(command, args, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = ''; if (capture) child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept(output.trim()) : reject(new Error(`${command} failed (${code}); installation data retained`)));
  });
}
const docker = (state, args, capture = false) => run('docker', ['compose', '-f', join(state, 'compose.json'), ...args], capture);
function outside(path, state) { if (path === state || path.startsWith(state + sep)) throw new Error('Keep the backup and recovery key outside the installation state directory'); }
async function absent(path) { try { await access(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; } throw new Error('Destination already exists; refusing to overwrite'); }

export async function backup({ state, output, keyFile }) {
  state = resolve(state); output = resolve(output); keyFile = resolve(keyFile);
  outside(output, state); outside(keyFile, state); await absent(output);
  const key = await recoveryKey(keyFile);
  const installation = JSON.parse(await readFile(join(state, 'installation.json'), 'utf8'));
  if (installation.runtime !== 'node') throw new Error('This backup command currently supports native installations only');
  const lock = join(state, '.maintenance-lock');
  await mkdir(lock, { mode: 0o700 });
  let stage; const stopped = [];
  try {
    await writeFile(join(lock, 'operation.json'), JSON.stringify({ operation: 'backup', pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
    const services = JSON.parse('[' + (await docker(state, ['ps', '--format', 'json'], true)).split('\n').filter(Boolean).join(',') + ']');
    for (const name of ['app', 'bridge', 'stalwart']) if (!services.some((item) => item.Service === name && item.State === 'running')) throw new Error('Backup requires app, bridge and Stalwart running; restore their normal state first');
    const appId = await docker(state, ['ps', '-q', 'app'], true);
    const appImage = await run('docker', ['inspect', '--format', '{{.Image}}', appId], true);
    stage = await mkdtemp(join(dirname(output), '.pgmailcryp-snapshot-'));
    // Stop SMTP acceptance first, then the bridge, then the application. Services
    // already stopped by a partial failure are always restarted in finally.
    for (const name of ['stalwart', 'bridge', 'app']) { stopped.push(name); await docker(state, ['stop', '-t', '40', name]); }
    await docker(state, ['cp', 'app:/runtime', join(stage, 'state')]);
    await rm(join(stage, 'state', '.maintenance-lock'), { recursive: true, force: true });
    await docker(state, ['cp', 'stalwart:/etc/stalwart', join(stage, 'stalwart-config')]);
    await docker(state, ['cp', 'stalwart:/var/lib/stalwart', join(stage, 'stalwart-data')]);
    const versions = JSON.parse(await readFile(new URL('../local/versions.json', import.meta.url), 'utf8'));
    await writeFile(join(stage, 'snapshot.json'), JSON.stringify({ version: 1, created: new Date().toISOString(), installation, appImage, versions }), { mode: 0o600 });
    // Release the outage before the potentially lengthy encryption step. The
    // copied snapshot is now independent of all live writers.
    await docker(state, ['start', 'app', 'bridge', 'stalwart']); stopped.length = 0;
    const verifier = fileURLToPath(new URL('./verify.mjs', import.meta.url));
    await run('docker', ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${join(stage, 'state')},target=/runtime`, '--mount', `type=bind,source=${verifier},target=/verify.mjs,readonly`, appImage, 'node', '/verify.mjs']);
    return { ...await sealArchive(stage, output, key), appImage };
  } finally {
    try { if (stopped.length) await docker(state, ['start', ...stopped.reverse()]); }
    finally { if (stage) await rm(stage, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); }
  }
}

export async function restore({ input, state, keyFile, port }) {
  input = resolve(input); state = resolve(state); keyFile = resolve(keyFile);
  await absent(state); outside(input, state); outside(keyFile, state);
  const key = await recoveryKey(keyFile);
  const stage = await mkdtemp(join(dirname(state), '.pgmailcryp-restore-'));
  let published = false;
  try {
    await openArchive(input, join(stage, 'snapshot'), key);
    const snapshot = join(stage, 'snapshot');
    const metadata = JSON.parse(await readFile(join(snapshot, 'snapshot.json'), 'utf8'));
    if (metadata.version !== 1 || metadata.installation?.runtime !== 'node' || !/^sha256:[a-f0-9]{64}$/.test(metadata.appImage)) throw new Error('Unsupported installation snapshot');
    const versions = JSON.parse(await readFile(new URL('../local/versions.json', import.meta.url), 'utf8'));
    if (JSON.stringify(metadata.versions) !== JSON.stringify(versions)) throw new Error('Restore using the source version of PgMailCryP before upgrading');
    // Preserve the exact application image for this first restore. Cross-host
    // recovery requires docker save/load until release images are published.
    await run('docker', ['image', 'inspect', metadata.appImage], true);
    await mkdir(state, { mode: 0o700 }); published = true;
    await cp(join(snapshot, 'state'), state, { recursive: true, force: false, errorOnExist: true });
    await rm(join(state, 'installation.json'));
    const installation = await renderLocalInstall({ domain: metadata.installation.domain, output: state, port: port ?? metadata.installation.port, runtime: 'node' });
    await rm(join(state, 'setup-url.txt'), { force: true });
    if (installation.project === metadata.installation.project) throw new Error('Restore must use a distinct installation directory');
    await run('docker', ['tag', metadata.appImage, `${installation.project}:local`]);
    await docker(state, ['create', 'network', 'app', 'bridge', 'stalwart']);
    // Empty new volumes only: no existing installation or volume is replaced.
    await docker(state, ['cp', `${join(snapshot, 'stalwart-config')}/.`, 'stalwart:/etc/stalwart']);
    await docker(state, ['cp', `${join(snapshot, 'stalwart-data')}/.`, 'stalwart:/var/lib/stalwart']);
    // docker cp creates root-owned files in the container. Stalwart runs as an
    // unprivileged image user, whose numeric identity comes from that same image.
    const uid = Number(await run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'id', versions.stalwart, '-u'], true));
    const gid = Number(await run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'id', versions.stalwart, '-g'], true));
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) throw new Error('Cannot determine unprivileged Stalwart volume owner');
    const container = await docker(state, ['ps', '-a', '-q', 'stalwart'], true);
    const ownership = `const fs=require('node:fs');function visit(p){const s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error('Unexpected volume link');if(s.isDirectory())for(const n of fs.readdirSync(p))visit(p+'/'+n);fs.chownSync(p,${uid},${gid});}visit('/etc/stalwart');visit('/var/lib/stalwart');`;
    await run('docker', ['run', '--rm', '--network', 'none', '--user', '0', '--volumes-from', container, metadata.appImage, 'node', '-e', ownership]);
    const verifier = fileURLToPath(new URL('./verify.mjs', import.meta.url));
    await run('docker', ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${state},target=/runtime`, '--mount', `type=bind,source=${verifier},target=/verify.mjs,readonly`, metadata.appImage, 'node', '/verify.mjs']);
    await writeFile(join(state, 'restore.json'), JSON.stringify({ version: 1, restored: new Date().toISOString(), sourceCreated: metadata.created, status: 'stopped-integrity-verified' }), { mode: 0o600 });
    return installation;
  } catch (error) {
    if (published) console.error('Restore incomplete; destination retained for inspection. Do not start it until verified.');
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function upgrade(options) {
  const state = resolve(options.state);
  if (options.image && !/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error('Prebuilt upgrade image must be an immutable local SHA-256 image ID');
  // Archive the running image and data before building or starting new code.
  const recovery = await backup(options);
  console.log(`Preserve this application image for recovery: ${recovery.appImage}`);
  const lock = join(state, '.maintenance-lock'); await mkdir(lock, { mode: 0o700 });
  try {
    await writeFile(join(lock, 'operation.json'), JSON.stringify({ operation: 'upgrade', pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
    if (options.image) {
      await run('docker', ['image', 'inspect', options.image], true);
      const installation = JSON.parse(await readFile(join(state, 'installation.json'), 'utf8'));
      await run('docker', ['tag', options.image, `${installation.project}:local`]);
    } else await docker(state, ['build', 'app']);
    await docker(state, ['up', '-d', '--no-deps', '--no-build', 'app', 'bridge']);
    const installation = JSON.parse(await readFile(join(state, 'installation.json'), 'utf8'));
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const response = await fetch(`${installation.origin}/healthz`, { signal: AbortSignal.timeout(2000) }); ready = response.ok && (await response.json()).runtime === 'node-sqlite'; } catch { /* starting */ }
      if (ready) break;
      await new Promise((accept) => setTimeout(accept, 1000));
    }
    if (!ready) throw new Error('Updated server is not ready; encrypted backup retained. Inspect locally before restoring; no automatic schema downgrade was attempted');
    await writeFile(join(state, 'upgrade.json'), JSON.stringify({ version: 1, upgraded: new Date().toISOString(), backup: resolve(options.output), status: 'application-ready-transport-check-required' }), { mode: 0o600 });
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function main() {
  process.umask(0o077);
  const [command, ...args] = process.argv.slice(2);
  const flag = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (command === 'keygen' && flag('--output')) {
    await writeFile(resolve(flag('--output')), randomBytes(32), { flag: 'wx', mode: 0o600 });
    console.log('Recovery key created. Keep a separate offline copy; losing it makes the backup unrecoverable.'); return;
  }
  if (command === 'backup' && flag('--state') && flag('--output') && flag('--key-file')) {
    const result = await backup({ state: flag('--state'), output: flag('--output'), keyFile: flag('--key-file') });
    console.log(`Encrypted backup complete (${result.files} files); services restarted.`);
    console.log(`Preserve this application image for recovery: ${result.appImage}`); return;
  }
  if (command === 'upgrade' && flag('--state') && flag('--output') && flag('--key-file')) {
    await upgrade({ state: flag('--state'), output: flag('--output'), keyFile: flag('--key-file'), image: flag('--image') });
    console.log('Upgrade started successfully with a verified encrypted backup retained. Check SMTP delivery before reopening access.'); return;
  }
  if (command === 'restore' && flag('--state') && flag('--input') && flag('--key-file')) {
    const result = await restore({ state: flag('--state'), input: flag('--input'), keyFile: flag('--key-file'), port: flag('--port') ? Number(flag('--port')) : undefined });
    console.log(`Restore integrity verified at ${result.origin}; services remain stopped. Start with docker compose -f STATE/compose.json up -d.`); return;
  }
  throw new Error('Usage: maintenance.mjs keygen --output KEY | backup/upgrade --state STATE --output BACKUP --key-file KEY | restore --state NEW_STATE --input BACKUP --key-file KEY [--port PORT]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
