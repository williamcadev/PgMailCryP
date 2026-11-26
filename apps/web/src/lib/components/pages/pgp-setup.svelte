<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { setupRemoteFunction } from '$lib/rpc/setup.remote';
  import { setupSchema } from '$lib/shared/model/auth.zod.schema';
  let { token, domain, transport }: { token: string; domain: string; transport: string } = $props();
  const { fields } = setupRemoteFunction;
  let busy = $state(false), message = $state('');
</script>

<svelte:head><title>Installer PgMailCryP</title><meta name="referrer" content="no-referrer" /></svelte:head>
<main class="mx-auto grid min-h-screen max-w-2xl content-center gap-6 px-5 py-10">
  <header class="space-y-3"><p class="text-sm font-medium">PgMailCryP</p><h1 class="text-3xl font-semibold">Configurer ta messagerie</h1><p>Une installation regroupe l’application et son transport Stalwart.</p></header>
  <section class="grid gap-2 rounded-xl border p-5" aria-label="Installation">
    <p>Domaine de cette installation : <strong>{domain}</strong></p>
    <p>Transport SMTP : {transport === 'ready' ? 'Stalwart joignable, authentification réussie.' : 'À vérifier. Tu pourras consulter son état après connexion.'}</p>
    <p class="text-sm text-muted-foreground">Version locale de test : les courriels restent limités à ce domaine. Le DNS public et les envois Internet ne sont pas activés.</p>
  </section>
  <form class="grid gap-4 rounded-xl border p-5" {...setupRemoteFunction.preflight(setupSchema).enhance(async ({ submit }) => {
    busy = true; message = '';
    try { await submit(); const result = setupRemoteFunction.result; if (result?.success) await goto(resolve('/login')); else message = result?.message ?? 'Configuration impossible.'; }
    catch { message = 'La configuration a échoué. Réessaie ; si elle est indiquée comme interrompue, conserve les données et consulte le guide d’installation.'; }
    finally { busy = false; }
  })}>
    <h2 class="text-xl font-semibold">Ton compte administrateur</h2>
    <input type="hidden" {...fields.setupToken.as('text')} value={token} />
    <label class="grid gap-2">Nom<input class="rounded-md border bg-background p-2" {...fields.name.as('text')} required autocomplete="name" /></label>
    <label class="grid gap-2">Adresse de connexion externe<input class="rounded-md border bg-background p-2" {...fields.email.as('email')} required autocomplete="email" /></label>
    <p class="text-sm text-muted-foreground">Utilise une adresse extérieure à {domain}. Elle sert à te connecter ; ta boîte de messagerie est créée séparément ci-dessous.</p>
    <label class="grid gap-2">Mot de passe de connexion<input class="rounded-md border bg-background p-2" {...fields.password.as('password')} required autocomplete="new-password" /></label>
    <label class="grid gap-2">Ta première adresse de messagerie<span class="flex items-center gap-2"><input class="min-w-0 flex-1 rounded-md border bg-background p-2" {...fields.mailboxLocalPart.as('text')} required placeholder="prenom" autocapitalize="none" spellcheck="false" /><span>@{domain}</span></span></label>
    {#each fields.allIssues() ?? [] as issue}<p role="alert" class="text-sm text-destructive">{issue.message}</p>{/each}
    {#if message}<p role="alert" class="text-sm text-destructive">{message}</p>{/if}
    <p class="text-sm text-muted-foreground">Après connexion, tu activeras la double authentification et une passkey. Tu créeras ensuite ta clé OpenPGP sur ton appareil ; cet écran ne demande aucune clé privée ni phrase de passe OpenPGP.</p>
    <button class="rounded-md bg-primary px-4 py-3 text-primary-foreground disabled:opacity-50" type="submit" disabled={busy}>{busy ? 'Configuration en cours…' : 'Créer mon compte et ma boîte'}</button>
  </form>
</main>
