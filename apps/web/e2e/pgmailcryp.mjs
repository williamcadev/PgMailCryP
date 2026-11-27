// SPDX-License-Identifier: Apache-2.0
// Explicit browser integration test against a disposable local install.
// PGP_TEST_ACCOUNTS is a private JSON file produced by seed-test.mjs.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
const base = process.env.PGP_TEST_URL ?? 'http://localhost:18787';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use an SSH tunnel to a disposable local test installation');
if (!process.env.PGP_TEST_ACCOUNTS || !process.env.PGP_TEST_BROWSER) throw new Error('Set PGP_TEST_ACCOUNTS (private JSON) and PGP_TEST_BROWSER (executable)');
const accounts = JSON.parse(await readFile(process.env.PGP_TEST_ACCOUNTS, 'utf8'));
const deviceFile = process.env.PGP_TEST_ACCOUNTS + '.browser.json';
let devices = {};
try { devices = JSON.parse(await readFile(deviceFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const directory = await mkdtemp(join(tmpdir(), 'pgmailcryp-browser-'));
const marker = `PGP_BROWSER_${Date.now()}`;
const bytes = new Uint8Array([0, 1, 255, 128, 13, 10, 0, 42]);
const attachment = join(directory, `${marker}.bin`);
await writeFile(attachment, bytes);
const browser = await puppeteer.launch({ browser: process.env.PGP_TEST_ENGINE ?? 'firefox', executablePath: process.env.PGP_TEST_BROWSER, headless: true });
const pages = [], leaks = [], errors = [];
async function button(page, name) {
  await page.bringToFront();
  await page.waitForFunction((text) => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === text && !button.disabled), { timeout: 60_000 }, name);
  await page.evaluate((text) => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text && !button.disabled).click(), name);
}
async function fill(page, label, value) {
  await page.bringToFront();
  await page.waitForFunction((text) => [...document.querySelectorAll('label')].some((label) => label.textContent.trim().startsWith(text) && label.querySelector('input,textarea')), {}, label);
  await page.evaluate(({ label, value }) => {
    const input = [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith(label)).querySelector('input,textarea');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { label, value });
}
async function visible(page, text) { await page.waitForFunction((text) => document.body.innerText.includes(text), { timeout: 90_000 }, text); }
async function noError(page) { const error = await page.$eval('main', (main) => main.querySelector('[role="alert"]')?.textContent ?? ''); assert.equal(error, ''); }
try {
  for (const account of accounts) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluateOnNewDocument((marker) => {
      window.pgpTestLeaks = [];
      const original = window.fetch;
      window.fetch = async function (input, init) {
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        const body = await request.clone().text();
        if (body.includes(marker) || body.includes('PGP browser phrase secrète')) window.pgpTestLeaks.push(new URL(request.url).pathname);
        return original.call(this, input, init);
      };
    }, marker);
    await page.goto(`${base}/login`);
    const status = await page.evaluate(async ({ email, password, base }) => {
      const response = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, callbackURL: `${base}/pgmailcryp` }) });
      return response.status;
    }, { email: account.email, password: account.password, base });
    assert.equal(status, 200, 'real password login');
    if (devices[account.email]) await page.evaluate((values) => { for (const [name, value] of Object.entries(values)) localStorage.setItem(name, value); }, devices[account.email]);
    await page.goto(`${base}/pgmailcryp?mailbox=${account.mailboxId}`);
    await visible(page, 'Clé de cet appareil');
    if (!devices[account.email]) {
      await fill(page, 'Phrase de passe', 'PGP browser phrase secrète 123!');
      await button(page, 'Générer ma clé');
      await visible(page, 'Clé privée protégée enregistrée');
      devices[account.email] = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([name]) => name.startsWith('pgmailcryp:'))));
      await writeFile(deviceFile, JSON.stringify(devices), { mode: 0o600 });
    }
    if (await page.evaluate(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Activer cette boîte avec la clé publique'))) {
      await button(page, 'Activer cette boîte avec la clé publique');
      await visible(page, 'Clé publique publiée');
    }
    await fill(page, 'Phrase de passe', 'PGP browser phrase secrète 123!');
    await button(page, 'Déverrouiller');
    await visible(page, 'Écrire un message');
    await noError(page);
    account.fingerprint = await page.evaluate(() => {
      const name = Object.keys(localStorage).find((name) => name.startsWith('pgmailcryp:key:'));
      return JSON.parse(localStorage.getItem(name)).fingerprint;
    });
  }
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i], contact = accounts[1 - i];
    await page.evaluate(() => document.querySelector('details').open = true);
    await fill(page, 'Adresse du contact', contact.email);
    await button(page, 'Chercher dans l’annuaire local');
    await visible(page, 'Clé trouvée');
    await fill(page, 'Empreinte complète comparée', contact.fingerprint);
    await button(page, 'Enregistrer la clé comparée');
    await visible(page, 'Clé du contact enregistrée');
  }
  const [alice, bob] = pages;
  const readCount = (page) => page.evaluate(() => [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Lire sur cet appareil').length);
  if (process.env.PGP_TEST_EXISTING_MESSAGES === '1') {
    for (const page of pages) {
      await button(page, 'Actualiser la réception');
      assert.ok(await readCount(page), 'restored inbox contains previously delivered mail');
      await button(page, 'Lire sur cet appareil');
      await visible(page, 'Signature vérifiée avec la clé comparée');
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('main section h2')].some((heading) => /PGP_BROWSER_\d+/.test(heading.textContent))), 'previously stored subject decrypts on the original device');
      await noError(page);
    }
  }
  async function receive(page, expectedSubject) {
    await page.bringToFront();
    for (let attempt = 0; attempt < 60; attempt++) {
      await button(page, 'Actualiser la réception');
      for (let index = 0; index < Math.min(5, await readCount(page)); index++) {
        await page.evaluate((index) => [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Lire sur cet appareil')[index]?.click(), index);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'Lire sur cet appareil').every((button) => !button.disabled), { timeout: 30_000 });
        if (await page.evaluate((subject) => [...document.querySelectorAll('main section h2')].some((heading) => heading.textContent === subject), expectedSubject)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('Expected decrypted SMTP reception not found within the deadline');
  }
  await fill(alice, 'À (', accounts[1].email);
  await fill(alice, 'Objet (chiffré)', `${marker} sujet`);
  await fill(alice, 'Message', `${marker} contenu confidentiel é`);
  const file = await alice.$('input[type="file"][multiple]');
  await file.uploadFile(attachment);
  await visible(alice, `${marker}.bin`);
  await visible(alice, 'Brouillon chiffré sauvegardé');
  await noError(alice);
  assert.ok(!(await alice.evaluate(() => JSON.stringify(localStorage))).includes(marker), 'no plaintext content in localStorage');
  await button(alice, 'Chiffrer, signer et envoyer');
  await visible(alice, 'Envoi chiffré mis en file');
  await receive(bob, `${marker} sujet`);
  await visible(bob, `${marker} sujet`);
  await visible(bob, `${marker} contenu confidentiel é`);
  await visible(bob, 'Signature vérifiée avec la clé comparée');
  await bob.evaluate(() => {
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.pgpTestDownload = fetch(this.href).then(async (response) => Array.from(new Uint8Array(await response.arrayBuffer())));
      // Keep test downloads in memory, avoiding an OS download prompt.
      if (!this.download) original.call(this);
    };
  });
  await button(bob, `Télécharger ${marker}.bin`);
  assert.deepEqual(await bob.evaluate(() => window.pgpTestDownload), Array.from(bytes), 'exact attachment bytes recovered in browser');
  await button(alice, 'Lire ma copie chiffrée');
  await visible(alice, `${marker} contenu confidentiel é`);
  await visible(alice, 'Signature vérifiée avec la clé comparée');
  await button(bob, 'Répondre chiffré');
  await button(bob, 'Chiffrer, signer et envoyer');
  await visible(bob, 'Envoi chiffré mis en file');
  await receive(alice, `Re: ${marker} sujet`);
  await visible(alice, `Re: ${marker} sujet`);
  await visible(alice, 'Signature vérifiée avec la clé comparée');
  await button(bob, 'Transférer chiffré');
  await fill(bob, 'À (', accounts[0].email);
  await button(bob, 'Chiffrer, signer et envoyer');
  await visible(bob, 'Envoi chiffré mis en file');
  await receive(alice, `Fwd: ${marker} sujet`);
  await visible(alice, `Fwd: ${marker} sujet`);
  await visible(alice, `Télécharger ${marker}.bin`);
  await noError(alice); await noError(bob);
  for (const page of pages) leaks.push(...await page.evaluate(() => window.pgpTestLeaks));
  assert.deepEqual(leaks, [], 'no subject/body/filename/passphrase in outgoing HTTP payloads');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS: two real browser logins, on-device keys, publication, pinned contacts, encrypted draft/send, SMTP reception, verified signatures, exact binary attachment and delivered encrypted reply/forward.');
} catch (cause) {
  for (let i = 0; i < pages.length; i++) {
    await writeFile(join(tmpdir(), `pgmailcryp-browser-failure-${i}.txt`), await pages[i].evaluate(() => document.body.innerText), { mode: 0o600 });
  }
  console.error('Uncaught browser errors:', errors);
  throw cause;
} finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
