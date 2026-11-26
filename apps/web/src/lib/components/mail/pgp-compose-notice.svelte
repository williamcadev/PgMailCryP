<!-- SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  let { mailboxId }: { mailboxId?: string } = $props();
</script>
<div class="m-3 grid gap-3 rounded-lg border p-4 text-sm">
  <p>Les boîtes personnelles utilisent la messagerie OpenPGP. Déverrouille ta clé sur cet appareil pour chiffrer le message et ses pièces jointes avant envoi.</p>
  <a class="font-medium text-primary underline" href={`/pgmailcryp${mailboxId ? `?mailbox=${encodeURIComponent(mailboxId)}` : ''}`}>Ouvrir la messagerie OpenPGP</a>
</div>
