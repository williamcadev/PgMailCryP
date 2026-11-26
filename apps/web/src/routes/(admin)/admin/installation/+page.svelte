<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { PageProps } from './$types';
  let { data }: PageProps = $props();
  let checking = $state(false);
</script>
<svelte:head><title>Installation · PgMailCryP</title></svelte:head>
<main class="mx-auto grid w-full max-w-4xl gap-6 p-5 sm:p-8">
  <header class="space-y-2"><p class="text-sm font-medium">PgMailCryP</p><h1 class="text-3xl font-semibold">Ta messagerie</h1><p>Application et transport sont installés ensemble sur ton serveur.</p></header>
  <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-xl font-semibold">État de l’installation</h2>
    <p>Domaine : <strong>{data.installation.domain}</strong></p>
    <p>Routage local : {data.installation.domainConfigured ? 'configuré' : 'à vérifier'}</p>
    <p role="status">Stalwart et son pont : {data.installation.transport.state === 'ready' ? 'joignables et authentifiés' : data.installation.transport.state === 'unconfigured' ? 'configuration manquante' : 'indisponibles ; les livraisons en attente doivent être conservées'}</p>
    <button class="w-fit rounded-md border px-4 py-2 disabled:opacity-50" disabled={checking} onclick={async () => { checking = true; try { await invalidateAll(); } finally { checking = false; } }}>{checking ? 'Vérification…' : 'Vérifier le transport'}</button>
    <p class="text-sm text-muted-foreground">Environnement local de test. Ces vérifications ne prouvent ni la configuration du DNS public ni la livraison des courriels Internet.</p>
  </section>
  <section class="grid gap-3 rounded-xl border p-5"><h2 class="text-xl font-semibold">Tes boîtes personnelles</h2>
    {#each data.installation.mailboxes as box (box.id)}<div class="grid gap-2 rounded-md border p-4"><p class="font-medium">{box.address}</p><p class="text-sm">{box.fingerprint ? 'Clé publique publiée. La clé privée reste sur tes appareils.' : 'Crée ou importe ta clé sur cet appareil, puis publie sa partie publique avant de recevoir du courrier.'}</p><a class="w-fit rounded-md bg-primary px-4 py-2 text-primary-foreground" href={`${resolve('/pgmailcryp')}?mailbox=${encodeURIComponent(box.id)}`}>{box.fingerprint ? 'Ouvrir ma messagerie' : 'Configurer ma clé sur cet appareil'}</a></div>
    {:else}<p>Aucune boîte personnelle autorisée. Les installations déjà peuplées conservent leurs comptes ; utilise la gestion des domaines et boîtes pour compléter leur configuration.</p>{/each}
  </section>
  <section class="grid gap-2 rounded-xl border p-5"><h2 class="text-xl font-semibold">Conserver l’accès à tes messages</h2><p>Exporte ta clé privée chiffrée et garde une sauvegarde hors de ce navigateur. Le serveur ne pourra pas la récupérer pour toi.</p><p class="text-sm text-muted-foreground">Un courriel ordinaire reste lisible pendant son arrivée SMTP, avant son chiffrement de stockage. Les anciens contenus Doota gardent leurs anciennes garanties.</p></section>
</main>
