<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import Setup from '$lib/components/pages/setup.svelte';
	import PgpSetup from '$lib/components/pages/pgp-setup.svelte';

	let { data } = $props();
</script>

{#if data.locked}
	<div class="flex min-h-[100dvh] w-full items-center justify-center px-6">
		<div class="max-w-md space-y-3 text-center">
			<h1 class="text-2xl font-bold tracking-wide">Configuration de la messagerie</h1>
			{#if data.reason === 'no-token'}
				<p class="text-muted-foreground text-sm">
					The web setup wizard is disabled because <code>SETUP_TOKEN</code> is not configured.
					Create the super-admin with the CLI instead:
				</p>
				<pre class="bg-muted rounded-md p-3 text-left text-xs">pnpm reset-admin &lt;email&gt; &lt;password&gt;</pre>
			{:else}
				<p class="text-muted-foreground text-sm">
					This page needs the one-time setup token. Open it as
					<code>/setup?token=YOUR_SETUP_TOKEN</code>.
				</p>
			{/if}
		</div>
	</div>
{:else if data.installation}
	<PgpSetup token={data.token} domain={data.installation.domain} transport={data.transport?.state ?? 'unavailable'} />
{:else}
	<Setup token={data.token} />
{/if}
