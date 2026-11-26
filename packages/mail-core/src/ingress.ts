// SPDX-License-Identifier: Apache-2.0

/** Normalized message delivered by an ingress adapter before mailbox routing. */
export type IngressMessage = {
  /** Original RFC 5322 bytes. The adapter must not parse and rebuild the MIME. */
  raw: ArrayBuffer;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: number;
  /** Authentication results supplied by the trusted receiving MTA, if any. */
  authenticationResults?: string | null;
  providerMessageId?: string | null;
};

/** Input that the transport bridge hands to the shared mail pipeline. */
export type IngressAdapter = {
  readonly name: "cloudflare-email-routing" | "stalwart" | (string & {});
  normalize(input: unknown): Promise<IngressMessage>;
};

/** Validate normalized envelope fields before recipient resolution or storage. */
export function validateIngressMessage(message: IngressMessage): void {
  if (!(message.raw instanceof ArrayBuffer)) throw new Error("Ingress MIME must be raw bytes");
  if (!message.envelopeFrom || !message.envelopeTo) throw new Error("Ingress envelope is incomplete");
  if (!Number.isFinite(message.receivedAt)) throw new Error("Ingress timestamp is invalid");
}

/** Stalwart HTTP delivery payload. MIME is base64 so JSON transport preserves bytes. */
export type StalwartWebhookPayload = {
  rawBase64: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt?: number;
  authenticationResults?: string | null;
  messageId?: string | null;
};

export function decodeStalwartWebhook(value: unknown): IngressMessage {
  if (!value || typeof value !== "object") throw new Error("Invalid Stalwart payload");
  const payload = value as Partial<StalwartWebhookPayload>;
  if (typeof payload.rawBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.rawBase64)) {
    throw new Error("Invalid rawBase64 MIME payload");
  }
  const decoded = atob(payload.rawBase64);
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  const result: IngressMessage = {
    raw: bytes.buffer,
    envelopeFrom: payload.envelopeFrom ?? "",
    envelopeTo: payload.envelopeTo ?? "",
    receivedAt: payload.receivedAt ?? Date.now(),
    authenticationResults: payload.authenticationResults,
    providerMessageId: payload.messageId,
  };
  validateIngressMessage(result);
  return result;
}
