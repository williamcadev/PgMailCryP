// SPDX-License-Identifier: Apache-2.0
import * as openpgp from 'openpgp';
import PostalMime from 'postal-mime';

/** Only runs in the browser. Original MIME + all attachment bytes stay local. */
export async function decryptPgpMime(armoredMessage: string, key: openpgp.PrivateKey) {
	if (!key.isDecrypted()) throw new Error('Déverrouille la clé privée sur cet appareil.');
	const result = await openpgp.decrypt({
		message: await openpgp.readMessage({ armoredMessage }),
		decryptionKeys: key,
		format: 'binary',
	});
	const raw = new Uint8Array(result.data);
	const email = await PostalMime.parse(raw);
	return { raw, email };
}
