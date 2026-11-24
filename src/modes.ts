import type { Client, ConversationGoal, OperatingMode } from './types.js';

export const OPERATING_MODES: OperatingMode[] = ['qualify_and_book', 'soft_nurture', 'direct_closer', 'noshow_recovery', 'paused_human'];
export const isOperatingMode = (v: unknown): v is OperatingMode => typeof v === 'string' && (OPERATING_MODES as string[]).includes(v);

export const CONVERSATION_GOALS: ConversationGoal[] = [
  'qualify_fit', 'clarify_objection', 'confirm_preferred_slot', 'get_booking_completed', 'recover_no_show', 'rebook_canceled',
];
export const isConversationGoal = (v: unknown): v is ConversationGoal => typeof v === 'string' && (CONVERSATION_GOALS as string[]).includes(v);

export interface ModeProfile {
  label: string;
  description: string;
  /** Appended to the system prompt. */
  directive: string;
  /** Hard limits the planner's free-form timing is clamped to. */
  followUp: { maxUnanswered: number; minDelayMin: number; maxDelayMin: number; defaultDelayMin: number };
  aiActive: boolean;
}

export const MODE_PROFILES: Record<OperatingMode, ModeProfile> = {
  qualify_and_book: {
    label: 'Qualify and book',
    description: 'Balanced: qualify fit, handle objections, then get a call booked.',
    directive: 'MODE: qualify_and_book. Balance rapport, qualification and booking. Find out fit first, answer objections honestly, and move to the booking step once they are a fit and interested. One question at a time.',
    followUp: { maxUnanswered: 3, minDelayMin: 30, maxDelayMin: 20 * 60, defaultDelayMin: 4 * 60 },
    aiActive: true,
  },
  soft_nurture: {
    label: 'Soft nurture',
    description: 'Low pressure, value first, slower follow-up cadence.',
    directive: 'MODE: soft_nurture. Low pressure. Lead with something genuinely useful or a light question about their situation. Do not push the booking link; mention it only if they ask about next steps or clearly show readiness. Keep replies warm and unhurried.',
    followUp: { maxUnanswered: 3, minDelayMin: 4 * 60, maxDelayMin: 20 * 60, defaultDelayMin: 12 * 60 },
    aiActive: true,
  },
  direct_closer: {
    label: 'Direct closer',
    description: 'Concise and decisive push toward booking for high-intent leads.',
    directive: 'MODE: direct_closer. This lead has high intent. Be concise and decisive: confirm fit in as few exchanges as possible, then propose the booking step plainly and make the next action obvious. No fluff, but still no pressure tactics or fake urgency.',
    followUp: { maxUnanswered: 4, minDelayMin: 20, maxDelayMin: 8 * 60, defaultDelayMin: 90 },
    aiActive: true,
  },
  noshow_recovery: {
    label: 'No-show recovery',
    description: 'Re-engage leads who missed or canceled a call.',
    directive: 'MODE: noshow_recovery. This person missed or canceled a call. Be understanding and never guilt them. Acknowledge it lightly, ask if something came up, and make rebooking easy. If they are no longer interested, accept that gracefully and mark the lead lost.',
    followUp: { maxUnanswered: 3, minDelayMin: 30, maxDelayMin: 12 * 60, defaultDelayMin: 3 * 60 },
    aiActive: true,
  },
  paused_human: {
    label: 'Paused (human handling)',
    description: 'AI is paused; a person handles this thread.',
    directive: 'MODE: paused_human. The AI must not send anything.',
    followUp: { maxUnanswered: 0, minDelayMin: 0, maxDelayMin: 0, defaultDelayMin: 0 },
    aiActive: false,
  },
};

/** Thread mode wins, then the client default, then qualify_and_book. */
export function effectiveMode(conv: { mode?: OperatingMode | null }, client: Pick<Client, 'defaultMode'>): OperatingMode {
  if (conv.mode && isOperatingMode(conv.mode)) return conv.mode;
  return isOperatingMode(client.defaultMode) ? client.defaultMode : 'qualify_and_book';
}

/** The goal to fall back to when the planner model is unavailable. */
export function defaultGoal(callStatus: string, mode: OperatingMode): ConversationGoal {
  if (callStatus === 'call_no_show') return 'recover_no_show';
  if (callStatus === 'call_canceled') return 'rebook_canceled';
  if (callStatus === 'booking_link_sent') return 'get_booking_completed';
  return mode === 'direct_closer' ? 'get_booking_completed' : 'qualify_fit';
}
