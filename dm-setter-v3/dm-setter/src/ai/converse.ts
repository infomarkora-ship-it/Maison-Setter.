import type { Llm, Msg, ToolResultBlock } from './llm.js';
import { z } from 'zod';
import type { CallStatus, Client, ConversationGoal, ConversationState, OperatingMode, Source, ToolHost, Turn } from '../types.js';
import { buildSystemPrompt, contextBlock, FOLLOWUP_INSTRUCTION, plannerSystemPrompt } from './prompts.js';
import { forced } from './classify.js';
import { CONVERSATION_GOALS } from '../modes.js';
import { PLACEHOLDER_RE } from '../platform/instantdm.js';
import { executeTool, toolDefs } from './tools.js';
import { INLINE_KB_LIMIT_CHARS } from '../knowledge.js';
import { guardReply } from '../guard.js';

export interface TurnInput {
  llm: Llm;
  client: Client;
  history: Turn[];
  host: ToolHost;
  context: { nowLocal: string; source: Source; state: ConversationState; notes?: string | null; callStatus?: CallStatus; goal?: ConversationGoal | null };
  mode?: 'reply' | 'followup';
  followupNumber?: number;
  /** Operating mode of the thread (qualify_and_book, soft_nurture, ...). Not the same thing as `mode` above. */
  opMode?: OperatingMode;
  /** Follow-up turns: what this touch is for and the planner's suggested angle. */
  goal?: ConversationGoal | null;
  angle?: string | null;
  /** The unanswered inbound messages are only voice notes / images / shares: never hand off, fall back instead. */
  attachmentOnly?: boolean;
  maxIters?: number;
}

export interface TurnResult {
  text: string | null;      // message to send, or null = send nothing
  handedOff: boolean;
  dnc: boolean;
  toolsUsed: string[];
  guardFailed?: string[];
  usedFallback?: boolean;
}

/** True when every message in the trailing inbound burst is just an attachment placeholder (no words at all). */
export function isAttachmentOnly(history: Turn[]): boolean {
  const burst: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i] as Turn;
    if (h.direction !== 'in') break;
    burst.push(h.body);
  }
  if (!burst.length) return false;
  return burst.every((b) => b.split(/\s+(?=\[)/).every((part) => PLACEHOLDER_RE.test(part.trim())));
}

const FALLBACKS: Record<string, string[]> = {
  audio: ["I can't play voice notes here, so could you type the gist for me?", "Voice notes don't come through for me on this chat. Mind typing it out?"],
  image: ['Thanks for sending that! I can\'t open images in this chat, can you tell me a bit about what it shows?', "I can't view pictures here. What did you want me to see?"],
  other: ["Thanks for sending that. I can't open attachments here, so could you tell me in a message what you had in mind?"],
};
/** Natural, deterministic reply for media-only messages when the model is unavailable or its answer was blocked. */
export function attachmentFallback(history: Turn[], rng: () => number = Math.random): string {
  const last = [...history].reverse().find((h) => h.direction === 'in')?.body ?? '';
  const kind = /voice note/.test(last) ? 'audio' : /\[image\]/.test(last) ? 'image' : 'other';
  const list = FALLBACKS[kind] as string[];
  return list[Math.floor(rng() * list.length)] as string;
}

/** Stored history -> alternating user/assistant messages (consecutive same-role turns merge). */
export function historyToMessages(history: Turn[]): Msg[] {
  const out: Msg[] = [];
  for (const t of history) {
    const role = t.direction === 'in' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string') last.content += `\n${t.body}`;
    else out.push({ role, content: t.body });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: "[This conversation started from the person's Instagram comment. You sent the first message.]" });
  return out;
}

export async function runTurn(inp: TurnInput): Promise<TurnResult> {
  const { llm, client, host } = inp;
  const mode = inp.mode ?? 'reply';
  const kbInline = client.knowledge.length <= INLINE_KB_LIMIT_CHARS;
  const messages = historyToMessages(inp.history.slice(-30));
  const ctx = contextBlock(inp.context);

  if (mode === 'followup') {
    messages.push({ role: 'user', content: `${ctx}\n\n${FOLLOWUP_INSTRUCTION(inp.followupNumber ?? 1, inp.goal, inp.angle)}` });
  } else {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || typeof last.content !== 'string') return { text: null, handedOff: false, dnc: false, toolsUsed: [] };
    last.content = `${ctx}\n\n${last.content}`;
  }

  const system = buildSystemPrompt(client, inp.opMode ?? client.defaultMode ?? 'qualify_and_book');
  const tools = mode === 'followup' ? undefined : toolDefs(client, kbInline);
  const toolsUsed: string[] = [];
  let handedOff = false;
  let dnc = false;
  let text: string | null = null;

  for (let i = 0; i < (inp.maxIters ?? 5); i++) {
    let res;
    try {
      res = await llm.complete({ system, messages, tools, maxTokens: 400, kind: mode === 'followup' ? 'followup' : 'converse', clientId: client.id });
    } catch (e) {
      // Media-only message and the model is down: answer naturally instead of failing the job and leaving them on read.
      if (inp.attachmentOnly && mode === 'reply') return { text: attachmentFallback(inp.history), handedOff: false, dnc, toolsUsed, usedFallback: true };
      throw e;
    }
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stopReason === 'tool_use' && uses.length) {
      const results: ToolResultBlock[] = [];
      for (const u of uses) {
        if (u.type !== 'tool_use') continue;
        toolsUsed.push(u.name);
        const out = await executeTool(host, u.name, u.input);
        if (out.handoff) handedOff = true;
        if (out.dnc) dnc = true;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out.content, is_error: out.isError || undefined });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim() || null;
    break;
  }

  if (dnc) return { text: null, handedOff, dnc, toolsUsed };
  if (inp.attachmentOnly && mode === 'reply' && !handedOff) {
    // Voice note / image / shared post with no words: if the model gave nothing usable, fall back rather than escalate.
    const g0 = text === null ? null : guardReply(text, client);
    if (!g0 || !g0.ok) return { text: attachmentFallback(inp.history), handedOff: false, dnc, toolsUsed, usedFallback: true };
  }
  if (text === null) {
    // Empty or looped: never send silence-as-error to a lead, pass it to a human.
    if (!handedOff) await host.handoff('model_returned_no_message', 'low');
    return { text: null, handedOff: true, dnc, toolsUsed };
  }

  const g = guardReply(text, client);
  if (!g.ok) {
    await host.handoff(`guard_blocked_reply: ${g.reasons.join(', ')}`, 'low');
    return { text: null, handedOff: true, dnc, toolsUsed, guardFailed: g.reasons };
  }
  return { text: g.cleaned, handedOff, dnc, toolsUsed };
}


// =====================================================================================
// Follow-up planner: the model decides WHEN, WHY and WHAT; guardFollowUp() enforces the hard limits.
// =====================================================================================
export const FollowUpPlanOut = z.object({
  should_follow_up: z.boolean(),
  recommended_delay_minutes: z.number().min(0).max(10_080),
  goal: z.enum(CONVERSATION_GOALS as [ConversationGoal, ...ConversationGoal[]]),
  rationale: z.string().max(600),
  message_angle: z.string().max(600),
  lead_score: z.number().min(0).max(100),
});
export type FollowUpPlanOut = z.infer<typeof FollowUpPlanOut>;

export interface PlannerSignals {
  nowLocal: string;
  state: ConversationState;
  callStatus: CallStatus;
  currentGoal: ConversationGoal | null;
  leadScore: number | null;
  followupsSent: number;
  minutesSinceLastReply: number | null;
  minutesSinceLastOutbound: number | null;
  minutesSinceBookingLink: number | null;
  minutesSinceCommentDm: number | null;
  source: Source;
  notes?: string | null;
}

const planTool = {
  name: 'submit_plan', description: 'Submit the follow-up plan.',
  input_schema: {
    type: 'object' as const,
    properties: {
      should_follow_up: { type: 'boolean' },
      recommended_delay_minutes: { type: 'number', description: 'Minutes from now until the next touch' },
      goal: { type: 'string', enum: CONVERSATION_GOALS },
      rationale: { type: 'string' }, message_angle: { type: 'string' }, lead_score: { type: 'number' },
    },
    required: ['should_follow_up', 'recommended_delay_minutes', 'goal', 'rationale', 'message_angle', 'lead_score'],
  },
};

const mins = (m: number | null) => (m === null ? 'never' : `${m} minutes ago`);

/** Returns null on any model/parse failure; the caller falls back to the mode's default cadence. */
export function planFollowUp(llm: Llm, client: Client, opMode: OperatingMode, history: Turn[], sig: PlannerSignals) {
  const transcript = history.slice(-20).map((h) => `${h.direction === 'in' ? 'LEAD' : 'US'}: ${h.body.slice(0, 400)}`).join('\n');
  const user = `Signals
- Local time now: ${sig.nowLocal}
- Conversation state: ${sig.state}; call status: ${sig.callStatus}; current goal: ${sig.currentGoal ?? 'none'}
- Lead score so far: ${sig.leadScore ?? 'unscored'}; unanswered follow-ups already sent: ${sig.followupsSent}
- Lead last replied: ${mins(sig.minutesSinceLastReply)}; we last messaged: ${mins(sig.minutesSinceLastOutbound)}
- Booking link sent: ${mins(sig.minutesSinceBookingLink)}; DM'd from a comment: ${mins(sig.minutesSinceCommentDm)}
- How they found us: ${sig.source}${sig.notes ? `\n- Notes: ${sig.notes}` : ''}

Transcript (oldest first)
${transcript}`;
  return forced(llm, 'plan', client, plannerSystemPrompt(client, opMode), user, planTool, FollowUpPlanOut);
}
