import * as repo from './repo.js';
import { enqueue } from './jobs.js';
import { canCallTransition, isCallStatus, CALL_CONFIRMED } from './state.js';
import type { CallStatus, Client, ConversationGoal } from './types.js';
export interface CalendarProvider {
  listSlots(fromIso: string, toIso: string): Promise<string[]>;
  book(a: { startIso: string; name: string; email?: string; phone?: string; notes?: string; timezone: string }): Promise<{ ok: boolean; externalId?: string; error?: string }>;
}

/** Spread slots across days and cap the list so the model offers 2-3 sensible options. */
export function spreadSlots(slots: string[], max = 8): string[] {
  const byDay = new Map<string, string[]>();
  for (const s of [...slots].sort()) {
    const d = s.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const out: string[] = [];
  let round = 0;
  while (out.length < max && [...byDay.values()].some((v) => v.length > round)) {
    for (const v of byDay.values()) {
      const s = v[Math.min(round * 2, v.length - 1)];
      if (v.length > round && s && !out.includes(s) && out.length < max) out.push(s);
    }
    round++;
  }
  return out.sort();
}

/** Link mode: no slot logic; the AI sends the client's booking link instead. */
export class LinkCalendar implements CalendarProvider {
  async listSlots() { return []; }
  async book() { return { ok: false, error: 'Booking is link-only for this business. Send the booking link.' }; }
}

/** In-memory calendar for tests and local simulation. */
export class MockCalendar implements CalendarProvider {
  booked: string[] = [];
  constructor(private slots: string[] = []) {}
  async listSlots() { return this.slots.filter((s) => !this.booked.includes(s)); }
  async book(a: { startIso: string }) {
    if (!this.slots.includes(a.startIso) || this.booked.includes(a.startIso)) return { ok: false, error: 'That time is no longer available.' };
    this.booked.push(a.startIso);
    return { ok: true, externalId: `mock-${this.booked.length}` };
  }
}

/**
 * Cal.com adapter. Endpoint paths, version headers and body shapes below are from memory
 * and UNVERIFIED. Check https://cal.com/docs/api-reference/v2 and adjust before use.
 * calendarConfig: { apiKey, eventTypeId, baseUrl? }
 */
export class CalComCalendar implements CalendarProvider {
  constructor(private cfg: { apiKey: string; eventTypeId: number; baseUrl?: string }) {}
  private get base() { return this.cfg.baseUrl ?? 'https://api.cal.com'; }

  async listSlots(fromIso: string, toIso: string) {
    const url = `${this.base}/v2/slots?eventTypeId=${this.cfg.eventTypeId}&start=${encodeURIComponent(fromIso)}&end=${encodeURIComponent(toIso)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'cal-api-version': '2024-09-04' } });
    if (!res.ok) throw new Error(`Cal.com slots ${res.status}`);
    const json = (await res.json()) as { data?: Record<string, Array<{ start: string }>> };
    return spreadSlots(Object.values(json.data ?? {}).flat().map((s) => s.start));
  }

  async book(a: { startIso: string; name: string; email?: string; phone?: string; timezone: string }) {
    if (!a.email) return { ok: false, error: 'An email address is required to book. Ask the person for it.' };
    const res = await fetch(`${this.base}/v2/bookings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, 'cal-api-version': '2024-08-13', 'content-type': 'application/json' },
      body: JSON.stringify({ start: a.startIso, eventTypeId: this.cfg.eventTypeId, attendee: { name: a.name, email: a.email, timeZone: a.timezone } }),
    });
    if (!res.ok) return { ok: false, error: `Booking failed (${res.status}). That time may have been taken.` };
    const json = (await res.json()) as { data?: { uid?: string; id?: number } };
    return { ok: true, externalId: String(json.data?.uid ?? json.data?.id ?? '') };
  }
}

export function calendarFor(c: Client): CalendarProvider {
  if (c.calendarProvider === 'cal_com') {
    const cfg = c.calendarConfig as { apiKey?: string; eventTypeId?: number; baseUrl?: string };
    if (!cfg.apiKey || !cfg.eventTypeId) throw new Error(`Client ${c.name}: cal_com needs calendarConfig.apiKey and eventTypeId`);
    return new CalComCalendar({ apiKey: cfg.apiKey, eventTypeId: cfg.eventTypeId, baseUrl: cfg.baseUrl });
  }
  if (c.calendarProvider === 'mock') return new MockCalendar((c.calendarConfig.slots as string[] | undefined) ?? []);
  return new LinkCalendar();
}

// =====================================================================================
// Call monitor: booking-link detection, calendar/CRM webhook mapping, and call-status effects.
// =====================================================================================

export interface CallEvent {
  status: CallStatus;
  externalId?: string;
  startsAt?: Date;
  email?: string;
  name?: string;
  conversationId?: string;
  instagramUserId?: string;
  username?: string;
  at: Date;
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const TRIGGERS: Array<[RegExp, CallStatus]> = [
  [/no[_\s.-]?show|noshow|missed/, 'call_no_show'],
  [/resched/, 'call_rescheduled'],
  [/cancel/, 'call_canceled'],
  [/ended|complete|finished|showed|held/, 'call_completed'],
  [/creat|book|confirm|scheduled|new/, 'call_booked'],
];

/**
 * Maps a calendar/CRM webhook body to a call event. ASSUMED shapes (verify with a real delivery):
 *  - Cal.com style: { triggerEvent: "BOOKING_CREATED|BOOKING_RESCHEDULED|BOOKING_CANCELLED|MEETING_ENDED|BOOKING_NO_SHOW_UPDATED",
 *      payload: { uid, startTime, attendees: [{ name, email }], metadata: { instagram_user_id, instagram_username, conversation_id } } }
 *  - Generic:      { event|status: "booked|rescheduled|canceled|completed|no_show", external_id, starts_at, email, name,
 *      instagram_user_id, username, conversation_id }
 * Returns null for anything it cannot map to a call status.
 */
export function mapCalendarPayload(raw: unknown): CallEvent | null {
  const root = asObj(raw);
  const p = { ...root, ...asObj(root.payload), ...asObj(root.data) };
  const meta = { ...asObj(root.metadata), ...asObj(p.metadata) };
  const label = (asStr(root.triggerEvent) ?? asStr(root.event) ?? asStr(root.status) ?? asStr(p.status) ?? '').toLowerCase();
  const direct = label.replace(/[\s-]/g, '_');
  const status: CallStatus | undefined = isCallStatus(direct) ? direct : TRIGGERS.find(([re]) => re.test(label))?.[1];
  if (!status) return null;
  const attendee = asObj((Array.isArray(p.attendees) ? p.attendees[0] : undefined) ?? p.attendee);
  const start = asStr(p.startTime) ?? asStr(p.starts_at) ?? asStr(p.start);
  const startsAt = start && !Number.isNaN(Date.parse(start)) ? new Date(start) : undefined;
  return {
    status, startsAt,
    externalId: asStr(p.uid) ?? asStr(p.external_id) ?? asStr(p.booking_id) ?? asStr(p.id),
    email: asStr(attendee.email) ?? asStr(p.email),
    name: asStr(attendee.name) ?? asStr(p.name),
    conversationId: asStr(meta.conversation_id) ?? asStr(p.conversation_id),
    instagramUserId: asStr(meta.instagram_user_id) ?? asStr(meta.ig_user_id) ?? asStr(p.instagram_user_id),
    username: asStr(meta.instagram_username) ?? asStr(meta.ig_username) ?? asStr(p.username),
    at: new Date(),
  };
}

/** Stable dedupe key for a calendar delivery. */
export function calendarEventKey(raw: unknown): string {
  const e = mapCalendarPayload(raw);
  if (e?.externalId) return `cal:${e.externalId}:${e.status}:${e.startsAt?.toISOString() ?? ''}`;
  return `cal:${JSON.stringify(raw ?? null).length}:${Buffer.from(JSON.stringify(raw ?? null)).toString('base64').slice(0, 64)}`;
}

const GOAL_AFTER: Partial<Record<CallStatus, ConversationGoal>> = { call_canceled: 'rebook_canceled', call_no_show: 'recover_no_show' };

export interface CallStatusOptions {
  source: 'booking_tool' | 'calendar_webhook' | 'dashboard' | 'ai_sent_link' | 'system';
  at?: Date; startsAt?: Date; name?: string; email?: string; externalId?: string;
  /** Dashboard/manual updates may jump between any two statuses. */
  force?: boolean;
}

/**
 * Single entry point for every change to a call's lifecycle (booking tool, calendar webhook, dashboard, link sent).
 *  - confirmed (booked / rescheduled / completed): stale "please book" follow-ups are cancelled and the plan cleared.
 *  - canceled / no-show: the thread moves to noshow_recovery (unless a human owns it), stale nudges are cancelled,
 *    and the planner is asked for a recovery follow-up.
 * Returns changed=false for a repeat of the same status (duplicate webhook deliveries are harmless).
 */
export async function applyCallStatus(
  conv: repo.Conversation, client: Client, to: CallStatus, o: CallStatusOptions,
): Promise<{ changed: boolean; blocked?: string }> {
  const at = o.at ?? new Date();
  const from = conv.callStatus ?? 'no_booking_link_sent';
  if (from === to && !(to === 'call_rescheduled' && o.startsAt) && !(to === 'booking_link_sent')) return { changed: false };
  if (!canCallTransition(from, to, o.force)) return { changed: false, blocked: `${from}->${to}` };

  await repo.setCallStatus(conv.id, to);
  conv.callStatus = to;
  await repo.addThreadEvent(client.id, conv.id, to === 'booking_link_sent' ? 'booking_link_sent' : 'call_status_changed', { from, to, source: o.source, startsAt: o.startsAt?.toISOString() }, at);

  switch (to) {
    case 'booking_link_sent':
      await repo.markBookingLinkSent(conv.id, at);
      conv.bookingLinkSentAt = at;
      break;

    case 'call_booked':
    case 'call_rescheduled': {
      const known = o.externalId ? await repo.findAppointmentByExternalId(client.id, o.externalId) : null;
      const appt = known ?? (await repo.latestAppointment(conv.id));
      if (o.startsAt) {
        if (appt && to === 'call_rescheduled') await repo.rescheduleAppointment(appt.id, o.startsAt);
        else if (!appt || (appt.startsAt && new Date(appt.startsAt).getTime() !== o.startsAt.getTime() && !known)) {
          await repo.insertAppointment({ clientId: client.id, conversationId: conv.id, startsAt: o.startsAt, name: o.name, email: o.email, externalId: o.externalId });
        }
      }
      await repo.setState(conv.id, 'booked');
      conv.state = 'booked';
      await repo.cancelPendingFollowups(conv.id, 'call_confirmed');
      await repo.clearPlan(conv.id, null);
      // A rebooked recovery thread goes back to the client's normal mode.
      if (conv.mode === 'noshow_recovery') { await repo.setMode(conv.id, null); conv.mode = null; await repo.addThreadEvent(client.id, conv.id, 'mode_changed', { to: 'default', source: 'rebooked' }); }
      break;
    }

    case 'call_completed': {
      const appt = await repo.latestAppointment(conv.id);
      if (appt) await repo.setAppointmentStatus(appt.id, 'showed');
      await repo.cancelPendingFollowups(conv.id, 'call_completed');
      await repo.clearPlan(conv.id, null);
      break;
    }

    case 'call_canceled':
    case 'call_no_show': {
      const appt = await repo.latestAppointment(conv.id);
      if (appt) await repo.setAppointmentStatus(appt.id, to === 'call_no_show' ? 'no_show' : 'cancelled');
      // The state machine keeps booked sticky against the model; a real cancellation is a system fact, so set it directly.
      if (conv.state === 'booked') { await repo.setState(conv.id, 'scheduling'); conv.state = 'scheduling'; }
      await repo.cancelPendingFollowups(conv.id, 'call_not_happening');
      await repo.clearPlan(conv.id, GOAL_AFTER[to] ?? null);
      if (conv.mode !== 'paused_human' && !conv.humanTakeover) {
        await repo.setMode(conv.id, 'noshow_recovery'); conv.mode = 'noshow_recovery';
        await repo.addThreadEvent(client.id, conv.id, 'mode_changed', { to: 'noshow_recovery', source: 'auto', reason: to });
        await enqueue('plan_followup', { conversationId: conv.id }, { clientId: client.id, dedupeKey: `plan:${conv.id}` });
      }
      break;
    }
    default: break;
  }
  return { changed: true };
}

/** Process one stored calendar/CRM webhook: find the conversation it belongs to and apply the status. */
export async function processCalendarEvent(rawEventId: number): Promise<void> {
  const raw = await repo.getRawEvent(rawEventId);
  if (!raw) return;
  const client = await repo.getClient(raw.clientId);
  if (!client) { await repo.markRawProcessed(rawEventId, 'client_missing'); return; }
  const ev = mapCalendarPayload(raw.payload);
  if (!ev) { await repo.markRawProcessed(rawEventId, 'unmapped_calendar_payload'); return; }

  let conv: repo.Conversation | null = null;
  if (ev.conversationId && /^[0-9a-f-]{36}$/i.test(ev.conversationId)) {
    const c = await repo.getConversation(ev.conversationId);
    if (c && c.clientId === client.id) conv = c;
  }
  if (!conv && ev.instagramUserId) { const ct = await repo.findContact(client.id, ev.instagramUserId); if (ct) conv = await repo.findConversationByContact(client.id, ct.id); }
  if (!conv && ev.username) { const ct = await repo.findContactByUsername(client.id, ev.username); if (ct) conv = await repo.findConversationByContact(client.id, ct.id); }
  if (!conv && ev.externalId) { const a = await repo.findAppointmentByExternalId(client.id, ev.externalId); if (a) conv = await repo.getConversation(a.conversationId); }
  if (!conv && ev.email) conv = await repo.findConversationByEmail(client.id, ev.email);
  if (!conv) { await repo.markRawProcessed(rawEventId, 'conversation_not_found'); return; }

  await applyCallStatus(conv, client, ev.status, { source: 'calendar_webhook', at: ev.at, startsAt: ev.startsAt, name: ev.name, email: ev.email, externalId: ev.externalId });
  await repo.markRawProcessed(rawEventId);
}

/** Record that an outgoing message carried the booking link (idempotent per message; keeps the latest time). */
export async function recordBookingLinkSent(conv: repo.Conversation, client: Client, at: Date) {
  if ((CALL_CONFIRMED as string[]).includes(conv.callStatus)) {
    // Link re-sent after the call was already confirmed: log it, but do not touch the call status.
    await repo.addThreadEvent(client.id, conv.id, 'booking_link_resent', {}, at);
    return;
  }
  await applyCallStatus(conv, client, 'booking_link_sent', { source: 'ai_sent_link', at });
}
