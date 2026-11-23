import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA256 of the exact raw request body. */
export function computeSignature(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verify an `X-Webhook-Signature` header against the RAW body (never a re-serialized one).
 * Accepts "<hex>" or "sha256=<hex>". Length is checked first because timingSafeEqual throws on
 * unequal lengths; a malformed header is simply false.
 */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = computeSignature(rawBody, secret);
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface WebhookAuthInput {
  rawBody: string | undefined;
  signatureHeader: string | undefined;
  /** ?token= from the webhook URL */
  token: string | undefined;
  /** The client's URL token (clients.webhook_secret). */
  urlToken: string;
  /** HMAC secret, when one is configured for this client or globally. */
  signingSecret: string | undefined;
}

/**
 * When a signing secret is configured the signature is REQUIRED and the URL token alone is not enough.
 * Without a secret we fall back to the per-client URL token (the original scheme).
 */
export function authorizeWebhook(i: WebhookAuthInput): { ok: boolean; reason?: string } {
  if (i.signingSecret) {
    if (!i.signatureHeader) return { ok: false, reason: 'missing_signature' };
    if (i.rawBody === undefined) return { ok: false, reason: 'no_raw_body' };
    return verifySignature(i.rawBody, i.signatureHeader, i.signingSecret) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  }
  if (!i.token || !safeEq(i.token, i.urlToken)) return { ok: false, reason: 'bad_token' };
  return { ok: true };
}
