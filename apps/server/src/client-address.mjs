// SPDX-License-Identifier: Apache-2.0
import { isIP } from 'node:net';

/** Never accept Cloudflare/proxy identity headers from a direct HTTP client. */
export function setClientAddress(request, trustLoopbackProxy = false) {
  const peer = request.socket.remoteAddress ?? '127.0.0.1';
  const address = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  const forwarded = request.headers['x-forwarded-for'];
  const trusted = trustLoopbackProxy && ['127.0.0.1', '::1'].includes(address) && typeof forwarded === 'string' && !!isIP(forwarded.trim());
  const actual = trusted ? forwarded.trim() : address;
  delete request.headers['cf-connecting-ip']; delete request.headers['x-forwarded-for']; delete request.headers['x-real-ip'];
  request.headers['cf-connecting-ip'] = actual;
  request.headers['x-forwarded-for'] = actual;
  return actual;
}
