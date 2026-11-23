import test from 'node:test';
import assert from 'node:assert/strict';
import { commentStillReplyable, evaluateBrakes, isWithinWindow, openerGapMs, pickNext, rampCap, replyDelayMs, withinDmWindow, type Candidate, type SendState } from '../src/pacing.js';

const now = new Date('2026-11-10T15:00:00Z'); // 10:00 in Toronto (EST)
const base = (o: Partial<SendState> = {}): SendState => ({
  now, braked: false, openerWindowOpen: true, openersSentToday: 0, openerCapToday: 15,
  nextOpenerAt: new Date('2026-11-10T14:00:00Z'), sentLastHour: 0, hourlyCap: 600, ...o,
});
const cand = (id: number, kind: Candidate['kind'], priority = 0, minsAgo = 1): Candidate =>
  ({ id, kind, priority, scheduledFor: new Date(now.getTime() - minsAgo * 60_000) });

test('rampCap ramps 15 -> 30 -> 50 -> client max and never exceeds the client max', () => {
  assert.equal(rampCap(0, 80), 15);
  assert.equal(rampCap(6, 80), 15);
  assert.equal(rampCap(7, 80), 30);
  assert.equal(rampCap(14, 80), 50);
  assert.equal(rampCap(21, 80), 80);
  assert.equal(rampCap(0, 10), 10);
});

test('isWithinWindow uses the client timezone', () => {
  assert.equal(isWithinWindow(now, 'America/Toronto', 9, 20), true);
  assert.equal(isWithinWindow(new Date('2026-11-10T03:00:00Z'), 'America/Toronto', 9, 20), false); // 22:00 local
  assert.equal(isWithinWindow(new Date('2026-11-10T03:00:00Z'), 'Asia/Tokyo', 9, 20), true);       // 12:00 local
});

test('DM window and comment reply window', () => {
  assert.equal(withinDmWindow(new Date(now.getTime() - 23 * 3_600_000), now), true);
  assert.equal(withinDmWindow(new Date(now.getTime() - 25 * 3_600_000), now), false);
  assert.equal(withinDmWindow(null, now), false);
  assert.equal(commentStillReplyable(new Date(now.getTime() - 5 * 86_400_000), now), true);
  assert.equal(commentStillReplyable(new Date(now.getTime() - 6.8 * 86_400_000), now), false); // inside the 12h safety margin
});

test('delays stay in sensible bounds', () => {
  assert.equal(openerGapMs(() => 0), 2 * 60_000);
  assert.equal(openerGapMs(() => 1), 10 * 60_000);
  assert.ok(replyDelayMs('hi', () => 0.5) >= 10_000);
  assert.ok(replyDelayMs('x'.repeat(5000), () => 1) <= 120_000);
});

test('replies always beat openers, even higher-priority ones', () => {
  const pick = pickNext([cand(1, 'opener', 99), cand(2, 'reply', 1), cand(3, 'followup', 50)], base());
  assert.equal(pick?.id, 2);
});

test('among openers the highest priority goes first', () => {
  assert.equal(pickNext([cand(1, 'opener', 40), cand(2, 'opener', 90), cand(3, 'opener', 60)], base())?.id, 2);
});

test('brake blocks openers but never inbound replies', () => {
  const s = base({ braked: true });
  assert.equal(pickNext([cand(1, 'opener', 99)], s), null);
  assert.equal(pickNext([cand(1, 'opener', 99), cand(2, 'reply')], s)?.id, 2);
});

test('opener gates: daily cap, window, spacing', () => {
  assert.equal(pickNext([cand(1, 'opener')], base({ openersSentToday: 15 })), null);
  assert.equal(pickNext([cand(1, 'opener')], base({ openerWindowOpen: false })), null);
  assert.equal(pickNext([cand(1, 'opener')], base({ nextOpenerAt: new Date(now.getTime() + 60_000) })), null);
  assert.equal(pickNext([cand(1, 'opener')], base())?.id, 1);
});

test('hourly cap stops everything; future items are not due', () => {
  assert.equal(pickNext([cand(1, 'reply')], base({ sentLastHour: 600 })), null);
  assert.equal(pickNext([{ id: 1, kind: 'reply', priority: 0, scheduledFor: new Date(now.getTime() + 60_000) }], base()), null);
});

test('brakes: healthy, low reply rate, errors, negative signals, small samples ignored', () => {
  const ok = { openersSent: 40, openersReplied: 14, recentAttempts: 20, recentErrors: 1, negativeSignals24h: 0 };
  assert.equal(evaluateBrakes(ok).brake, false);
  assert.match(evaluateBrakes({ ...ok, openersReplied: 2 }).reason ?? '', /low_reply_rate/);
  assert.match(evaluateBrakes({ ...ok, recentErrors: 6 }).reason ?? '', /send_errors/);
  assert.equal(evaluateBrakes({ ...ok, negativeSignals24h: 2 }).hours, 48);
  assert.equal(evaluateBrakes({ ...ok, openersSent: 10, openersReplied: 0 }).brake, false); // too few to judge
});
