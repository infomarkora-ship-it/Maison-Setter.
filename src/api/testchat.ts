import type { Llm } from '../ai/llm.js';
import { runTurn } from '../ai/converse.js';
import { chunkKnowledge, searchChunks } from '../knowledge.js';
import { aiErrorMessage } from './friendly.js';
import type { Client, ConversationState, ToolHost, Turn } from '../types.js';

// =====================================================================================
// Test chat (AI Studio): talk to the bot as a pretend lead. This runs the EXACT same
// prompt, guard and reply loop as production (so it talks exactly the same), but with a
// sandbox tool host: nothing touches the database, nothing is sent, no booking is made.
// =====================================================================================

export class SandboxHost implements ToolHost {
  public events: Array<{ tool: string; detail: string }> = [];
  private chunks: string[];
  constructor(private client: Client) { this.chunks = chunkKnowledge(client.knowledge); }

  async searchKnowledge(query: string) { return searchChunks(this.chunks, query).join('\n---\n') || '(nothing in the facts file matches)'; }

  async checkAvailability() {
    const slots: string[] = [];
    const d = new Date();
    for (let i = 1; i <= 3; i++) { const t = new Date(d.getTime() + i * 86_400_000); t.setHours(10 + i, 0, 0, 0); slots.push(t.toISOString()); }
    return slots;   // pretend free slots; the tool host formats the "sandbox" framing below via book()'s message
  }

  async book(a: { startIso: string; name: string }) {
    this.events.push({ tool: 'book', detail: `would book ${a.name} at ${a.startIso}` });
    return { ok: true, message: `SANDBOOK: pretend booking confirmed for ${a.startIso} (nothing was really booked). Say the confirmation to the lead as you normally would.` };
  }

  async updateStatus(status: ConversationState) {
    this.events.push({ tool: 'update_lead_status', detail: status });
    return `Sandbox: lead status would move to "${status}". Nothing was saved.`;
  }

  async handoff(reason: string, urgency: 'low' | 'high') {
    this.events.push({ tool: 'handoff_to_human', detail: `${reason} (${urgency})` });
    return `Sandbox: this thread would be handed to a human (${reason}, ${urgency} urgency). Nothing was saved.`;
  }

  async markDoNotContact(reason: string) {
    this.events.push({ tool: 'mark_do_not_contact', detail: reason });
    return `Sandbox: this person would be marked do-not-contact (${reason}). Nothing was saved.`;
  }
}

export interface TestChatResult {
  reply: string | null;
  toolsUsed: string[];
  handedOff: boolean;
  sandboxEvents: Array<{ tool: string; detail: string }>;
  error?: string;
}

export async function testChatTurn(llm: Llm | null, client: Client, history: Turn[], leadMessage: string): Promise<TestChatResult> {
  const host = new SandboxHost(client);
  const historyWithMessage: Turn[] = [...history, { direction: 'in', body: leadMessage.slice(0, 1000), createdAt: new Date() }];
  if (!llm) {
    return { reply: 'No AI model is configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY), so the test chat cannot reply.', toolsUsed: [], handedOff: false, sandboxEvents: [] };
  }
  const nowLocal = new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeStyle: 'short', timeZone: client.timezone }).format(new Date());
  try {
    const r = await runTurn({
      llm, client, history: historyWithMessage, host,
      context: { nowLocal, source: 'inbound_dm', state: 'qualifying' },
    });
    return { reply: r.text, toolsUsed: r.toolsUsed, handedOff: r.handedOff, sandboxEvents: host.events };
  } catch (e) {
    const friendly = aiErrorMessage(e);
    return { reply: null, toolsUsed: [], handedOff: false, sandboxEvents: host.events, error: friendly.message };
  }
}
