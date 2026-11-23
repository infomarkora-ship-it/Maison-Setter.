import test from 'node:test';
import assert from 'node:assert/strict';
import { prefilterComment, priorityScore } from '../src/scoring.js';
import { guardReply, isOptOut } from '../src/guard.js';
import { chunkKnowledge, searchChunks } from '../src/knowledge.js';
import { canTransition } from '../src/state.js';
import { spreadSlots } from '../src/booking.js';
import { mapPayload } from '../src/platform/instantdm.js';
import { makeClient } from './helpers.js';

test('prefilter drops noise before any tokens are spent', () => {
  const f = (t: string, a = 'u1') => prefilterComment(t, a, 'ig-own').skip;
  assert.equal(f('🔥🔥🔥'), true);
  assert.equal(f('@sam @jo'), true);
  assert.equal(f('ok'), true);
  assert.equal(f('check my page for free followers'), true);
  assert.equal(f('visit www.spam.com'), true);
  assert.equal(f('how much is the program?', 'ig-own'), true); // own account
  assert.equal(f('how much is the program?'), false);
});

test('priority: intent dominates, fresh beats stale, result is clamped 0-100', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const fresh = new Date('2026-11-10T11:00:00Z');
  const stale = new Date('2026-11-04T12:00:00Z');
  const hi = priorityScore({ intent: 90, fit: 70, commentedAt: fresh, likeCount: 2, now });
  const lo = priorityScore({ intent: 40, fit: 70, commentedAt: fresh, likeCount: 2, now });
  const old = priorityScore({ intent: 90, fit: 70, commentedAt: stale, likeCount: 2, now });
  assert.ok(hi > lo && hi > old);
  const max = priorityScore({ intent: 500, fit: 500, commentedAt: now, likeCount: 99, now });
  assert.ok(max <= 100 && max >= 0);
});

test('guard: known price ok, invented price blocked', () => {
  const c = makeClient();
  assert.equal(guardReply('The starter program is $400 for four weeks.', c).ok, true);
  const bad = guardReply('It is only $299 this week.', c);
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(), /unknown_price/);
});

test('guard: links, forbidden claims, boilerplate, length, formatting', () => {
  const c = makeClient();
  assert.equal(guardReply('Book here: https://cal.com/test/intro', c).ok, true);
  assert.match(guardReply('Go to https://evil.example/x', c).reasons.join(), /unapproved_link/);
  assert.match(guardReply('We offer guaranteed results!', c).reasons.join(), /forbidden_claim/);
  assert.match(guardReply('As an AI language model, I cannot.', c).reasons.join(), /ai_boilerplate/);
  assert.match(guardReply('x'.repeat(800), c).reasons.join(), /too_long/);
  assert.match(guardReply('', c).reasons.join(), /empty/);
  assert.equal(guardReply('- first\n- second', c).cleaned, 'first\nsecond');
});

test('opt-out detection is hard-coded, not left to the model', () => {
  for (const t of ['stop', 'STOP messaging me', 'unsubscribe', "don't message me again", 'leave me alone']) assert.equal(isOptOut(t), true, t);
  for (const t of ['please stop by the studio tomorrow?', 'what time do you open', 'nonstop energy']) assert.equal(isOptOut(t), false, t);
});

test('knowledge search returns the relevant chunk', () => {
  const kb = 'Pricing: the starter program costs $400.\n\nHours: open Monday to Saturday.\n\nParking: free lot behind the building.';
  const chunks = chunkKnowledge(kb, 60);
  assert.ok(chunks.length >= 2);
  assert.match(searchChunks(chunks, 'how much does the program cost')[0] ?? '', /\$400/);
  assert.deepEqual(searchChunks(chunks, 'zzzz qqqq'), []);
});

test('state machine: DNC and needs_human are sticky', () => {
  assert.equal(canTransition('do_not_contact', 'qualifying'), false);
  assert.equal(canTransition('needs_human', 'qualifying'), false);
  assert.equal(canTransition('needs_human', 'do_not_contact'), true);
  assert.equal(canTransition('lost', 'qualifying'), true);
  assert.equal(canTransition('qualifying', 'booked'), true);
  assert.equal(canTransition('booked', 'scheduling'), false);   // late status update must not undo a booking
  assert.equal(canTransition('booked', 'lost'), true);          // a cancellation can
});

test('spreadSlots spreads across days and caps the list', () => {
  const slots = ['2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z', '2026-11-12T11:00:00Z', '2026-11-13T09:00:00Z', '2026-11-14T09:00:00Z'];
  const out = spreadSlots(slots, 3);
  assert.equal(out.length, 3);
  assert.equal(new Set(out.map((s) => s.slice(0, 10))).size, 3);
});

// These shapes are ASSUMED. Replace with real InstantDM payloads once captured from raw_events.
test('InstantDM mapper handles the assumed shapes and never throws on junk', () => {
  const dm = mapPayload({ type: 'message', sender_id: '42', message_id: 'm1', text: 'how much?' })[0];
  assert.equal(dm?.type, 'dm');
  const cm = mapPayload({ type: 'comment', comment_id: 'c1', from_id: '7', text: 'price?', media_caption: 'cap' })[0];
  assert.equal(cm?.type, 'comment');
  assert.equal(mapPayload({ type: 'message_echo', recipient_id: '42', message_id: 'm2', text: 'hi' })[0]?.type, 'echo');
  assert.equal(mapPayload({ type: 'user_blocked', sender_id: '42' })[0]?.type, 'negative_signal');
  assert.equal(mapPayload({ nonsense: true })[0]?.type, 'ignored');
  assert.equal(mapPayload(null)[0]?.type, 'ignored');
  assert.equal(mapPayload('garbage')[0]?.type, 'ignored');
});
