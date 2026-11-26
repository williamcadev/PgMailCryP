<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import * as openpgp from 'openpgp';
	import { Button } from '$lib/components/ui/button/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import { publishMailboxPgpKey } from '$lib/rpc/pgp.remote';

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
	const activeMailboxId = $derived(selectedMailboxId || mailboxes[0]?.id || '');

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
			const pair = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519', userIDs: [{ email: address }] });
			const protectedKey = await openpgp.encryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: pair.privateKey }), passphrase });
			publicKeyArmored = pair.publicKey;
			privateKeyArmored = protectedKey.armor();
			localStorage.setItem(storageKey, JSON.stringify({ address, publicKey: publicKeyArmored, privateKey: privateKeyArmored }));
			unlockedPrivateKey = protectedKey;
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
			if (passphrase.length < 12) throw new Error('Saisis une phrase de passe de 12 caractères minimum pour protéger la clé importée.');
			const imported = await openpgp.readPrivateKey({ armoredKey: await file.text() });
			const protectedKey = imported.isDecrypted()
				? await openpgp.encryptKey({ privateKey: imported, passphrase })
				: await openpgp.decryptKey({ privateKey: imported, passphrase }).then((key) => openpgp.encryptKey({ privateKey: key, passphrase }));
			privateKeyArmored = protectedKey.armor();
			publicKeyArmored = protectedKey.toPublic().armor();
			localStorage.setItem(storageKey, JSON.stringify({ address, publicKey: publicKeyArmored, privateKey: privateKeyArmored }));
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
			const result = await publishMailboxPgpKey({ mailboxId: activeMailboxId, publicKeyArmored });
			status = `Clé publique publiée pour cette boîte. Empreinte ${result.fingerprint}`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Impossible de publier la clé publique.';
		} finally {
			busy = false;
		}
	}

	function lockKey() {
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
		<p class="text-muted-foreground">Génère une clé sur cet appareil, puis chiffre un message de démonstration. La clé privée et le message ne sont envoyés à aucun serveur depuis cette page.</p>
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
		{#if publicKeyArmored}<div class="mt-4 flex flex-wrap items-end gap-3"><label class="grid min-w-64 gap-2 text-sm">Boîte de réception<select class="rounded-md border bg-background px-3 py-2" bind:value={selectedMailboxId}><option value="">Sélectionner une boîte</option>{#each mailboxes as mailbox (mailbox.id)}<option value={mailbox.id}>{mailbox.address}</option>{/each}</select></label><Button disabled={busy || !activeMailboxId} onclick={publishPublicKey}>Publier la clé publique pour cette boîte</Button></div>{/if}
		{#if !privateKeyArmored}<label class="mt-4 grid max-w-sm gap-2 text-sm">Ou importer une clé privée OpenPGP<input class="rounded-md border p-2 text-sm" type="file" accept=".asc,.pgp,.gpg,text/plain" onchange={importPrivateKey} /></label>{/if}
		{#if publicKeyArmored}<details class="mt-4"><summary class="cursor-pointer text-sm">Afficher la clé publique</summary><textarea readonly class="mt-2 min-h-28 w-full rounded-md border bg-muted p-3 font-mono text-xs" value={publicKeyArmored}></textarea></details>{/if}
	</section>

	<section class="rounded-xl border p-5">
		<h2 class="text-lg font-semibold">2. Message de test</h2>
		<p class="mt-1 text-sm text-muted-foreground">Laisse la clé destinataire vide pour chiffrer vers ta propre clé. Tu peux aussi coller la clé publique d’un destinataire.</p>
		<label class="mt-4 grid gap-2 text-sm">Clé publique du destinataire<textarea class="min-h-24 rounded-md border bg-background p-3 font-mono text-xs" bind:value={recipientPublicKey} placeholder="Optionnel · colle une clé publique OpenPGP"></textarea></label>
		<label class="mt-4 grid gap-2 text-sm">Message<textarea class="min-h-28 rounded-md border bg-background p-3" bind:value={message} placeholder="Écris un message de test…"></textarea></label>
		<div class="mt-4 flex flex-wrap gap-2"><Button disabled={!message || !publicKeyArmored} onclick={encryptDemoMessage}>Chiffrer</Button>{#if encryptedMessage}<Button variant="outline" disabled={!unlockedPrivateKey} onclick={decryptDemoMessage}>Déchiffrer dans le navigateur</Button>{/if}</div>
		{#if encryptedMessage}<label class="mt-4 grid gap-2 text-sm">Message chiffré<textarea readonly class="min-h-32 rounded-md border bg-muted p-3 font-mono text-xs" bind:value={encryptedMessage}></textarea></label>{/if}
		{#if decryptedMessage}<div class="mt-4 rounded-md border bg-muted p-3"><p class="text-xs text-muted-foreground">Texte déchiffré localement</p><p class="mt-1 whitespace-pre-wrap">{decryptedMessage}</p></div>{/if}
	</section>

	<p class="text-xs text-muted-foreground">Prototype local. La clé privée chiffrée est conservée dans le stockage local du navigateur. La gestion multi-appareils, la récupération et le transport mail ne sont pas encore branchés.</p>
</main>
