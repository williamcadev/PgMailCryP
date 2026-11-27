// SPDX-License-Identifier: Apache-2.0
// One installer, with native SQLite selected for fresh installations. Existing
// installations retain their runtime until their data migration is verified.
await import('../local/install.mjs');
