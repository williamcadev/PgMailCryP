<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import * as openpgp from 'openpgp';
  import { Button } from '$lib/components/ui/button/index.js';
  import { myMailboxes } from '$lib/rpc/mailbox.remote';
  import { publishMailboxPgpKey, mailboxPgpPublicKey, pgpInbox, lookupPgpRecipient, pgpDrafts, savePgpDraft, deletePgpDraft, sendPgpMessage, pgpSent, retryPgpSend } from '$lib/rpc/pgp.remote';
  import { bytesBase64, base64Bytes, decryptPgpDraft, encryptPgpDraft, encryptPgpMail, verifyContact, type PgpAttachment, type PgpCompose, type PgpContact } from '$lib/client/pgp-compose';
  import { decryptPgpMime, readPgpMime } from '$lib/client/pgp-inbox';
  import { loadDeviceKey, saveDeviceKey, loadPgpContacts, savePgpContacts, localPgpDrafts, saveLocalPgpDraft, removeLocalPgpDraft, type DevicePgpKey, type LocalPgpDraft } from '$lib/client/pgp-local';
  import { MAX_PGP_ATTACHMENT_BYTES } from '@doota/mail-core/pgp-wire';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const boxesQuery = myMailboxes();
  const boxes = $derived((boxesQuery.current ?? []).filter((box) => box.isPersonal));
  let mailboxId = $state('');
  const box = $derived(boxes.find((item) => item.id === mailboxId));
  const published = $derived(mailboxId ? mailboxPgpPublicKey(mailboxId) : null);
  const inbox = $derived(mailboxId ? pgpInbox(mailboxId) : null);
  const drafts = $derived(mailboxId ? pgpDrafts(mailboxId) : null);
  const sent = $derived(mailboxId ? pgpSent(mailboxId) : null);
  let deviceKey = $state<DevicePgpKey | null>(null);
  let unlocked: openpgp.PrivateKey | null = $state(null);
  let passphrase = $state('');
  let legacyAvailable = $state(false);
  let contacts = $state<PgpContact[]>([]);
  let contactAddress = $state('');
  let contactArmor = $state('');
  let contactFingerprint = $state('');
  let toText = $state(''), ccText = $state(''), bccText = $state('');
  let subject = $state(''), text = $state('');
  let inReplyTo = $state(''), references = $state('');
  let attachments = $state<PgpAttachment[]>([]);
  let draftId = $state(''), revision = $state(0);
  let dirty = $state(false), saving = $state(false), busy = $state(false);
  let localDrafts = $state<LocalPgpDraft[]>([]);
  let pending = $state<LocalPgpDraft | null>(null);
  let received = $state<Awaited<ReturnType<typeof readPgpMime>> | null>(null);
  let error = $state(''), status = $state('');
  let duplicateConfirmed = $state(false);
  let epoch = 0, edits = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<boolean> = Promise.resolve(true);

  const parseAddresses = (value: string) => value.split(/[,;\n]/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const message = (): PgpCompose => ({ from: box?.address ?? '', to: parseAddresses(toText), cc: parseAddresses(ccText), bcc: parseAddresses(bccText), subject, text, attachments: $state.snapshot(attachments), ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) });
  const fail = (cause: unknown) => { error = cause instanceof Error ? cause.message : 'Opération impossible.'; };
  async function refreshLocal() { if (mailboxId) localDrafts = await localPgpDrafts(data.user.id, mailboxId); }
  function clearCompose() {
    clearTimeout(saveTimer);
    toText = ''; ccText = ''; bccText = ''; subject = ''; text = ''; attachments = [];
    inReplyTo = ''; references = ''; draftId = crypto.randomUUID(); revision = 0; dirty = false; pending = null; edits++;
  }
  function restoreCompose(value: PgpCompose, id: string, savedRevision: number) {
    toText = value.to.join(', '); ccText = value.cc.join(', '); bccText = value.bcc.join(', ');
    subject = value.subject; text = value.text; attachments = value.attachments;
    inReplyTo = value.inReplyTo ?? ''; references = value.references ?? '';
    draftId = id; revision = savedRevision; dirty = false; pending = null; edits++;
  }
  function changed() {
    if (!unlocked || pending) return;
    dirty = true; edits++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveCurrent(); }, 500);
  }
  function saveCurrent(): Promise<boolean> {
    clearTimeout(saveTimer);
    if (!unlocked || !mailboxId || !dirty || pending) return saveChain;
    const key = unlocked, selected = mailboxId, id = draftId, value = message(), edit = edits, version = epoch;
    saveChain = saveChain.catch(() => false).then(async () => {
      if (version !== epoch) return false;
      saving = true;
      let localSafe = false;
      try {
        const ciphertext = await encryptPgpDraft(value, key);
        const item = { id, revision, ciphertext, updatedAt: Date.now(), kind: 'draft' as const };
        try { await saveLocalPgpDraft(data.user.id, selected, item); localSafe = true; } catch { /* server persistence can still succeed */ }
        try {
          const result = await savePgpDraft({ mailboxId: selected, id, revision: item.revision, ciphertext });
          if (version === epoch && draftId === id) revision = result.revision;
          if (localSafe) await saveLocalPgpDraft(data.user.id, selected, { ...item, revision: result.revision });
          localSafe = true;
          if (version === epoch) status = 'Brouillon chiffré sauvegardé. Objet, texte et pièces jointes restent illisibles côté serveur.';
        } catch (cause) {
          if (version === epoch) {
            fail(cause);
            status = localSafe ? 'Copie chiffrée conservée sur cet appareil. La synchronisation a échoué ; un conflit ne sera jamais écrasé automatiquement.' : 'Le brouillon n’a pas pu être sauvegardé.';
          }
        }
        if (version === epoch && edits === edit && localSafe) dirty = false;
        if (version === epoch) { await refreshLocal(); await drafts?.refresh(); }
        return localSafe;
      } catch (cause) { if (version === epoch) fail(cause); return false; }
      finally { if (version === epoch) saving = false; }
    });
    return saveChain;
  }
  async function switchMailbox(event: Event) {
    const input = event.currentTarget as HTMLSelectElement;
    const next = input.value;
    if (dirty && !await saveCurrent()) { input.value = mailboxId; return; }
    await saveChain;
    epoch++; unlocked = null; deviceKey = null; passphrase = ''; received = null; error = ''; status = ''; clearCompose();
    mailboxId = next;
    if (!next) { localDrafts = []; return; }
    try { deviceKey = loadDeviceKey(localStorage, data.user.id, next); await refreshLocal(); } catch (cause) { fail(cause); }
  }
  onMount(() => {
    draftId = crypto.randomUUID();
    try { contacts = loadPgpContacts(localStorage, data.user.id); legacyAvailable = !!localStorage.getItem('pgmailcryp:encrypted-private-key'); } catch (cause) { fail(cause); }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } };
    const requested = new URL(location.href).searchParams.get('mailbox');
    if (requested) void (async () => {
      const available = await boxesQuery;
      if (!available.some((item) => item.id === requested && item.isPersonal)) return;
      mailboxId = requested;
      deviceKey = loadDeviceKey(localStorage, data.user.id, requested);
      await refreshLocal();
    })().catch(fail);
    window.addEventListener('beforeunload', beforeUnload);
    return () => { epoch++; clearTimeout(saveTimer); unlocked = null; received = null; window.removeEventListener('beforeunload', beforeUnload); };
  });
  async function acceptKey(armored: string) {
    if (!mailboxId) throw new Error('Sélectionne une boîte.');
    const privateKey = await openpgp.readPrivateKey({ armoredKey: armored });
    const existing = await mailboxPgpPublicKey(mailboxId);
    if (existing && existing.fingerprint !== privateKey.getFingerprint().toUpperCase()) throw new Error('Cette clé ne correspond pas à la clé déjà publiée pour la boîte.');
    deviceKey = await saveDeviceKey(localStorage, data.user.id, mailboxId, armored);
    unlocked = null; passphrase = '';
    status = 'Clé privée protégée enregistrée uniquement sur cet appareil. Exporte une sauvegarde.';
  }
  async function generateKey() {
    if (!box || passphrase.length < 12) { error = 'Choisis une boîte et une phrase de passe de 12 caractères minimum.'; return; }
    busy = true; error = '';
    try {
      const pair = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: box.address }], passphrase });
      await acceptKey(pair.privateKey);
    } catch (cause) { fail(cause); } finally { busy = false; }
  }
  async function importKey(event: Event) {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    busy = true; error = '';
    try {
      if (file.size > 100_000 || passphrase.length < 12) throw new Error('Clé trop volumineuse ou phrase de passe trop courte.');
      const key = await openpgp.readPrivateKey({ armoredKey: await file.text() });
      const plain = key.isDecrypted() ? key : await openpgp.decryptKey({ privateKey: key, passphrase });
      await acceptKey((await openpgp.encryptKey({ privateKey: plain, passphrase })).armor());
    } catch (cause) { fail(cause); } finally { busy = false; input.value = ''; }
  }
  async function importLegacy() {
    busy = true; error = '';
    try {
      const saved = JSON.parse(localStorage.getItem('pgmailcryp:encrypted-private-key') ?? '{}');
      await acceptKey(saved.privateKey);
    } catch (cause) { fail(cause); } finally { busy = false; }
  }
  async function unlock() {
    if (!deviceKey) return;
    busy = true; error = '';
    try { unlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: deviceKey.privateKeyArmored }), passphrase }); status = 'Clé ouverte uniquement dans cet onglet.'; }
    catch { error = 'Phrase de passe incorrecte ou clé invalide.'; }
    finally { passphrase = ''; busy = false; }
  }
  async function lock() {
    busy = true;
    if (dirty && !await saveCurrent()) { busy = false; return; }
    await saveChain; epoch++; unlocked = null; received = null; passphrase = ''; clearCompose(); saving = false; busy = false;
    status = 'Clé et contenu déchiffré retirés de l’écran. Les copies sauvegardées restent chiffrées.';
  }
  function download(filename: string, bytes: Uint8Array) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function publish() {
    if (!deviceKey) return;
    busy = true; error = '';
    try { const key = await openpgp.readPrivateKey({ armoredKey: deviceKey.privateKeyArmored }); await publishMailboxPgpKey({ mailboxId, publicKeyArmored: key.toPublic().armor() }); status = 'Clé publique publiée. Les nouvelles réceptions se lisent dans cette messagerie.'; }
    catch (cause) { fail(cause); } finally { busy = false; }
  }
  async function discoverContact() {
    busy = true; error = '';
    try { const found = await lookupPgpRecipient(contactAddress.trim().toLowerCase()); if (!found) throw new Error('Aucune clé dans l’annuaire local. Demande la clé publique au destinataire.'); contactArmor = found.publicKeyArmored; status = `Clé trouvée : ${found.fingerprint}. Compare son empreinte par un autre canal avant de l’enregistrer.`; }
    catch (cause) { fail(cause); } finally { busy = false; }
  }
  async function pinContact() {
    busy = true; error = '';
    try {
      const contact = await verifyContact(contactAddress, contactArmor, contactFingerprint);
      const next = [...contacts.filter((item) => item.address !== contact.address), contact];
      savePgpContacts(localStorage, data.user.id, next); contacts = next;
      contactAddress = ''; contactArmor = ''; contactFingerprint = ''; status = 'Clé du contact enregistrée avec l’empreinte comparée.';
    } catch (cause) { fail(cause); } finally { busy = false; }
  }
  async function addAttachments(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    busy = true; error = '';
    try {
      const added: PgpAttachment[] = [];
      for (const file of input.files ?? []) {
        if (file.size > MAX_PGP_ATTACHMENT_BYTES) throw new Error('Maximum : 4 Mio de pièces jointes par message.');
        added.push({ name: file.name, contentType: file.type || 'application/octet-stream', base64: bytesBase64(new Uint8Array(await file.arrayBuffer())) });
      }
      const next = [...attachments, ...added];
      if (next.length > 20 || next.reduce((sum, item) => sum + base64Bytes(item.base64).byteLength, 0) > MAX_PGP_ATTACHMENT_BYTES) throw new Error('Maximum : 20 pièces et 4 Mio au total.');
      attachments = next; changed();
    } catch (cause) { fail(cause); } finally { busy = false; input.value = ''; }
  }
  async function loadDraft(id: string, savedRevision: number, local?: LocalPgpDraft) {
    if (!unlocked) return;
    if (dirty && !await saveCurrent()) return;
    busy = true; error = ''; const version = epoch;
    try {
      if (local?.kind === 'pending') { clearCompose(); pending = local; draftId = id; revision = savedRevision; status = 'Envoi en attente retrouvé : réessaie le même identifiant pour éviter un doublon.'; return; }
      let ciphertext = local?.ciphertext;
      if (!ciphertext) { const response = await fetch(`/api/pgp/${mailboxId}/objects/draft/${id}`, { cache: 'no-store' }); if (!response.ok) throw new Error(`Lecture impossible (${response.status}).`); ciphertext = await response.text(); }
      const value = await decryptPgpDraft(ciphertext, unlocked);
      if (version === epoch) restoreCompose(value, id, savedRevision);
    } catch (cause) { if (version === epoch) fail(cause); } finally { busy = false; }
  }
  async function submit() {
    if (!unlocked || !box || !published?.current) return;
    busy = true; error = ''; clearTimeout(saveTimer);
    try {
      await saveChain;
      if (unlocked.getFingerprint().toUpperCase() !== published.current.fingerprint) throw new Error('La clé locale ne correspond pas à cette boîte.');
      let item = pending;
      if (!item) {
        const value = message();
        const encrypted = await encryptPgpMail(value, unlocked, contacts, `<${draftId}@${box.address.split('@')[1]}>`);
        item = { scope: '', id: draftId, revision, ciphertext: encrypted.ciphertext, updatedAt: Date.now(), kind: 'pending', routing: { to: value.to, cc: value.cc, bcc: value.bcc } };
        await saveLocalPgpDraft(data.user.id, mailboxId, item); pending = item;
      }
      if (!item.routing) throw new Error('Enveloppe d’envoi locale manquante.');
      await sendPgpMessage({ mailboxId, id: item.id, ...item.routing, ciphertext: item.ciphertext });
      await removeLocalPgpDraft(data.user.id, mailboxId, item.id, 'pending');
      if (item.revision > 0) await deletePgpDraft({ mailboxId, id: item.id, revision: item.revision }).catch(() => {});
      await removeLocalPgpDraft(data.user.id, mailboxId, item.id);
      clearCompose(); await refreshLocal(); await sent?.refresh(); await drafts?.refresh();
      status = 'Envoi chiffré mis en file. Consulte son état : « sent » signifie accepté par le prochain MTA, pas livré dans la boîte finale.';
    } catch (cause) { fail(cause); await refreshLocal().catch(() => {}); } finally { busy = false; }
  }
  async function openMessage(id: string, kind: 'inbox' | 'sent') {
    if (!unlocked || !box) return;
    const version = epoch; busy = true; error = ''; received = null;
    try {
      const url = kind === 'inbox' ? `/api/pgp/${mailboxId}/${id}` : `/api/pgp/${mailboxId}/objects/sent/${id}`;
      const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`Lecture impossible (${response.status}).`);
      const options = { contacts: [...contacts, { address: box.address, fingerprint: unlocked.getFingerprint().toUpperCase(), publicKeyArmored: unlocked.toPublic().armor() }] };
      const result = kind === 'inbox' ? await decryptPgpMime(await response.text(), unlocked, options) : await readPgpMime(new Uint8Array(await response.arrayBuffer()), unlocked, options);
      if (version === epoch) received = result;
    } catch (cause) { if (version === epoch) fail(cause); } finally { busy = false; }
  }
  async function replyOrForward(forward = false) {
    if (!received || !box) return;
    if (dirty && !await saveCurrent()) return;
    const email = received.email;
    clearCompose();
    toText = forward ? '' : email.replyTo?.[0]?.address ?? email.from?.address ?? '';
    subject = `${forward ? 'Fwd' : 'Re'}: ${email.subject ?? ''}`;
    text = `\n\n${forward ? 'Message transféré' : 'Message précédent'} :\n${email.text ?? email.html ?? ''}`;
    if (!forward) { inReplyTo = email.messageId ?? ''; references = [email.references, email.messageId].filter(Boolean).join(' '); }
    else attachments = email.attachments.map((part, i) => ({ name: part.filename ?? `piece-${i + 1}`, contentType: part.mimeType, base64: typeof part.content === 'string' ? bytesBase64(new TextEncoder().encode(part.content)) : bytesBase64(new Uint8Array(part.content)) }));
    changed();
  }
  function duplicateDraft() { if (pending) return; draftId = crypto.randomUUID(); revision = 0; changed(); status = 'Copie créée avec un nouvel identifiant ; l’autre version reste intacte.'; }
  async function newDraft() { if (dirty && !await saveCurrent()) return; if (pending) { error = 'Résous d’abord l’envoi en attente pour éviter un doublon.'; return; } clearCompose(); }
  async function retry(id: string) { busy = true; error = ''; try { await retryPgpSend({ mailboxId, id, confirmPossibleDuplicate: duplicateConfirmed }); await sent?.refresh(); } catch (cause) { fail(cause); } finally { busy = false; duplicateConfirmed = false; } }
</script>

<svelte:head><title>PgMailCryP · Messagerie OpenPGP</title><meta name="description" content="Messagerie OpenPGP avec chiffrement et déchiffrement sur cet appareil." /></svelte:head>
<main class="mx-auto grid w-full max-w-5xl gap-6 p-4 sm:p-8">
  <header class="space-y-2"><p class="text-sm font-medium text-primary">PgMailCryP · Test développeur</p><h1 class="text-3xl font-semibold">Messagerie OpenPGP</h1><p class="text-sm text-muted-foreground">Les envois sont chiffrés sur cet appareil. Un courriel ordinaire reçu reste visible au serveur avant son chiffrement de stockage. Les anciens messages Doota gardent leurs anciennes garanties.</p></header>
  {#if error}<p role="alert" class="rounded-md border border-destructive p-3">{error}</p>{/if}
  {#if status}<p role="status" class="rounded-md border p-3 text-sm">{status}</p>{/if}
  <label class="grid gap-2 text-sm">Boîte personnelle<select class="rounded-md border bg-background p-2" value={mailboxId} disabled={busy} onchange={switchMailbox}><option value="">Choisir une boîte</option>{#each boxes as item (item.id)}<option value={item.id}>{item.address}</option>{/each}</select></label>
  {#if mailboxId}
    <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-lg font-semibold">Clé de cet appareil</h2>
      {#if deviceKey}<p class="break-all font-mono text-xs">{deviceKey.fingerprint}</p>{/if}
      {#if published?.current}<p class="break-all text-xs">Empreinte publiée : {published.current.fingerprint}</p>{/if}
      {#if !unlocked}<label class="grid gap-2 text-sm">Phrase de passe<input class="rounded-md border bg-background p-2" type="password" bind:value={passphrase} autocomplete="off" /></label>{/if}
      <div class="flex flex-wrap gap-2">
        {#if deviceKey}{#if unlocked}<Button disabled={busy} onclick={lock}>Verrouiller</Button>{:else}<Button disabled={busy} onclick={unlock}>Déverrouiller</Button>{/if}<Button variant="outline" onclick={() => deviceKey && download('pgmailcryp-private-encrypted.asc', new TextEncoder().encode(deviceKey.privateKeyArmored))}>Sauvegarder la clé privée chiffrée</Button><Button variant="outline" onclick={() => deviceKey && download('pgmailcryp-public.asc', new TextEncoder().encode(deviceKey.publicKeyArmored))}>Exporter la clé publique</Button>{#if !published?.current}<Button disabled={busy} onclick={publish}>Activer cette boîte avec la clé publique</Button>{/if}
        {:else}<Button disabled={busy || passphrase.length < 12} onclick={generateKey}>Générer ma clé</Button>{#if legacyAvailable}<Button variant="outline" disabled={busy} onclick={importLegacy}>Récupérer la clé de l’ancien atelier</Button>{/if}{/if}
      </div>
      {#if !deviceKey}<label class="grid gap-2 text-sm">Importer une clé privée (phrase de passe de 12 caractères minimum)<input type="file" accept=".asc,.pgp,.gpg" disabled={busy} onchange={importKey} /></label>{/if}
      <p class="text-xs text-muted-foreground">Clé privée protégée stockée par compte et boîte sur cet appareil. Aucun serveur ne peut la récupérer pour toi. La rotation de clé reste bloquée ; conserve ta sauvegarde.</p>
    </section>
    <details class="rounded-xl border p-5"><summary class="cursor-pointer font-semibold">Clés des contacts · comparer les empreintes</summary><div class="mt-4 grid gap-3">
      <p class="text-sm text-muted-foreground">Compare l’empreinte complète avec ton correspondant par un canal indépendant. Une clé trouvée dans l’annuaire n’est pas approuvée automatiquement.</p>
      <label class="grid gap-2 text-sm">Adresse du contact<input class="rounded-md border bg-background p-2" type="email" bind:value={contactAddress} /></label>
      <Button variant="outline" disabled={busy || !contactAddress} onclick={discoverContact}>Chercher dans l’annuaire local</Button>
      <label class="grid gap-2 text-sm">Clé publique du contact<textarea class="min-h-24 rounded-md border bg-background p-2 font-mono text-xs" bind:value={contactArmor}></textarea></label>
      <label class="grid gap-2 text-sm">Empreinte complète comparée<input class="rounded-md border bg-background p-2 font-mono" bind:value={contactFingerprint} /></label>
      <Button disabled={busy || !contactArmor || !contactFingerprint} onclick={pinContact}>Enregistrer la clé comparée</Button>
      <ul class="grid gap-2">{#each contacts as contact (contact.address)}<li class="break-all text-xs">{contact.address} · {contact.fingerprint}</li>{/each}</ul>
    </div></details>
    {#if unlocked && published?.current}
      <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-lg font-semibold">Écrire un message</h2>
        <fieldset disabled={busy || !!pending} class="grid gap-3">
          <label class="grid gap-2 text-sm">À (adresses séparées par des virgules)<input class="rounded-md border bg-background p-2" bind:value={toText} oninput={changed} /></label>
          <div class="grid gap-3 sm:grid-cols-2"><label class="grid gap-2 text-sm">Cc<input class="rounded-md border bg-background p-2" bind:value={ccText} oninput={changed} /></label><label class="grid gap-2 text-sm">Cci<input class="rounded-md border bg-background p-2" bind:value={bccText} oninput={changed} /></label></div>
          <label class="grid gap-2 text-sm">Objet (chiffré)<input class="rounded-md border bg-background p-2" bind:value={subject} oninput={changed} /></label>
          <label class="grid gap-2 text-sm">Message<textarea class="min-h-40 rounded-md border bg-background p-2" bind:value={text} oninput={changed}></textarea></label>
          <label class="grid gap-2 text-sm">Pièces jointes · 4 Mio au total<input type="file" multiple onchange={addAttachments} /></label>
          <ul class="grid gap-2">{#each attachments as part, i}<li class="flex items-center gap-2 text-sm"><span>{part.name}</span><Button variant="outline" onclick={() => { attachments = attachments.filter((_, index) => index !== i); changed(); }}>Retirer</Button></li>{/each}</ul>
        </fieldset>
        <p class="text-xs text-muted-foreground">Brouillons sauvegardés chiffrés après une pause de saisie. Une fermeture brutale avant la sauvegarde peut perdre les dernières frappes. Aucun repli vers un envoi en clair n’est proposé.</p>
        <div class="flex flex-wrap gap-2"><Button disabled={busy || saving} onclick={submit}>{pending ? 'Réessayer le même envoi chiffré' : 'Chiffrer, signer et envoyer'}</Button><Button variant="outline" disabled={busy || saving || !!pending} onclick={() => saveCurrent()}>Sauvegarder le brouillon</Button><Button variant="outline" disabled={busy || saving || !!pending} onclick={newDraft}>Nouveau brouillon</Button><Button variant="outline" disabled={busy || saving || !!pending} onclick={duplicateDraft}>Dupliquer le brouillon</Button></div>
        {#if saving}<p class="text-xs" role="status">Sauvegarde chiffrée…</p>{/if}
      </section>
    {/if}
    <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-lg font-semibold">Brouillons chiffrés</h2>
      <p class="text-xs text-muted-foreground">Seuls l’identifiant, la révision et la date sont affichés avant déchiffrement.</p>
      <h3 class="text-sm font-medium">Sur cet appareil</h3><ul class="grid gap-2">{#each localDrafts as item (`${item.kind}:${item.id}`)}<li class="flex flex-wrap items-center gap-2 text-sm">{new Date(item.updatedAt).toLocaleString()} · {item.kind === 'pending' ? 'envoi en attente' : 'brouillon'}<Button variant="outline" disabled={busy || !unlocked} onclick={() => loadDraft(item.id, item.revision, item)}>Ouvrir localement</Button></li>{:else}<li class="text-sm text-muted-foreground">Aucune copie locale.</li>{/each}</ul>
      <h3 class="text-sm font-medium">Synchronisés</h3><ul class="grid gap-2">{#each drafts?.current ?? [] as item (item.id)}<li class="flex flex-wrap items-center gap-2 text-sm">{new Date(item.updatedAt).toLocaleString()}<Button variant="outline" disabled={busy || !unlocked} onclick={() => loadDraft(item.id, item.revision)}>Ouvrir localement</Button><Button variant="outline" disabled={busy || !unlocked} onclick={async () => { try { await deletePgpDraft({ mailboxId, id: item.id, revision: item.revision }); await removeLocalPgpDraft(data.user.id, mailboxId, item.id); await refreshLocal(); await drafts?.refresh(); } catch (cause) { fail(cause); } }}>Supprimer</Button></li>{:else}<li class="text-sm text-muted-foreground">Aucun brouillon synchronisé.</li>{/each}</ul>
    </section>
    <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-lg font-semibold">Réception</h2><Button variant="outline" disabled={busy} onclick={() => inbox?.refresh()}>Actualiser la réception</Button>
      <ul class="grid gap-2">{#each inbox?.current ?? [] as item (item.id)}<li class="flex flex-wrap items-center gap-2 text-sm">{new Date(item.receivedAt).toLocaleString()}<Button variant="outline" disabled={busy || !unlocked} onclick={() => openMessage(item.id, 'inbox')}>Lire sur cet appareil</Button></li>{:else}<li class="text-sm text-muted-foreground">Aucun message dans ce parcours.</li>{/each}</ul>
    </section>
    <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-lg font-semibold">Envois</h2><Button variant="outline" disabled={busy} onclick={() => sent?.refresh()}>Actualiser les envois</Button>
      <ul class="grid gap-3">{#each sent?.current ?? [] as item (item.id)}<li class="grid gap-2 rounded-md border p-3 text-sm"><span>{new Date(item.createdAt).toLocaleString()}</span>{#each item.recipients as recipient (recipient.address)}<span class="break-all">{recipient.address} : {recipient.status}{recipient.errorCode ? ` · ${recipient.errorCode}` : ''}</span>{/each}<div class="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !unlocked} onclick={() => openMessage(item.id, 'sent')}>Lire ma copie chiffrée</Button>{#if item.recipients.some((recipient) => ['failed', 'uncertain'].includes(recipient.status))}<Button variant="outline" disabled={busy} onclick={() => retry(item.id)}>Réessayer les destinataires en échec</Button>{/if}</div></li>{:else}<li class="text-sm text-muted-foreground">Aucun envoi.</li>{/each}</ul>
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={duplicateConfirmed} />Si l’acceptation SMTP est indéterminée, j’accepte qu’une nouvelle tentative puisse créer un doublon.</label>
    </section>
    {#if received}
      <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-lg font-semibold">{received.email.subject || '(sans objet)'}</h2><p class="text-sm">De : {received.email.from?.address ?? '(inconnu)'}</p>
        <p class="text-sm">{received.encryptedLayers ? 'Message chiffré par l’expéditeur.' : 'Courriel ordinaire : le serveur l’a vu avant le chiffrement de stockage.'}</p>
        <p class:font-semibold={received.signatureStatus === 'invalid'} class="text-sm">{received.signatureStatus === 'verified' ? `Signature vérifiée avec la clé comparée : ${received.signerFingerprint}` : received.signatureStatus === 'invalid' ? 'Signature invalide : ne pas faire confiance à ce contenu.' : received.signatureStatus === 'unverified' ? 'Signature présente mais identité non vérifiée. Compare et enregistre la clé du contact.' : 'Aucune signature de l’expéditeur.'}</p>
        <pre class="whitespace-pre-wrap break-words font-sans text-sm">{received.email.text || received.email.html || '(sans texte)'}</pre>
        {#if !received.email.text && received.email.html}<p class="text-xs text-muted-foreground">Source HTML affichée comme texte. Aucune image distante chargée.</p>{/if}
        {#each received.email.attachments as part, i}<Button variant="outline" onclick={() => download(part.filename || `piece-${i + 1}`, typeof part.content === 'string' ? new TextEncoder().encode(part.content) : new Uint8Array(part.content))}>Télécharger {part.filename || `pièce ${i + 1}`}</Button>{/each}
        <div class="flex flex-wrap gap-2"><Button variant="outline" disabled={!unlocked || busy || !!pending} onclick={() => replyOrForward()}>Répondre chiffré</Button><Button variant="outline" disabled={!unlocked || busy || !!pending} onclick={() => replyOrForward(true)}>Transférer chiffré</Button><Button variant="outline" onclick={() => received && download('message-dechiffre.eml', received.decryptedRaw)}>Exporter le MIME déchiffré</Button></div>
      </section>
    {/if}
    {#if inbox?.error || sent?.error || drafts?.error || published?.error}<p role="alert" class="text-sm">Une liste n’a pas pu être chargée. Vérifie les droits et les migrations.</p>{/if}
  {/if}
</main>
