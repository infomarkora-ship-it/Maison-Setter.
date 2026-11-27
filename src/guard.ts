import { config } from './config.js';
import { MODE_PROFILES } from './modes.js';
import { isWithinWindow, withinDmWindow } from './pacing.js';
import { CALL_CONFIRMED } from './state.js';
import type { CallStatus, Client, ConversationGoal, ConversationState, OperatingMode } from './types.js';

export interface GuardResult { ok: boolean; reasons: string[]; cleaned: string }

const MAX_REPLY_CHARS = 700;
const AI_BOILERPLATE = /(as an ai( language model)?|i('|’)m (just |only )an? (ai|language model|chatbot)|large language model)/i;
const URL_RE = /(https?:\/\/[^\s)]+|www\.[^\s)]+)/gi;
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d+)?/g;

const norm = (s: string) => s.replace(/[,\s$]/g, '');

/** Last line of defence before anything is sent to a real person. */
export function guardReply(raw: string, client: Pick<Client, 'settings' | 'knowledge'>): GuardResult {
  const reasons: string[] = [];
  let text = raw.trim()
    .replace(/^[-*•]\s+/gm, '')        // no bullet lists in DMs
    .replace(/\s*[—–]\s*/g, ', ')      // no em/en dashes: a comma reads like a human, a dash reads like a bot
    .replace(/,\s*,/g, ',')            // fix any double comma the dash swap left behind
    .replace(/\*\*(.*?)\*\*/g, '$1')    // no markdown bold
    .replace(/\n{3,}/g, '\n\n');

  if (!text) reasons.push('empty');
  if (text.length > MAX_REPLY_CHARS) reasons.push('too_long');
  if (AI_BOILERPLATE.test(text)) reasons.push('ai_boilerplate');

  // Only the client's own booking link may appear.
  const allowed = client.settings.bookingLink?.toLowerCase();
  for (const u of text.match(URL_RE) ?? []) {
    if (!allowed || !u.toLowerCase().startsWith(allowed.replace(/\/$/, ''))) { reasons.push('unapproved_link'); break; }
  }

  // Every $ amount must already appear in the client's own facts. No invented prices.
  const facts = norm(`${client.knowledge} ${client.settings.offer} ${client.settings.businessSummary}`);
  for (const p of text.match(PRICE_RE) ?? []) {
    if (!facts.includes(norm(p))) { reasons.push(`unknown_price:${p}`); break; }
  }

  const lower = text.toLowerCase();
  for (const f of client.settings.forbiddenClaims) {
    if (f && lower.includes(f.toLowerCase())) { reasons.push(`forbidden_claim:${f}`); break; }
  }
  return { ok: reasons.length === 0, reasons, cleaned: text };
}

/** Hard-coded opt-out detection. Never leave this to the model. */
const OPT_OUT = /^\s*(stop|unsubscribe|opt ?out|leave me alone|don'?t (message|dm|contact) me|remove me|no more messages)\b/i;
export const isOptOut = (text: string) => OPT_OUT.test(text);

// =====================================================================================
// Hard safety guards for automation. Pure functions: no DB, no network.
// =====================================================================================

export interface ThreadFlags {
  state: ConversationState;
  humanTakeover: boolean;
  pausedUntil: Date | null;
  mode: OperatingMode;
}

/**
 * Human takeover with a cooldown: paused while paused_until is in the future, or indefinitely when a
 * takeover was set manually (human_takeover with no paused_until). paused_human mode is always paused.
 */
export function isHumanPaused(t: Pick<ThreadFlags, 'humanTakeover' | 'pausedUntil' | 'mode'>, now: Date): boolean {
  if (t.mode === 'paused_human') return true;
  if (!t.humanTakeover) return false;
  return !t.pausedUntil || new Date(t.pausedUntil).getTime() > now.getTime();
}

/** May the AI act on this thread at all? The first false wins; `reason` is logged and shown in the dashboard. */
export function aiMayAct(t: ThreadFlags & { contactDnc: boolean }, now: Date): { ok: boolean; reason?: string } {
  if (t.contactDnc || t.state === 'do_not_contact') return { ok: false, reason: 'do_not_contact' };
  if (t.state === 'needs_human') return { ok: false, reason: 'needs_human' };
  if (isHumanPaused(t, now)) return { ok: false, reason: t.mode === 'paused_human' ? 'mode_paused_human' : 'human_takeover' };
  return { ok: true };
}

/** Automated messages are only allowed inside Meta's 24h window (minus a small safety margin). */
export function automatedSendAllowed(lastInboundAt: Date | null, now: Date): { ok: boolean; reason?: string } {
  if (!lastInboundAt) return { ok: false, reason: 'no_inbound_message_yet' };
  return withinDmWindow(lastInboundAt, now, config.dmWindowHours, config.dmWindowSafetyMinutes) ? { ok: true } : { ok: false, reason: 'outside_messaging_window' };
}

/** The latest moment a nudge may go out: window end minus the safety margin and a little send slack. */
export function nudgeDeadline(lastInboundAt: Date, slackMinutes = 20): Date {
  return new Date(lastInboundAt.getTime() + config.dmWindowHours * 3_600_000 - (config.dmWindowSafetyMinutes + slackMinutes) * 60_000);
}

/** Did this outgoing text contain the client's booking link? */
export function containsBookingLink(text: string, client: Pick<Client, 'settings'>): boolean {
  const link = client.settings.bookingLink?.trim().toLowerCase().replace(/\/$/, '');
  return !!link && text.toLowerCase().includes(link);
}

export interface FollowUpPlanInput { shouldFollowUp: boolean; delayMinutes: number; goal: ConversationGoal }
export interface FollowUpContext {
  now: Date;
  mode: OperatingMode;
  state: ConversationState;
  callStatus: CallStatus;
  humanPaused: boolean;
  contactDnc: boolean;
  followupsSent: number;
  lastInboundAt: Date | null;
  timezone: string;
  windowStart: number;       // local hours the client allows automated outreach
  windowEnd: number;
}
export type FollowUpDecision = { ok: true; at: Date; delayMinutes: number } | { ok: false; reason: string };

const STEP_MS = 15 * 60_000;

/**
 * Takes the model's FREE-FORM plan (when / why) and clamps it to hard limits:
 * opt-outs, human pauses, terminal states, booked calls, per-mode delay bounds and follow-up caps,
 * the client's outreach hours, and the 24h messaging window. The model can choose; it cannot override these.
 */
/** Reasons a follow-up can never go out, regardless of what the planner wants. null = allowed. */
export function followUpHardBlock(c: Omit<FollowUpContext, 'now' | 'timezone' | 'windowStart' | 'windowEnd'>): string | null {
  if (c.contactDnc || c.state === 'do_not_contact') return 'do_not_contact';
  if (c.humanPaused) return 'human_paused';
  if (c.state === 'needs_human') return 'needs_human';
  if (c.state === 'lost' || c.state === 'disqualified') return `state_${c.state}`;
  if ((CALL_CONFIRMED as string[]).includes(c.callStatus)) return 'call_already_confirmed';
  const p = MODE_PROFILES[c.mode].followUp;
  if (!MODE_PROFILES[c.mode].aiActive || p.maxUnanswered === 0) return 'mode_inactive';
  if (c.followupsSent >= p.maxUnanswered) return 'follow_up_cap_reached';
  if (!c.lastInboundAt) return 'no_inbound_message_yet';
  return null;
}

/** First allowed outreach time at or after `from`, or null if it would fall after `deadline`. */
export function nextOpenTime(from: Date, tz: string, startHour: number, endHour: number, deadline: Date): Date | null {
  let t = from.getTime();
  for (let i = 0; i < 192 && !isWithinWindow(new Date(t), tz, startHour, endHour); i++) t += STEP_MS;
  return t <= deadline.getTime() ? new Date(t) : null;
}

export function guardFollowUp(plan: FollowUpPlanInput, c: FollowUpContext): FollowUpDecision {
  const blocked = followUpHardBlock(c);
  if (blocked) return { ok: false, reason: blocked };
  if (!plan.shouldFollowUp) return { ok: false, reason: 'planner_chose_no_follow_up' };
  const p = MODE_PROFILES[c.mode].followUp;
  if (!c.lastInboundAt) return { ok: false, reason: 'no_inbound_message_yet' };

  const deadline = nudgeDeadline(c.lastInboundAt);
  const delayMin = Math.min(p.maxDelayMin, Math.max(p.minDelayMin, Math.round(plan.delayMinutes)));
  const earliest = c.now.getTime() + p.minDelayMin * 60_000;
  const open = (t: number) => isWithinWindow(new Date(t), c.timezone, c.windowStart, c.windowEnd);

  // Preferred time: the model's delay, pushed forward to the next allowed hour.
  let t = c.now.getTime() + delayMin * 60_000;
  for (let i = 0; i < 192 && !open(t); i++) t += STEP_MS;
  if (t <= deadline.getTime()) return { ok: true, at: new Date(t), delayMinutes: Math.round((t - c.now.getTime()) / 60_000) };

  // Too late for the window: pull the nudge earlier, to the latest allowed hour that is still in the window.
  t = deadline.getTime();
  while (t >= earliest && !open(t)) t -= STEP_MS;
  if (t >= earliest && open(t)) return { ok: true, at: new Date(t), delayMinutes: Math.round((t - c.now.getTime()) / 60_000) };
  return { ok: false, reason: 'no_slot_inside_messaging_window' };
}
