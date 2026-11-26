// SPDX-License-Identifier: Apache-2.0
import { installationStatus } from '$lib/server/installation';
export const load = async ({ locals, platform, setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  return { installation: await installationStatus(locals.db, locals.user?.id, platform?.env) };
};
