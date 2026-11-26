// SPDX-License-Identifier: Apache-2.0
import { handleStalwartWebhook } from '@doota/mail-core/inbound-worker';
import type { RequestHandler } from './$types';

/** Same authenticated ingress as mail-in; also supports the bundled local runtime. */
export const POST: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  if (!env?.DB || !env.MAIL_RAW || !env.MAIL_QUEUE) return new Response('Ingress unavailable', { status: 503 });
  return handleStalwartWebhook(request, {
    DB: env.DB, MAIL_RAW: env.MAIL_RAW, MAIL_QUEUE: env.MAIL_QUEUE,
    MAIL_DEK: env.MAIL_DEK, MAIL_SEARCH_KEY: env.MAIL_SEARCH_KEY,
    STALWART_INGRESS_TOKEN: env.STALWART_INGRESS_TOKEN,
  });
};
