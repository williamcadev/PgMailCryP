// SPDX-License-Identifier: Apache-2.0
// First-run browser test on a disposable EMPTY local installation. No MFA bypass.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const config = JSON.parse(await readFile(process.env.INSTALL_TEST_SECRETS, 'utf8'));
const base = config.url;
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a disposable local installation through an SSH tunnel');
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.PGP_TEST_BROWSER, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function fill(label, value) {
  await page.evaluate(({ label, value }) => {
    const input = [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith(label))?.querySelector('input');
    if (!input) throw new Error('Missing setup field');
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { label, value });
}
try {
  await page.goto(`${base}/setup?token=wrong`);
  assert.ok(!(await page.content()).includes('Créer mon compte et ma boîte'));
  const response = await page.goto(`${base}/setup?token=${encodeURIComponent(config.token)}`);
  assert.ok(response.headers()['cache-control'].includes('no-store'));
  assert.equal(response.headers()['referrer-policy'], 'no-referrer');
  await page.waitForFunction(() => document.body.innerText.includes('Configurer ta messagerie'));
  assert.ok((await page.$eval('main', (main) => main.innerText)).includes(config.domain));
  assert.ok((await page.$eval('main', (main) => main.innerText)).includes('Stalwart joignable, authentification réussie.'));
  await page.screenshot({ path: '/tmp/pgmailcryp-installation.png', fullPage: true });
  await fill('Nom', 'Installation test');
  await fill('Adresse de connexion externe', config.email);
  await fill('Mot de passe de connexion', config.password);
  await fill('Ta première adresse de messagerie', 'owner');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Créer mon compte et ma boîte').click());
  await page.waitForFunction(() => location.pathname === '/login', { timeout: 60_000 });
  const status = await page.evaluate(async (config) => (await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: config.email, password: config.password }) })).status, config);
  assert.equal(status, 200, 'real password login');
  await page.goto(`${base}/admin/installation`);
  assert.equal(new URL(page.url()).pathname, '/onboarding', 'MFA gate remains enforced before installation dashboard');
  const body = await page.$eval('body', (body) => body.innerText);
  assert.ok(body.includes('Secure your account') || body.includes('Protéger ton compte'));
  assert.ok(!body.includes('Connect a Cloudflare domain'), 'local domain must already be configured');
  assert.ok(!body.includes('Bring your mail with you'), 'bundled setup must not offer legacy plaintext import');
  await page.evaluate(async () => fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  await page.goto(`${base}/setup?token=${encodeURIComponent(config.token)}`);
  assert.equal(new URL(page.url()).pathname, '/login', 'genesis locked after creation');
  const cached = await page.evaluate(async () => { const urls = []; for (const name of await caches.keys()) { for (const request of await (await caches.open(name)).keys()) urls.push(request.url); } return urls; });
  assert.ok(cached.every((url) => !new URL(url).pathname.startsWith('/setup') && !new URL(url).pathname.startsWith('/admin') && !url.includes(config.token)), 'setup token and private pages must not enter CacheStorage');
  const applicationErrors = errors.filter((message) => !(message.includes('/favicon.svg') && message.toLowerCase().includes('service worker')));
  if (errors.length !== applicationErrors.length) console.warn('Known static favicon/service-worker fetch error observed; application assertions still required.');
  assert.deepEqual(applicationErrors, []);
  console.log('PASS: private setup gate, authenticated Stalwart health, real form submission and password login, local domain provisioned, MFA gate preserved genesis locked and setup excluded from CacheStorage.');
} catch (cause) {
  await writeFile('/tmp/pgmailcryp-installation-failure.txt', await page.$eval('body', (body) => body.innerText), { mode: 0o600 });
  console.error('Browser errors:', errors); throw cause;
} finally { await browser.close(); }
