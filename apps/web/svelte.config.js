import adapter from "@sveltejs/adapter-cloudflare";
import nodeAdapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: process.env.PGMAILCRYP_BUILD_TARGET === 'node' ? nodeAdapter({ out: 'build-node' }) : adapter(),
      experimental: {
        explicitEnvironmentVariables: true,
        remoteFunctions: true,
    },
    // Poll for a new build every 60s so `updated` flips true after a deploy and
    // the "Update ready — Restart" prompt appears (components/app/update-notifier).
    version: {
      pollInterval: 60000,
    },
  },
  compilerOptions: {
    experimental: {
      async: true,
    },
  },
};

export default config;
