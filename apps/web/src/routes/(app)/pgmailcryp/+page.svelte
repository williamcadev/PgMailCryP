<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import { decryptPgpMime } from '$lib/client/pgp-inbox';
	import * as openpgp from 'openpgp';
	import { Button } from '$lib/components/ui/button/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import { publishMailboxPgpKey, mailboxPgpPublicKey, pgpInbox } from '$lib/rpc/pgp.remote';

	const storageKey = 'pgmailcryp:encrypted-private-key';
	let address = $state('');
	let passphrase = $state('');
	let privateKeyArmored = $state('');
	let publicKeyArmored = $state('');
	let unlockedPrivateKey: openpgp.PrivateKey | null = $state(null);
	let recipientPublicKey = $state('');
	let message = $state('');
	let encryptedMessage = $state('');
	let decryptedMessage = $state('');
	let busy = $state(false);
	let error = $state('');
	let status = $state('');
	let selectedMailboxId = $state('');
	const mailboxQuery = myMailboxes();
	const mailboxes = $derived((mailboxQuery.current ?? []).filter((mailbox) => mailbox.isPersonal));
	const activeMailboxId = $derived(selectedMailboxId);
	const publishedKey = $derived(activeMailboxId ? mailboxPgpPublicKey(activeMailboxId) : null);
	const inbox = $derived(activeMailboxId ? pgpInbox(activeMailboxId) : null);
	let received = $state<Awaited<ReturnType<typeof decryptPgpMime>> | null>(null);
	let readVersion = 0;
	$effect(() => { activeMailboxId; readVersion++; received = null; });

	async function openReceived(id: string) {
		if (!unlockedPrivateKey) return;
		const version = ++readVersion;
		const key = unlockedPrivateKey;
		busy = true;
		error = '';
		received = null;
		try {
			const response = await fetch(`/api/pgp/${encodeURIComponent(activeMailboxId)}/${encodeURIComponent(id)}`, { cache: 'no-store' });
			if (!response.ok) throw new Error(`Lecture impossible (${response.status}).`);
			const result = await decryptPgpMime(await response.text(), key);
			if (version === readVersion) received = result;
		} catch (cause) {
			if (version === readVersion) error = cause instanceof Error ? cause.message : 'Déchiffrement impossible.';
		} finally { busy = false; }
	}

	function downloadBytes(filename: string, bytes: Uint8Array) {
		const link = document.createElement('a');
		const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
		link.href = url;
		link.download = filename;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}


	onMount(() => {
		const saved = localStorage.getItem(storageKey);
		if (!saved) return;
		try {
			const key = JSON.parse(saved) as { address: string; publicKey: string; privateKey: string };
			address = key.address;
			publicKeyArmored = key.publicKey;
			privateKeyArmored = key.privateKey;
			status = 'Clé chiffrée trouvée sur cet appareil. Déverrouille-la pour continuer.';
		} catch {
			localStorage.removeItem(storageKey);
		}
	});

	async function generateKeys() {
		error = '';
		if (!address.includes('@') || passphrase.length < 12) {
			error = 'Saisis une adresse valide et une phrase de passe de 12 caractères minimum.';
			return;
		}
		busy = true;
		try {
			const pair = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: address }] });
			const protectedKey = await openpgp.encryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: pair.privateKey }), passphrase });
			publicKeyArmored = pair.publicKey;
			privateKeyArmored = protectedKey.armor();
			localStorage.setItem(storageKey, JSON.stringify({ address, publicKey: publicKeyArmored, privateKey: privateKeyArmored }));
			unlockedPrivateKey = null;
			passphrase = '';
			status = 'Clé créée. La clé privée conservée sur cet appareil est chiffrée par ta phrase de passe.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'La création de clé a échoué.';
		} finally {
			busy = false;
		}
	}

	async function importPrivateKey(event: Event) {
		error = '';
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > 100_000) throw new Error('Fichier de clé trop volumineux.');
			if (passphrase.length < 12) throw new Error('Saisis une phrase de passe de 12 caractères minimum pour protéger la clé importée.');
			const imported = await openpgp.readPrivateKey({ armoredKey: await file.text() });
			const protectedKey = imported.isDecrypted()
				? await openpgp.encryptKey({ privateKey: imported, passphrase })
				: await openpgp.decryptKey({ privateKey: imported, passphrase }).then((key) => openpgp.encryptKey({ privateKey: key, passphrase }));
			privateKeyArmored = protectedKey.armor();
			publicKeyArmored = protectedKey.toPublic().armor();
			localStorage.setItem(storageKey, JSON.stringify({ address, publicKey: publicKeyArmored, privateKey: privateKeyArmored }));
			unlockedPrivateKey = null;
			passphrase = '';
			status = 'Clé importée et conservée chiffrée dans le navigateur. Saisis sa phrase de passe pour la déverrouiller.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Impossible de lire cette clé privée OpenPGP.';
		}
		input.value = '';
	}

	async function unlockKey() {
		error = '';
		busy = true;
		try {
			const key = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
			unlockedPrivateKey = key.isDecrypted() ? key : await openpgp.decryptKey({ privateKey: key, passphrase });
			passphrase = '';
			status = 'Clé déverrouillée en mémoire dans cet onglet.';
		} catch {
			unlockedPrivateKey = null;
			error = 'Phrase de passe incorrecte ou clé illisible.';
		} finally {
			busy = false;
		}
	}

	async function publishPublicKey() {
		error = '';
		if (!activeMailboxId || !publicKeyArmored) return;
		busy = true;
		try {
			const localPrivate = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
			const localPublic = await openpgp.readKey({ armoredKey: publicKeyArmored });
			if (localPrivate.getFingerprint() !== localPublic.getFingerprint()) throw new Error('La clé publique ne correspond pas à la clé privée locale.');
			const result = await publishMailboxPgpKey({ mailboxId: activeMailboxId, publicKeyArmored: localPrivate.toPublic().armor() });
			status = `Clé publique publiée pour cette boîte. Empreinte ${result.fingerprint}`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Impossible de publier la clé publique.';
		} finally {
			busy = false;
		}
	}

	function lockKey() {
		readVersion++;
		received = null;
		unlockedPrivateKey = null;
		decryptedMessage = '';
		passphrase = '';
		status = 'Clé verrouillée et texte déchiffré effacé de l’écran.';
	}

	async function encryptDemoMessage() {
		error = '';
		try {
			const recipient = await openpgp.readKey({ armoredKey: recipientPublicKey || publicKeyArmored });
			const result = await openpgp.encrypt({ message: await openpgp.createMessage({ text: message }), encryptionKeys: recipient });
			encryptedMessage = result as string;
			decryptedMessage = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Le chiffrement a échoué.';
		}
	}

	async function decryptDemoMessage() {
		error = '';
		if (!unlockedPrivateKey) return;
		try {
			const result = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: encryptedMessage }), decryptionKeys: unlockedPrivateKey });
			decryptedMessage = result.data as string;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Le déchiffrement a échoué.';
		}
	}

	function downloadKey(filename: string, contents: string) {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(new Blob([contents], { type: 'application/pgp-keys' }));
		link.download = filename;
		link.click();
		URL.revokeObjectURL(link.href);
	}
</script>

<svelte:head>
	<title>PgMailCryP · Atelier de chiffrement</title>
	<meta name="description" content="Crée et teste une clé OpenPGP dans ton navigateur." />
</svelte:head>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-8">
	<header class="space-y-2">
		<p class="text-sm font-medium text-primary">PgMailCryP · Prototype</p>
		<h1 class="text-3xl font-semibold tracking-tight">Atelier OpenPGP</h1>
		<p class="text-muted-foreground">La clé privée reste sur cet appareil. Publier la clé publique active une réception séparée : les nouveaux messages se lisent ici, après déchiffrement local. Sauvegarde ta clé privée chiffrée avant de publier.</p>
	</header>

	{#if error}<p role="alert" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{error}</p>{/if}
	{#if status}<p role="status" class="rounded-md border p-3 text-sm">{status}</p>{/if}

	<section class="rounded-xl border p-5">
		<h2 class="text-lg font-semibold">1. Ta clé</h2>
		<div class="mt-4 grid gap-4 sm:grid-cols-2">
			<label class="grid gap-2 text-sm">Adresse de la clé<input class="rounded-md border bg-background px-3 py-2" type="email" bind:value={address} placeholder="toi@exemple.net" /></label>
			<label class="grid gap-2 text-sm">Phrase de passe<input class="rounded-md border bg-background px-3 py-2" type="password" bind:value={passphrase} autocomplete="new-password" placeholder="12 caractères minimum" /></label>
		</div>
		<div class="mt-4 flex flex-wrap gap-2">
			{#if !privateKeyArmored}<Button disabled={busy} onclick={generateKeys}>{busy ? 'Création…' : 'Générer ma paire de clés'}</Button>
			{:else if !unlockedPrivateKey}<Button disabled={busy} onclick={unlockKey}>Déverrouiller</Button>
			{:else}<Button variant="outline" onclick={lockKey}>Verrouiller</Button>{/if}
			{#if publicKeyArmored}<Button variant="outline" onclick={() => downloadKey('pgmailcryp-public.asc', publicKeyArmored)}>Exporter la clé publique</Button><Button variant="outline" onclick={() => downloadKey('pgmailcryp-private-encrypted.asc', privateKeyArmored)}>Exporter la clé privée chiffrée</Button>{/if}
		</div>
		{#if publicKeyArmored}<div class="mt-4 flex flex-wrap items-end gap-3"><label class="grid min-w-64 gap-2 text-sm">Boîte de réception<select class="rounded-md border bg-background px-3 py-2" bind:value={selectedMailboxId}><option value="">Sélectionner une boîte</option>{#each mailboxes as mailbox (mailbox.id)}<option value={mailbox.id}>{mailbox.address}</option>{/each}</select></label><Button disabled={busy || !activeMailboxId} onclick={publishPublicKey}>Activer la réception avec cette clé publique</Button></div>{/if}
		{#if !privateKeyArmored}<label class="mt-4 grid max-w-sm gap-2 text-sm">Ou importer une clé privée OpenPGP<input class="rounded-md border p-2 text-sm" type="file" accept=".asc,.pgp,.gpg,text/plain" onchange={importPrivateKey} /></label>{/if}
		{#if publicKeyArmored}<details class="mt-4"><summary class="cursor-pointer text-sm">Afficher la clé publique</summary><textarea readonly class="mt-2 min-h-28 w-full rounded-md border bg-muted p-3 font-mono text-xs" value={publicKeyArmored}></textarea></details>{/if}
	</section>

	<section class="rounded-xl border p-5">
		<h2 class="text-lg font-semibold">2. Réception chiffrée · pilote</h2>
		<p class="mt-2 text-sm text-muted-foreground">Les 50 derniers messages reçus après activation sont affichés ici, séparément des fils Doota. Le serveur voit le SMTP pendant la réception. Les anciens messages, les envois et les brouillons gardent le stockage Doota. Le remplacement de clé est bloqué.</p>
		{#if publishedKey?.current}<p class="mt-3 break-all text-xs">Clé publiée : {publishedKey.current.fingerprint}</p>{/if}
		{#if publishedKey?.error || inbox?.error}<p role="alert" class="mt-2 text-sm">Impossible de charger cette boîte. Vérifie tes droits et les migrations.</p>{/if}
		<Button class="mt-3" variant="outline" disabled={!inbox || busy} onclick={() => inbox?.refresh()}>Actualiser la réception</Button>
		{#if inbox?.current}
			<ul class="mt-3 grid gap-2">
				{#each inbox.current as item (item.id)}
					<li class="flex flex-wrap items-center gap-2 rounded-md border p-2"><span class="text-sm">{new Date(item.receivedAt).toLocaleString()}</span><Button variant="outline" disabled={busy || !unlockedPrivateKey} onclick={() => openReceived(item.id)}>Ouvrir localement</Button></li>
				{:else}<li class="text-sm text-muted-foreground">Aucun message reçu dans ce parcours.</li>{/each}
			</ul>
		{/if}
		{#if received}
			<div class="mt-4 grid gap-3 rounded-md border p-3">
				<h3 class="font-semibold">{received.email.subject || '(sans objet)'}</h3>
				<p class="text-sm">De : {received.email.from?.address || '(inconnu)'}</p>
				<p class="text-xs text-muted-foreground">Contenu déchiffré localement. Le chiffrement de réception ne vérifie pas l’identité de l’expéditeur.</p>
				<pre class="whitespace-pre-wrap break-words font-sans text-sm">{received.email.text || received.email.html || '(message sans texte)'}</pre>
				{#if !received.email.text && received.email.html}<p class="text-xs text-muted-foreground">Source HTML affichée comme texte ; aucune ressource distante chargée.</p>{/if}
				{#each received.email.attachments as attachment, i}
					<Button variant="outline" onclick={() => downloadBytes(attachment.filename || `piece-jointe-${i + 1}`, typeof attachment.content === 'string' ? new TextEncoder().encode(attachment.content) : new Uint8Array(attachment.content))}>Télécharger {attachment.filename || `pièce jointe ${i + 1}`}</Button>
				{/each}
				<Button variant="outline" onclick={() => received && downloadBytes('message.eml', received.raw)}>Exporter le MIME déchiffré (.eml)</Button>
			</div>
		{/if}
	</section>

	<section class="rounded-xl border p-5">
		<h2 class="text-lg font-semibold">3. Message de test</h2>
		<p class="mt-1 text-sm text-muted-foreground">Laisse la clé destinataire vide pour chiffrer vers ta propre clé. Tu peux aussi coller la clé publique d’un destinataire.</p>
		<label class="mt-4 grid gap-2 text-sm">Clé publique du destinataire<textarea class="min-h-24 rounded-md border bg-background p-3 font-mono text-xs" bind:value={recipientPublicKey} placeholder="Optionnel · colle une clé publique OpenPGP"></textarea></label>
		<label class="mt-4 grid gap-2 text-sm">Message<textarea class="min-h-28 rounded-md border bg-background p-3" bind:value={message} placeholder="Écris un message de test…"></textarea></label>
		<div class="mt-4 flex flex-wrap gap-2"><Button disabled={!message || !publicKeyArmored} onclick={encryptDemoMessage}>Chiffrer</Button>{#if encryptedMessage}<Button variant="outline" disabled={!unlockedPrivateKey} onclick={decryptDemoMessage}>Déchiffrer dans le navigateur</Button>{/if}</div>
		{#if encryptedMessage}<label class="mt-4 grid gap-2 text-sm">Message chiffré<textarea readonly class="min-h-32 rounded-md border bg-muted p-3 font-mono text-xs" bind:value={encryptedMessage}></textarea></label>{/if}
		{#if decryptedMessage}<div class="mt-4 rounded-md border bg-muted p-3"><p class="text-xs text-muted-foreground">Texte déchiffré localement</p><p class="mt-1 whitespace-pre-wrap">{decryptedMessage}</p></div>{/if}
	</section>

	<p class="text-xs text-muted-foreground">Pilote de réception, sans garantie zero-access globale. La clé privée chiffrée est conservée dans le stockage local de ce navigateur. Exporte-la : supprimer ces données sans sauvegarde peut rendre les messages définitivement illisibles. La gestion multi-appareils, la rotation et la récupération ne sont pas encore disponibles.</p>
</main>
