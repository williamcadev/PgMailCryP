// SPDX-License-Identifier: Apache-2.0
import { build } from 'esbuild';
await build({ entryPoints: ['src/jobs.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: 'dist/jobs.mjs', banner: { js: "import { createRequire as pgmailcrypCreateRequire } from 'node:module'; const require = pgmailcrypCreateRequire(import.meta.url);" } });
