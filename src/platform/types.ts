import type { NormalizedEvent } from '../types.js';

export interface SendCtx { apiKey: string; instagramAccountId: string }

/**
 * The ONLY file-level seam between your bot and the messaging platform.
 * Swapping InstantDM for another provider (or your own Meta integration) means
 * writing one new class that implements this interface. Nothing else changes.
 */
export interface ChannelAdapter {
  /** Turn one raw webhook body into zero or more normalized events. Must never throw. */
  normalize(raw: unknown): NormalizedEvent[];
  sendDm(ctx: SendCtx, recipientId: string, text: string): Promise<{ messageId?: string }>;
  /** Public reply under a comment. */
  replyToComment(ctx: SendCtx, commentId: string, text: string): Promise<void>;
  /** Private reply (DM) tied to a comment. One per comment, within Meta's reply window. */
  sendPrivateReply(ctx: SendCtx, commentId: string, text: string): Promise<{ messageId?: string; recipientId?: string }>;
  /** Optional: pull recent events for the nightly reconciliation job. */
  listRecentEvents?(ctx: SendCtx, since: Date): Promise<unknown[]>;
}

export class PlatformError extends Error {
  /** status 0 = network failure. retryAfterMs comes from a 429 Retry-After header when present. */
  constructor(message: string, public status: number, public retryable: boolean, public retryAfterMs?: number) { super(message); }
}
