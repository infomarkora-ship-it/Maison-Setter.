import type { CallStatus, ConversationState } from './types.js';

const TERMINAL: ConversationState[] = ['lost', 'disqualified'];

/** do_not_contact and needs_human are sticky (only an operator action leaves them); booked only moves to lost/handoff/DNC. */
export function canTransition(from: ConversationState, to: ConversationState): boolean {
  if (from === to) return true;
  if (from === 'do_not_contact') return false;
  if (from === 'needs_human') return to === 'do_not_contact';
  // A booked lead must not be knocked back to scheduling/qualifying by a late status update.
  if (from === 'booked') return to === 'lost' || to === 'needs_human' || to === 'do_not_contact';
  if (TERMINAL.includes(from)) return to === 'qualifying' || to === 'needs_human' || to === 'do_not_contact';
  return true;
}

/** States the model itself may set via the update_lead_status tool. */
export const MODEL_SETTABLE: ConversationState[] = ['qualifying', 'qualified', 'objection', 'scheduling', 'lost', 'disqualified'];

export const CALL_STATUSES: CallStatus[] = [
  'no_booking_link_sent', 'booking_link_sent', 'call_booked', 'call_rescheduled', 'call_canceled', 'call_completed', 'call_no_show',
];
export const isCallStatus = (v: unknown): v is CallStatus => typeof v === 'string' && (CALL_STATUSES as string[]).includes(v);

/** A call that is on the calendar (or already happened): "please book a call" nudges are stale. */
export const CALL_CONFIRMED: CallStatus[] = ['call_booked', 'call_rescheduled', 'call_completed'];

/**
 * Call lifecycle rules. A late "link sent" signal must not undo a booking, and a completed call
 * stays completed. `force` (dashboard/manual updates) bypasses everything except "same status".
 */
export function canCallTransition(from: CallStatus, to: CallStatus, force = false): boolean {
  if (from === to) return true;
  if (force) return true;
  switch (to) {
    case 'no_booking_link_sent': return false;
    case 'booking_link_sent': return from === 'no_booking_link_sent' || from === 'call_canceled' || from === 'call_no_show';
    case 'call_booked': return true;   // a new call after a finished one is fine
    case 'call_rescheduled': return from === 'call_booked' || from === 'call_rescheduled' || from === 'booking_link_sent' || from === 'no_booking_link_sent';
    case 'call_canceled': return from !== 'call_completed' && from !== 'call_no_show';
    case 'call_no_show': return from === 'call_booked' || from === 'call_rescheduled';
    case 'call_completed': return from === 'call_booked' || from === 'call_rescheduled' || from === 'call_no_show';
  }
}
