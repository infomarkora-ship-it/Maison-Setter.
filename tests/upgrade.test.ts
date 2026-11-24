import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkGapMs, chunkMessage, debounceRunAt, debounceWindowMs, openerGapMs, pickNext, withinDmWindow, type Candidate, type SendState } from '../src/pacing.js';
import { aiMayAct, automatedSendAllowed, containsBookingLink, guardFollowUp, isHumanPaused, nextOpenTime, type FollowUpContext } from '../src/guard.js';
import { commentDmCap, commentDmGate, leadScore } from '../src/scoring.js';
import { canCallTransition } from '../src/state.js';
import { calendarEventKey, mapCalendarPayload } from '../src/booking.js';
import { effectiveMode, MODE_PROFILES } from '../src/modes.js';
import { isAttachmentOnly, attachmentFallback, runTurn } from '../src/ai/converse.js';
import { buildSystemPrompt } from '../src/ai/prompts.js';
import { dmBody, eventKey, mapPayload } from '../src/platform/instantdm.js';
import { authorizeWebhook, computeSignature, verifySignature } from '../src/platform/signature.js';
import { SandboxHost, testChatTurn } from '../src/api/testchat.js';
import { readFileSync } from 'node:fs';
import { dashboardHtml } from '../src/dashboard/page.js';
import type { Turn } from '../src/types.js';
import { FakeHost, FakeLlm, makeClient, text, toolUse } from './helpers.js';

const T = (direction: 'in' | 'out', body: string, at = new Date()): Turn => ({ direction, body, createdAt: at });

// ---------- chunking ----------
test('chunking: short replies stay one bubble, long ones become 2-3, never more', () => {
  assert.deepEqual(chunkMessage('Sure, happy to help!'), ['Sure, happy to help!']);
  const long = 'Love that you want to get stronger. The 4-week starter program is $400 and it runs in small groups. Most people see how it feels on a free intro call first. Want me to send the link so you can grab a time?';
  const c = chunkMessage(long);
  assert.ok(c.length >= 2 && c.length <= 3, String(c.length));
  assert.equal(c.join(' ').replace(/\s+/g, ' '), long);
});

test('chunking: respects blank lines, merges beyond the cap, keeps a URL intact', () => {
  assert.deepEqual(chunkMessage('First thing.\n\nSecond thing.'), ['First thing.', 'Second thing.']);
  assert.equal(chunkMessage('One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.').length, 3);
  const withLink = chunkMessage('Here is the link: https://cal.com/test/intro. Pick any time that works and I will see you there. Any questions before then, just ask me here.');
  assert.ok(withLink.some((b) => b.includes('https://cal.com/test/intro')));
  assert.deepEqual(chunkMessage('   '), []);
});

test('chunk gaps are human-sized and capped', () => {
  const g = chunkGapMs('x'.repeat(100), () => 0.5);
  assert.ok(g >= 1_000 && g <= 6_000);
  assert.equal(chunkGapMs('x'.repeat(5000), () => 1), 6_000);
});

// ---------- debounce ----------
test('debounce: 4-6s window, pushed by each message, capped by max wait', () => {
  assert.ok(debounceWindowMs(() => 0) === 4_000 && debounceWindowMs(() => 1) === 6_000);
  const start = new Date('2026-11-21T12:00:00Z');
  const at3 = new Date(start.getTime() + 3_000);
  assert.equal(debounceRunAt(at3, start, 5_000).getTime(), at3.getTime() + 5_000);       // extended by the newer message
  const at18 = new Date(start.getTime() + 18_000);
  assert.equal(debounceRunAt(at18, start, 5_000, 20_000).getTime(), start.getTime() + 20_000);   // capped
});

// ---------- 24h window + human pause ----------
test('24h guard: margin closes the window early; no inbound means no automated sends', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const in23h55 = new Date(now.getTime() - (23 * 60 + 55) * 60_000);
  assert.equal(withinDmWindow(in23h55, now), true);
  assert.equal(withinDmWindow(in23h55, now, 24, 10), false);
  assert.equal(automatedSendAllowed(null, now).ok, false);
  assert.equal(automatedSendAllowed(new Date(now.getTime() - 3_600_000), now).ok, true);
  assert.equal(automatedSendAllowed(new Date(now.getTime() - 25 * 3_600_000), now).reason, 'outside_messaging_window');
});

test('human takeover: cooldown pauses, manual takeover is indefinite, paused_human always pauses', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  const later = new Date(now.getTime() + 3_600_000), earlier = new Date(now.getTime() - 3_600_000);
  assert.equal(isHumanPaused({ humanTakeover: true, pausedUntil: later, mode: 'qualify_and_book' }, now), true);
  assert.equal(isHumanPaused({ humanTakeover: true, pausedUntil: earlier, mode: 'qualify_and_book' }, now), false);
  assert.equal(isHumanPaused({ humanTakeover: true, pausedUntil: null, mode: 'qualify_and_book' }, now), true);
  assert.equal(isHumanPaused({ humanTakeover: false, pausedUntil: null, mode: 'paused_human' }, now), true);
  const flags = { state: 'qualifying' as const, humanTakeover: false, pausedUntil: null, mode: 'qualify_and_book' as const, contactDnc: false };
  assert.equal(aiMayAct(flags, now).ok, true);
  assert.equal(aiMayAct({ ...flags, contactDnc: true }, now).reason, 'do_not_contact');
  assert.equal(aiMayAct({ ...flags, state: 'needs_human' }, now).reason, 'needs_human');
});

// ---------- follow-up planner guards ----------
const base = (over: Partial<FollowUpContext> = {}): FollowUpContext => ({
  now: new Date('2026-11-21T15:00:00Z'), mode: 'qualify_and_book', state: 'qualifying', callStatus: 'booking_link_sent', humanPaused: false, contactDnc: false,
  followupsSent: 0, lastInboundAt: new Date('2026-11-21T14:00:00Z'), timezone: 'UTC', windowStart: 9, windowEnd: 20, ...over,
});

test('planner: free-form delay is honoured inside the mode bounds and the window', () => {
  const d = guardFollowUp({ shouldFollowUp: true, delayMinutes: 120, goal: 'get_booking_completed' }, base());
  assert.ok(d.ok && d.delayMinutes === 120);
  // below the mode minimum is raised, above the maximum is capped
  const tiny = guardFollowUp({ shouldFollowUp: true, delayMinutes: 1, goal: 'qualify_fit' }, base());
  assert.ok(tiny.ok && tiny.delayMinutes === MODE_PROFILES.qualify_and_book.followUp.minDelayMin);
});

test('planner: hard guards beat the model (opt-out, pause, caps, booked call, lost, no-follow-up choice)', () => {
  const plan = { shouldFollowUp: true, delayMinutes: 60, goal: 'qualify_fit' as const };
  const reason = (o: Partial<FollowUpContext>, p = plan) => { const d = guardFollowUp(p, base(o)); return d.ok ? 'ok' : d.reason; };
  assert.equal(reason({ contactDnc: true }), 'do_not_contact');
  assert.equal(reason({ humanPaused: true }), 'human_paused');
  assert.equal(reason({ state: 'needs_human' }), 'needs_human');
  assert.equal(reason({ state: 'lost' }), 'state_lost');
  assert.equal(reason({ callStatus: 'call_booked' }), 'call_already_confirmed');
  assert.equal(reason({ followupsSent: 3 }), 'follow_up_cap_reached');
  assert.equal(reason({ mode: 'paused_human' }), 'mode_inactive');
  assert.equal(reason({ lastInboundAt: null }), 'no_inbound_message_yet');
  assert.equal(reason({}, { ...plan, shouldFollowUp: false }), 'planner_chose_no_follow_up');
});

test('planner: nothing is ever scheduled past the 24h window; late plans are pulled earlier or dropped', () => {
  // inbound 22h ago: 3h delay would land after the window (minus margin), so it is pulled earlier
  const ctx = base({ lastInboundAt: new Date('2026-11-20T17:30:00Z'), now: new Date('2026-11-21T15:30:00Z') });
  const d = guardFollowUp({ shouldFollowUp: true, delayMinutes: 600, goal: 'qualify_fit' }, ctx);
  if (d.ok) assert.ok(d.at.getTime() < new Date('2026-11-21T17:30:00Z').getTime(), d.at.toISOString());
  // window nearly closed, nothing fits
  const closing = base({ lastInboundAt: new Date('2026-11-20T15:40:00Z'), now: new Date('2026-11-21T15:00:00Z') });
  const none = guardFollowUp({ shouldFollowUp: true, delayMinutes: 60, goal: 'qualify_fit' }, closing);
  assert.equal(none.ok, false);
});

test('planner: outreach hours push a night-time plan to the next morning (if the window allows)', () => {
  const ctx = base({ now: new Date('2026-11-21T19:30:00Z'), lastInboundAt: new Date('2026-11-21T19:00:00Z') });
  const d = guardFollowUp({ shouldFollowUp: true, delayMinutes: 60, goal: 'qualify_fit' }, ctx);
  assert.ok(d.ok);
  if (d.ok) assert.equal(d.at.getUTCHours(), 9);
  assert.equal(nextOpenTime(new Date('2026-11-21T22:00:00Z'), 'UTC', 9, 20, new Date('2026-11-21T23:00:00Z')), null);
});

test('modes: thread overrides client default; every mode has bounds; paused_human is inactive', () => {
  assert.equal(effectiveMode({ mode: null }, { defaultMode: 'soft_nurture' }), 'soft_nurture');
  assert.equal(effectiveMode({ mode: 'direct_closer' }, { defaultMode: 'soft_nurture' }), 'direct_closer');
  assert.ok(MODE_PROFILES.soft_nurture.followUp.minDelayMin > MODE_PROFILES.direct_closer.followUp.minDelayMin);
  assert.equal(MODE_PROFILES.paused_human.aiActive, false);
  assert.match(buildSystemPrompt(makeClient(), 'direct_closer'), /MODE: direct_closer/);
  assert.match(buildSystemPrompt(makeClient(), 'noshow_recovery'), /MODE: noshow_recovery/);
});

// ---------- call status ----------
test('call status: link cannot undo a booking; cancel/no-show lead back to a new link; manual force wins', () => {
  assert.equal(canCallTransition('call_booked', 'booking_link_sent'), false);
  assert.equal(canCallTransition('no_booking_link_sent', 'booking_link_sent'), true);
  assert.equal(canCallTransition('call_canceled', 'booking_link_sent'), true);
  assert.equal(canCallTransition('booking_link_sent', 'call_booked'), true);
  assert.equal(canCallTransition('call_booked', 'call_no_show'), true);
  assert.equal(canCallTransition('booking_link_sent', 'call_no_show'), false);
  assert.equal(canCallTransition('call_completed', 'call_canceled'), false);
  assert.equal(canCallTransition('call_completed', 'booking_link_sent', true), true);
});

test('calendar payloads: Cal.com style and generic shapes map to call events', () => {
  const cal = mapCalendarPayload({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'b1', startTime: '2026-12-01T15:00:00Z', attendees: [{ name: 'Sam', email: 'sam@x.com' }], metadata: { instagram_user_id: '42' } } });
  assert.equal(cal?.status, 'call_booked'); assert.equal(cal?.instagramUserId, '42'); assert.equal(cal?.email, 'sam@x.com');
  assert.equal(mapCalendarPayload({ triggerEvent: 'BOOKING_RESCHEDULED', payload: { uid: 'b1' } })?.status, 'call_rescheduled');
  assert.equal(mapCalendarPayload({ triggerEvent: 'BOOKING_CANCELLED', payload: { uid: 'b1' } })?.status, 'call_canceled');
  assert.equal(mapCalendarPayload({ triggerEvent: 'MEETING_ENDED', payload: { uid: 'b1' } })?.status, 'call_completed');
  assert.equal(mapCalendarPayload({ status: 'no_show', external_id: 'b1', username: '@sam' })?.status, 'call_no_show');
  assert.equal(mapCalendarPayload({ event: 'call_completed' })?.status, 'call_completed');
  assert.equal(mapCalendarPayload({ hello: 'world' }), null);
  assert.equal(mapCalendarPayload(null), null);
  assert.equal(calendarEventKey({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'b1', startTime: '2026-12-01T15:00:00Z' } }), calendarEventKey({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'b1', startTime: '2026-12-01T15:00:00Z' } }));
});

test('booking link detection uses the client link only', () => {
  const c = makeClient();
  assert.equal(containsBookingLink('grab a time: https://cal.com/test/intro', c), true);
  assert.equal(containsBookingLink('grab a time: https://cal.com/other', c), false);
});

// ---------- comment-to-DM controls ----------
test('comment DM score gate, lead score and daily cap', () => {
  assert.equal(leadScore(100, 0), 60); assert.equal(leadScore(85, 70), 79); assert.equal(leadScore(500, 500), 100);
  assert.deepEqual(commentDmGate(79, { minCommentDmScore: 0, lowScoreAction: 'review' }), { action: 'send' });
  assert.deepEqual(commentDmGate(70, { minCommentDmScore: 70, lowScoreAction: 'review' }), { action: 'send' });
  const low = commentDmGate(69, { minCommentDmScore: 70, lowScoreAction: 'public_reply_only' });
  assert.equal(low.action, 'public_reply_only');
  assert.equal(commentDmGate(10, { minCommentDmScore: 70, lowScoreAction: 'skip' }).action, 'skip');
  assert.equal(commentDmCap(50, null), 50); assert.equal(commentDmCap(50, 20), 20); assert.equal(commentDmCap(15, 40), 15); assert.equal(commentDmCap(15, 0), 0);
  assert.equal(openerGapMs(() => 0, 2), 120_000); assert.equal(openerGapMs(() => 0, 5), 300_000); assert.equal(openerGapMs(() => 1, 2), 600_000);
});

test('daily cap stops openers at the limit but never blocks replies; public replies skip the DM cap', () => {
  const now = new Date('2026-11-21T15:00:00Z');
  const st: SendState = { now, braked: false, openerWindowOpen: true, openersSentToday: 20, openerCapToday: 20, nextOpenerAt: new Date(0), sentLastHour: 0, hourlyCap: 600 };
  const mk = (id: number, kind: Candidate['kind'], priority = 0): Candidate => ({ id, kind, priority, scheduledFor: new Date(now.getTime() - 1000) });
  assert.equal(pickNext([mk(1, 'opener')], st), null);
  assert.equal(pickNext([mk(1, 'opener'), mk(2, 'reply')], st)?.id, 2);
  assert.equal(pickNext([mk(3, 'public_reply')], st)?.id, 3);
  assert.equal(pickNext([mk(3, 'public_reply')], { ...st, braked: true }), null);
});

// ---------- attachments ----------
test('attachments: placeholders are stored, detected, and never cause a handoff', async () => {
  assert.equal(dmBody('', [{ kind: 'audio' }]), '[voice note]');
  assert.equal(dmBody('look', [{ kind: 'image' }, { kind: 'share' }]), 'look [image] [shared a post]');
  assert.equal(isAttachmentOnly([T('out', 'hi'), T('in', '[voice note]')]), true);
  assert.equal(isAttachmentOnly([T('out', 'hi'), T('in', 'hello'), T('in', '[image]')]), false);
  assert.equal(isAttachmentOnly([T('in', '[voice note] [image]')]), true);
  assert.match(attachmentFallback([T('in', '[voice note]')], () => 0), /voice note/i);

  // model returns something the guard rejects -> natural fallback, not a handoff
  const host = new FakeHost();
  const llm = new FakeLlm([text('As an AI language model I cannot hear that.')]);
  const r = await runTurn({ llm, client: makeClient(), history: [T('out', 'Hey!'), T('in', '[voice note]')], host, attachmentOnly: true, context: { nowLocal: 'x', source: 'inbound_dm', state: 'new' } });
  assert.ok(r.text && r.usedFallback);
  assert.equal(host.log.filter((l) => l.startsWith('handoff')).length, 0);

  // model outage -> fallback too
  const down = { complete: async () => { throw new Error('503'); } };
  const r2 = await runTurn({ llm: down, client: makeClient(), history: [T('in', '[image]')], host: new FakeHost(), attachmentOnly: true, context: { nowLocal: 'x', source: 'inbound_dm', state: 'new' } });
  assert.ok(r2.usedFallback && r2.text);
});

test('follow-up turn carries the goal and the planner angle', async () => {
  const llm = new FakeLlm([text('Did Thursday at 3 still work for you?')]);
  await runTurn({ llm, client: makeClient(), history: [T('in', 'maybe thursday'), T('out', 'Great, want 3pm?')], host: new FakeHost(), mode: 'followup', followupNumber: 1, goal: 'confirm_preferred_slot', angle: 'ask if Thursday 3pm works', opMode: 'direct_closer', context: { nowLocal: 'x', source: 'inbound_dm', state: 'scheduling' } });
  const last = String(llm.calls[0]!.messages.at(-1)!.content);
  assert.match(last, /gone quiet/); assert.match(last, /confirm a day and time/); assert.match(last, /Thursday 3pm/);
  assert.match(llm.calls[0]!.system, /direct_closer/);
});

// ---------- InstantDM events ----------
test('InstantDM mapper: dm_received (flat and nested), attachments, postback, question, flow, echo', () => {
  const dm = mapPayload({ event: 'dm_received', data: { sender_id: '42', message_id: 'm1', text: 'hi', username: 'sam' } })[0];
  assert.ok(dm?.type === 'dm' && dm.platformUserId === '42' && dm.text === 'hi');
  const voice = mapPayload({ event: 'dm_received', sender_id: '42', message_id: 'm2', attachments: [{ type: 'audio', url: 'https://x/a.m4a' }] })[0];
  assert.ok(voice?.type === 'dm' && voice.text === '' && voice.attachments?.[0]?.kind === 'audio');
  const share = mapPayload({ type: 'message', sender_id: '42', message_id: 'm3', attachments: [{ type: 'story_share' }] })[0];
  assert.ok(share?.type === 'dm' && share.attachments?.[0]?.kind === 'share');
  const pb = mapPayload({ event: 'postback', sender_id: '42', payload: 'YES_BOOK', title: 'Yes please' })[0];
  assert.ok(pb?.type === 'postback' && pb.title === 'Yes please');
  const qa = mapPayload({ event: 'question_answered', sender_id: '42', question: 'Goal?', answer: 'get stronger' })[0];
  assert.ok(qa?.type === 'question_answered' && qa.answer === 'get stronger');
  assert.equal(mapPayload({ event: 'flow_completed', sender_id: '42', flow_name: 'Welcome' })[0]?.type, 'flow_completed');
  assert.equal(mapPayload({ event: 'dm_echo', recipient_id: '42', message_id: 'e1', text: 'hello from a human' })[0]?.type, 'echo');
  assert.equal(mapPayload({ event: 'dm_outbound', recipient_id: '42', message_id: 'e2', message: 'x' })[0]?.type, 'echo');
  assert.equal(mapPayload({ event: 'comment', comment_id: 'c1', from_id: '7', text: 'price?' })[0]?.type, 'comment');
  assert.equal(mapPayload({ event: 'dm_received', sender_id: '42' })[0]?.type, 'ignored');   // no text, no attachment
});

test('InstantDM webhook event names: every documented InstantDM event maps to the right internal type', () => {
  // New Comment / Comment Reply / Live Comment → the comment engine.
  for (const name of ['comment', 'new_comment', 'comment_reply', 'live_comment']) {
    const c = mapPayload({ event: name, comment_id: 'c1', from_id: '7', text: 'nice post!' })[0];
    assert.ok(c?.type === 'comment' && c.commentId === 'c1' && c.text === 'nice post!', name);
  }
  // New DM and Story Reply → a conversation message; the story one is flagged for the transcript.
  const dm = mapPayload({ event: 'dm_received', sender_id: '42', message_id: 'm1', text: 'hi' })[0];
  assert.ok(dm?.type === 'dm');
  const story = mapPayload({ event: 'story_reply', sender_id: '42', message_id: 'm2', text: 'love this' })[0];
  assert.ok(story?.type === 'dm' && story.isStoryReply === true);
  // Postback, Question Answered, Flow Completed, Message Sent (Echo).
  assert.equal(mapPayload({ event: 'postback', sender_id: '42', payload: 'YES_BOOK' })[0]?.type, 'postback');
  assert.equal(mapPayload({ event: 'question_answered', sender_id: '42', question: 'Q', answer: 'A' })[0]?.type, 'question_answered');
  assert.equal(mapPayload({ event: 'flow_completed', sender_id: '42', flow_name: 'Welcome' })[0]?.type, 'flow_completed');
  assert.equal(mapPayload({ event: 'message_sent', recipient_id: '42', message_id: 'e1', text: 'a human sent this' })[0]?.type, 'echo');
  // Dedup: a platform event id is the dedup key, even when a message id is also present;
  // without one, the message/comment id forms a stable key, and with neither a content hash.
  assert.equal(eventKey({ event: 'dm_received', event_id: 'evt-1', message_id: 'm1' }), 'evt-1');
  assert.equal(eventKey({ event: 'dm_received', message_id: 'm1', sender_id: '42' }), 'dm_received:m1');
  assert.equal(eventKey({ event: 'comment', comment_id: 'c1', text: 'x' }), 'comment:c1');
  assert.equal(eventKey({ event: 'dm_received', sender_id: '42', text: 'hello' }), eventKey({ event: 'dm_received', sender_id: '42', text: 'hello' }));
});

// ---------- Test Chat (AI Studio sandbox) ----------
test('Test Chat: runs the real conversation loop with a sandbox host — tools record, nothing is sent or saved', async () => {
  const llm = new FakeLlm([
    toolUse('check_availability', { from_date: '2026-11-11', to_date: '2026-11-13' }, 'tu_a'),
    toolUse('book_appointment', { slot_start: '2026-11-12T15:00:00Z', name: 'Sam' }, 'tu_b'),
    text("You're booked for Thursday, Sam!"),
  ]);
  const client = makeClient({ knowledge: 'PRICING\nStarter program is $400/month.' });
  const r = await testChatTurn(llm, client, [], 'can I book thursday?');
  assert.match(r.reply ?? '', /booked/);
  assert.deepEqual(r.toolsUsed, ['check_availability', 'book_appointment']);
  // The booking "happened" only in the sandbox: recorded as what-would-happen, nothing real.
  const book = r.sandboxEvents.find((e) => e.tool === 'book');
  assert.ok(book && /would book Sam at 2026-11-12/.test(book.detail));
  // The pretend availability and knowledge come from the client's real facts file.
  const host = new SandboxHost(client);
  assert.match(await host.searchKnowledge('how much is the program?'), /\$400/);
  assert.equal((await host.checkAvailability()).length, 3);
  // The lead message is length-capped like a real DM and appended to the given history.
  const long = 'x'.repeat(3000);
  const llm2 = new FakeLlm([text('ok')]);
  await testChatTurn(llm2, client, [], long);
  const sent = llm2.calls[0]!.messages as Array<{ role: string; content: string | Array<unknown> }>;
  const lastUser = sent.filter((m) => m.role === 'user').pop()!;
  assert.ok(JSON.stringify(lastUser.content).includes('x'.repeat(900)));   // text got through…
  assert.ok(JSON.stringify(lastUser.content).length < 2500);               // …but capped, not the full 3000
});

test('Test Chat: the sandbox can never reach the channel — no adapter, sender or fetch in its module', () => {
  const src = readFileSync(new URL('../src/api/testchat.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // strip comments
  assert.equal(/instantdm|platform\/|sender|fetch\(|https?:\/\//.test(src), false,
    'Test Chat module must not import or touch anything that can send');
});

// ---------- signature ----------
test('webhook signature: HMAC-SHA256 over the raw body, timing-safe, strict format', () => {
  const raw = '{"event":"dm_received","sender_id":"42"}';
  const sig = computeSignature(raw, 'secret');
  assert.equal(verifySignature(raw, sig, 'secret'), true);
  assert.equal(verifySignature(raw, `sha256=${sig}`, 'secret'), true);
  assert.equal(verifySignature(raw + ' ', sig, 'secret'), false);          // body changed by one byte
  assert.equal(verifySignature(raw, sig, 'other'), false);
  assert.equal(verifySignature(raw, 'short', 'secret'), false);            // unequal length must not throw
  assert.equal(verifySignature(raw, undefined, 'secret'), false);
  assert.equal(verifySignature(raw, 'z'.repeat(64), 'secret'), false);
});

test('webhook auth: signature required once a secret is configured; URL token otherwise', () => {
  const raw = '{}'; const good = computeSignature(raw, 's');
  const a = (o: Partial<Parameters<typeof authorizeWebhook>[0]>) => authorizeWebhook({ rawBody: raw, signatureHeader: undefined, token: undefined, urlToken: 'tok', signingSecret: undefined, ...o });
  assert.equal(a({ token: 'tok' }).ok, true);
  assert.equal(a({ token: 'nope' }).ok, false);
  assert.equal(a({}).ok, false);
  assert.equal(a({ signingSecret: 's', signatureHeader: good }).ok, true);
  assert.equal(a({ signingSecret: 's', token: 'tok' }).reason, 'missing_signature');   // token alone is not enough
  assert.equal(a({ signingSecret: 's', signatureHeader: computeSignature(raw, 'x') }).reason, 'bad_signature');
});

// ---------- dashboard ----------
test('dashboard page: landmarks, skip link, labelled controls, no innerHTML, all eight pages, plain words', () => {
  const html = dashboardHtml();
  assert.match(html, /<html lang="en">/); assert.match(html, /class="skip"/); assert.match(html, /<main id="main"/);
  assert.match(html, /aria-live="polite"/);
  // Tables get their headers from the DOM helper (h('th', { scope: 'col', ... }) → setAttribute in the runtime).
  assert.match(html, /scope: 'col'/);
  // All eight sidebar pages are present and hash-routed.
  for (const route of ['home', 'pipeline', 'conversations', 'comments', 'clients', 'studio', 'ask', 'health']) {
    assert.match(html, new RegExp(`href="#${route}"`), route);
  }
  // Self-hosted Plus Jakarta Sans, light/dark theming, manual toggle.
  assert.match(html, /plus-jakarta-sans-latin\.woff2/); assert.match(html, /font-weight: 200 800/);
  assert.match(html, /data-theme='dark'/); assert.match(html, /theme-toggle/);
  // Plain words, not jargon.
  for (const phrase of ['How interested they seem', 'Needs you', 'Pause the AI', 'Held for review', 'Describe-it box',
    'Lowest score to DM automatically', 'Most comment DMs per day', 'Ask your AI', 'be a pretend lead',
    'Booking link', 'DM’d from comment', 'What every setting means']) {
    assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), phrase);
  }
  // Proposal + confirm flow, and the never-acts promise.
  assert.match(html, /Confirm/); assert.match(html, /Nothing changes until you/);
  // Labelled controls (login, Context Bot, describe-it, Ask AI, comment rules, client picker):
  // static labels use for="id", runtime ones are built by the h() helper as { for: 'id' }.
  for (const id of ['token', 'bot-q', 'describe-req', 'ask-input', 'c-mode', 'c-min', 'c-max', 'client-select']) {
    assert.match(html, new RegExp(`for(=|: )['"]${id}['"]`), id);
  }
  // No innerHTML anywhere (the whole page builds DOM with textContent helpers).
  assert.equal(/innerHTML/.test(html), false);
  // Safe against template-literal injection: the page is String.raw, so no backticks inside the JS.
  const script = html.slice(html.indexOf('<script>'));
  assert.equal(script.includes('`'), false);
  // Every route the router can pick has a renderer — a missing login renderer used to crash
  // the router on every first visit (no stored token) and leave the whole app blank.
  for (const route of ['home', 'pipeline', 'conversations', 'comments', 'clients', 'studio', 'ask', 'health', 'login']) {
    assert.match(html, new RegExp(`RENDERERS\\.${route} =`), route);
  }
  // The router never calls a missing renderer and never lets a page error blank the app.
  assert.match(html, /if \(!RENDERERS\[route\]\) \{ renderLogin\(\); return; \}/);
  assert.match(html, /This page hit a snag/);
  // Storage is always accessed through guarded helpers (blocked site data must not kill the script).
  assert.match(html, /function ssGet/); assert.match(html, /function lsSet/);
  assert.equal((html.match(/sessionStorage\./g) || []).length, 3);
  assert.equal((html.match(/localStorage\./g) || []).length, 2);
  assert.equal(dashboardHtml(), html);   // deterministic
});
