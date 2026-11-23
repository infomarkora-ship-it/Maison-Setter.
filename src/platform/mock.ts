import type { NormalizedEvent } from '../types.js';
import type { ChannelAdapter, SendCtx } from './types.js';

/** In-memory adapter for local simulation and tests. */
export class MockAdapter implements ChannelAdapter {
  sent: Array<{ kind: 'dm' | 'public' | 'private'; to: string; text: string }> = [];
  failNext: Error | null = null;
  normalize(raw: unknown): NormalizedEvent[] { return Array.isArray(raw) ? (raw as NormalizedEvent[]) : []; }
  private maybeFail() { if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; } }
  async sendDm(_c: SendCtx, to: string, text: string) { this.maybeFail(); this.sent.push({ kind: 'dm', to, text }); return { messageId: `mock-${this.sent.length}` }; }
  async replyToComment(_c: SendCtx, to: string, text: string) { this.maybeFail(); this.sent.push({ kind: 'public', to, text }); }
  async sendPrivateReply(_c: SendCtx, to: string, text: string) { this.maybeFail(); this.sent.push({ kind: 'private', to, text }); return { messageId: `mock-${this.sent.length}` }; }
}
