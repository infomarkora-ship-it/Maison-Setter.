import type { CompleteArgs, Llm, LlmResult } from '../src/ai/llm.js';
import type { Client, ConversationState, ToolHost } from '../src/types.js';

export function makeClient(over: Partial<Client> = {}): Client {
  return {
    id: '00000000-0000-0000-0000-000000000001', name: 'Test Studio', status: 'pilot', timezone: 'America/Toronto',
    webhookSecret: 's', platformApiKey: 'k', instagramAccountId: 'ig-own',
    settings: {
      businessSummary: 'A small strength studio in Ottawa.', offer: 'Free 20 minute intro call, then a $400 4-week program',
      idealCustomer: 'Adults in Ottawa who want to get stronger', disqualifiers: ['Outside Ottawa'], qualificationQuestions: ['Goal', 'Start date'],
      tone: 'Friendly and casual', forbiddenClaims: ['guaranteed results'], bookingLink: 'https://cal.com/test/intro',
    },
    knowledge: 'Program: 4-week starter, $400.\n\nClasses run Mon-Sat.',
    commissionRate: 0.2, attributionDays: 45, openerDailyMax: 50, openerWindowStart: 9, openerWindowEnd: 20, hourlySendCap: 600,
    minIntentScore: 60, notifyWebhookUrl: null, calendarProvider: 'mock', calendarConfig: {},
    launchedAt: new Date('2026-11-01T00:00:00Z'), nextOpenerAt: new Date('2026-11-01T00:00:00Z'), promptVersion: 'v1',
    defaultMode: 'qualify_and_book', minCommentDmScore: 0, maxCommentDmsPerDay: null, commentDmMinGapMinutes: 2,
    lowScoreAction: 'review', humanPauseHours: 24, sendHold: false, instantdmWebhookSecret: null,
    ...over,
  };
}

/** Scripted model: returns queued responses in order and records every call. */
export class FakeLlm implements Llm {
  calls: CompleteArgs[] = [];
  constructor(private script: Array<Partial<LlmResult>>) {}
  async complete(a: CompleteArgs): Promise<LlmResult> {
    this.calls.push(JSON.parse(JSON.stringify(a)) as CompleteArgs);
    const r = this.script.shift();
    if (!r) throw new Error('FakeLlm script exhausted');
    return { content: r.content ?? [], stopReason: r.stopReason ?? 'end_turn', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
}

export const text = (t: string): Partial<LlmResult> => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn' });
export const toolUse = (name: string, input: unknown, id = 'tu_1'): Partial<LlmResult> =>
  ({ content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' });

export class FakeHost implements ToolHost {
  log: string[] = [];
  slots = ['2026-11-12T15:00:00Z', '2026-11-13T18:00:00Z'];
  async searchKnowledge(q: string) { this.log.push(`search:${q}`); return 'Program: 4-week starter, $400.'; }
  async checkAvailability(a: string, b: string) { this.log.push(`avail:${a}..${b}`); return this.slots; }
  async book(a: { startIso: string; name: string }) { this.log.push(`book:${a.startIso}:${a.name}`); return { ok: true, message: `Booked for ${a.startIso}.` }; }
  async updateStatus(s: ConversationState, r: string) { this.log.push(`status:${s}:${r}`); return `Status set to ${s}.`; }
  async handoff(r: string, u: 'low' | 'high') { this.log.push(`handoff:${u}:${r}`); return 'Handed off.'; }
  async markDoNotContact(r: string) { this.log.push(`dnc:${r}`); return 'Marked.'; }
}
