import type { Client, ConversationState, ToolHost } from './types.js';
import * as repo from './repo.js';
import { applyCallStatus, calendarFor, type CalendarProvider } from './booking.js';
import { chunkKnowledge, searchChunks } from './knowledge.js';
import { canTransition } from './state.js';
import { alertOperator, notifyClient } from './notify.js';

/** Database-backed tools for one live conversation. */
export class DbToolHost implements ToolHost {
  private calendar: CalendarProvider;
  private chunks: string[];
  constructor(private client: Client, private conv: repo.Conversation, private contact: repo.Contact, calendar?: CalendarProvider) {
    this.calendar = calendar ?? calendarFor(client);
    this.chunks = chunkKnowledge(client.knowledge);
  }

  async searchKnowledge(query: string) { return searchChunks(this.chunks, query).join('\n---\n'); }

  async checkAvailability(fromIso: string, toIso: string) { return this.calendar.listSlots(fromIso, toIso); }

  async book(a: { startIso: string; name: string; email?: string; phone?: string; notes?: string }) {
    const r = await this.calendar.book({ ...a, timezone: this.client.timezone });
    if (!r.ok) return { ok: false, message: r.error ?? 'Booking failed. Offer another time or hand off.' };
    // The call monitor records the appointment, sets state 'booked', and cancels stale "please book" follow-ups.
    const res = await applyCallStatus(this.conv, this.client, 'call_booked', { source: 'booking_tool', startsAt: new Date(a.startIso), name: a.name, email: a.email, externalId: r.externalId });
    if (!res.changed) {
      // Already marked booked (e.g. a second call being booked): still record this appointment.
      await repo.insertAppointment({ clientId: this.client.id, conversationId: this.conv.id, startsAt: new Date(a.startIso), name: a.name, email: a.email, externalId: r.externalId });
      await repo.setState(this.conv.id, 'booked');
      this.conv.state = 'booked';
    }
    await notifyClient(this.client, `New booking: ${a.name} (@${this.contact.username ?? this.contact.platformUserId}) at ${a.startIso}`);
    return { ok: true, message: `Booked for ${a.startIso}. Confirm the time to the person.` };
  }

  async updateStatus(status: ConversationState, reason: string) {
    // Re-read from the DB: book()/handoff() may have changed the state earlier in this same turn.
    const current = (await repo.getConversation(this.conv.id))?.state ?? this.conv.state;
    if (!canTransition(current, status)) return `Status not changed (current state ${current} is locked).`;
    await repo.setState(this.conv.id, status);
    await repo.setNotes(this.conv.id, reason);
    this.conv.state = status;
    // They said no / are not a fit: nothing left to chase.
    if (status === 'lost' || status === 'disqualified') { await repo.cancelPendingFollowups(this.conv.id, `status_${status}`); await repo.clearPlan(this.conv.id, null); }
    return `Status set to ${status}.`;
  }

  async handoff(reason: string, urgency: 'low' | 'high') {
    await repo.setState(this.conv.id, 'needs_human');
    this.conv.state = 'needs_human';
    await repo.cancelPendingFollowups(this.conv.id, 'handoff');
    await repo.clearPlan(this.conv.id, null);
    await notifyClient(this.client, `${urgency === 'high' ? 'URGENT: ' : ''}Needs a human: @${this.contact.username ?? this.contact.platformUserId}. Reason: ${reason}`);
    if (urgency === 'high') await alertOperator(`${this.client.name}: urgent handoff (${reason})`);
    return 'Handed off. A person from the business will take over.';
  }

  async markDoNotContact(reason: string) {
    await repo.markContactDnc(this.contact.id);
    await repo.setState(this.conv.id, 'do_not_contact');
    await repo.cancelPendingSends(this.conv.id);
    await repo.cancelPendingFollowups(this.conv.id, 'do_not_contact');
    await repo.clearPlan(this.conv.id, null);
    this.conv.state = 'do_not_contact';
    await repo.addSignal(this.client.id, 'optout', this.contact.id);
    console.log(`[dnc] ${this.client.name} ${this.contact.platformUserId}: ${reason}`);
    return 'Marked do-not-contact. Do not send any message.';
  }
}
