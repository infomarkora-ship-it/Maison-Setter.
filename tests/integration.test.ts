// Runs the real handlers against a real Postgres (set DATABASE_URL). Skipped otherwise.
// The model is scripted (FakeLlm) and the platform is MockAdapter, so it is deterministic and free.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, q, q1 } from '../src/db.js';
import * as repo from '../src/repo.js';
import { claimJobs, completeJob, enqueue, failJob } from '../src/jobs.js';
import { handleEvent, type Deps } from '../src/handlers/events.js';
import { approveReviewedComment, classifyCommentJob } from '../src/handlers/comments.js';
import { applyCallStatus } from '../src/booking.js';
import { converseJob } from '../src/handlers/converse.js';
import { brakeScan, followupJob, followupScan, pauseExpiryScan, planJob, reminderScan } from '../src/handlers/schedulers.js';
import { sendTick } from '../src/sender.js';
import { MockAdapter } from '../src/platform/mock.js';
import type { Client } from '../src/types.js';
import type { LlmResult } from '../src/ai/llm.js';
import { FakeLlm, text, toolUse } from './helpers.js';

const run = process.env.DATABASE_URL ? test : test.skip;
after(async () => { await closePool(); });

const SLOTS = ['2026-12-01T15:00:00Z', '2026-12-02T16:00:00Z'];
let client: Client;

async function freshClient(): Promise<Client> {
  await q('TRUNCATE clients, jobs CASCADE');
  const r = await q1<{ id: string }>(
    `INSERT INTO clients (name, timezone, webhook_secret, platform_api_key, instagram_account_id, settings, knowledge,
        opener_window_start, opener_window_end, calendar_provider, calendar_config, launched_at, next_opener_at)
     VALUES ('Test Studio','America/Toronto','sec','key','ig-own',$1,$2,0,24,'mock',$3, now() - interval '10 days', now() - interval '1 hour') RETURNING id`,
    [JSON.stringify({
      businessSummary: 'A small strength studio in Ottawa.', offer: 'Free intro call then a $400 4-week program', idealCustomer: 'Adults in Ottawa',
      disqualifiers: [], qualificationQuestions: ['Goal'], tone: 'Friendly', forbiddenClaims: ['guaranteed results'], bookingLink: 'https://cal.com/test/intro',
    }), 'Program: 4-week starter, $400.\n\nClasses Mon-Sat.', JSON.stringify({ slots: SLOTS })],
  );
  return (await repo.getClient(r!.id))!;
}
const mk = (script: Array<Partial<LlmResult>> = []) => ({ llm: new FakeLlm(script), adapter: new MockAdapter() }) satisfies Deps;
const commentEv = (id = 'c1', author = 'u1', t = 'how much is the program?') =>
  ({ type: 'comment' as const, eventId: id, commentId: id, authorId: author, username: 'sam', text: t, postCaption: 'New program!', at: new Date(Date.now() - 3_600_000), likeCount: 3 });
const dmEv = (mid: string, user = 'u1', t = 'hi') => ({ type: 'dm' as const, eventId: mid, platformUserId: user, messageId: mid, text: t, at: new Date(), username: 'sam' });
const makeSendable = () => q(`UPDATE send_queue SET scheduled_for = now() - interval '1 minute' WHERE status = 'pending'`);

beforeEach(async () => { if (process.env.DATABASE_URL) client = await freshClient(); });

run('full journey: comment -> classify -> opener -> reply -> AI reply -> booking', async () => {
  // 1. comment arrives
  let d = mk();
  await handleEvent(d, client, commentEv());
  const c = (await q<{ id: string; status: string }>(`SELECT id, status FROM comments`))[0]!;
  assert.equal(c.status, 'pending');
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'classify_comment'`)).length, 1);

  // 2. classifier says engage -> opener queued with a priority
  d = mk([toolUse('submit', { decision: 'engage', intent_score: 85, fit_score: 70, reason: 'asks price' })]);
  await classifyCommentJob(d, c.id);
  const queued = await q1<{ kind: string; priority: string }>(`SELECT kind, priority FROM send_queue`);
  assert.equal(queued?.kind, 'opener');
  assert.ok(Number(queued!.priority) > 50);

  // 3. sender generates + sends the opener (public reply first, then private DM)
  d = mk([toolUse('submit', { opener: 'Hey Sam! What made you curious about the program, are you looking to get stronger?', public_reply: 'Sent you a DM!' })]);
  await sendTick(d);
  assert.deepEqual(d.adapter.sent.map((s) => s.kind), ['public', 'private']);
  const conv = (await q<{ id: string; state: string; source: string }>(`SELECT id, state, source FROM conversations`))[0]!;
  assert.equal(conv.state, 'qualifying');
  assert.equal(conv.source, 'comment_opener');
  assert.equal((await q1<{ status: string }>(`SELECT status FROM comments`))?.status, 'sent');
  const after = await repo.getClient(client.id);
  assert.ok(after!.nextOpenerAt.getTime() > Date.now() + 100_000, 'next opener must be spaced 2+ minutes out');

  // 4. they reply -> converse job queued (debounced) -> AI answers with a KB price
  d = mk();
  await handleEvent(d, client, dmEv('m1', 'u1', 'yes want to get stronger, how much?'));
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'converse'`)).length, 1);
  d = mk([text('Love that! The 4-week starter is $400. Want me to set up a free intro call?')]);
  await converseJob(d, conv.id);
  const reply = await q1<{ kind: string; body: string; scheduledFor: Date }>(`SELECT kind, body, scheduled_for FROM send_queue WHERE kind = 'reply'`);
  assert.match(reply!.body, /\$400/);
  assert.ok(reply!.scheduledFor.getTime() > Date.now() + 5_000, 'reply must have a human-feeling delay');
  await makeSendable();
  d = mk();
  await sendTick(d);
  assert.equal(d.adapter.sent[0]?.kind, 'dm');

  // 5. they pick a time -> model books via tools -> state booked + appointment row
  d = mk();
  await handleEvent(d, client, dmEv('m2', 'u1', 'thursday works, I am Sam'));
  d = mk([
    toolUse('check_availability', { from_date: '2026-12-01', to_date: '2026-12-05' }, 'a'),
    toolUse('book_appointment', { slot_start: SLOTS[0], name: 'Sam', email: 'sam@example.com' }, 'b'),
    toolUse('update_lead_status', { status: 'scheduling', reason: 'picked a time' }, 'c'),
    text("You're booked, Sam! See you on the 1st."),
  ]);
  await converseJob(d, conv.id);
  assert.equal((await q1<{ state: string }>(`SELECT state FROM conversations`))?.state, 'booked');
  assert.equal((await q(`SELECT 1 FROM appointments`)).length, 1);

  // 6. sale + commission (20% of $1,000) and funnel
  const sale = await repo.recordSale(conv.id, 100_000, 'closed on the call');
  assert.equal(Number(sale!.commissionCents), 20_000);
  const f = (await repo.funnel(client.id))[0]!;
  assert.equal(f.source, 'comment_opener');
  assert.equal(f.conversations, 1);
  assert.equal(f.booked, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.commissionCents, '20000');
});

run('duplicate deliveries are ignored (raw event, comment, message)', async () => {
  assert.notEqual(await repo.insertRawEvent(client.id, 'k1', { a: 1 }), null);
  assert.equal(await repo.insertRawEvent(client.id, 'k1', { a: 1 }), null);
  const d = mk();
  await handleEvent(d, client, commentEv('dup'));
  await handleEvent(d, client, commentEv('dup'));
  assert.equal((await q(`SELECT 1 FROM comments`)).length, 1);
  await handleEvent(d, client, dmEv('same', 'u9'));
  await handleEvent(d, client, dmEv('same', 'u9'));
  assert.equal((await q(`SELECT 1 FROM messages`)).length, 1);
});

run('prefiltered and low-intent comments never produce an opener', async () => {
  let d = mk();
  await handleEvent(d, client, commentEv('e1', 'u1', '🔥🔥🔥'));
  assert.equal((await q1<{ status: string }>(`SELECT status FROM comments WHERE platform_comment_id = 'e1'`))?.status, 'skipped');
  await handleEvent(d, client, commentEv('e2', 'u2', 'love this so much, you guys are great'));
  const c = await q1<{ id: string }>(`SELECT id FROM comments WHERE platform_comment_id = 'e2'`);
  d = mk([toolUse('submit', { decision: 'ignore', intent_score: 10, fit_score: 50, reason: 'praise' })]);
  await classifyCommentJob(d, c!.id);
  // classifier failure fails closed
  await handleEvent(d, client, commentEv('e3', 'u3', 'what are your hours?'));
  const c3 = await q1<{ id: string }>(`SELECT id FROM comments WHERE platform_comment_id = 'e3'`);
  d = mk([text('no tool call')]);
  await classifyCommentJob(d, c3!.id);
  assert.equal((await q1<{ reason: string }>(`SELECT reason FROM comments WHERE platform_comment_id = 'e3'`))?.reason, 'classifier_failed');
  assert.equal((await q(`SELECT 1 FROM send_queue`)).length, 0);
});

run('a human reply (echo) triggers takeover and cancels queued AI sends; AI own echoes do not', async () => {
  let d = mk();
  await handleEvent(d, client, dmEv('m1', 'u1', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: 'queued ai reply' });
  // our own message echoing back: must NOT trigger takeover
  await repo.insertMessage({ clientId: client.id, conversationId: conv.id, direction: 'out', body: 'earlier ai msg', platformMessageId: 'ours-1' });
  await handleEvent(d, client, { type: 'echo', eventId: 'e0', recipientId: 'u1', messageId: 'ours-1', text: 'earlier ai msg', at: new Date() });
  assert.equal((await repo.getConversation(conv.id))!.humanTakeover, false);
  // a message we never sent: a human typed it
  await handleEvent(d, client, { type: 'echo', eventId: 'e1', recipientId: 'u1', messageId: 'human-1', text: 'Hi, it is Dana from the studio', at: new Date() });
  assert.equal((await repo.getConversation(conv.id))!.humanTakeover, true);
  assert.equal((await q1<{ status: string }>(`SELECT status FROM send_queue`))?.status, 'cancelled');
  // further inbound messages are stored but the AI stays quiet
  await q(`DELETE FROM jobs`);
  await handleEvent(d, client, dmEv('m2', 'u1', 'thanks Dana'));
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'converse'`)).length, 0);
  assert.equal((await q(`SELECT 1 FROM messages WHERE body = 'thanks Dana'`)).length, 1, 'the message is still stored for the transcript');
});

run('opt-out: DNC is set, queue cleared, one confirmation sent, openers to that person blocked', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u2', 'stop messaging me'));
  const contact = await repo.findContact(client.id, 'u2');
  assert.equal(contact!.doNotContact, true);
  assert.equal(d.adapter.sent.length, 1);
  assert.match(d.adapter.sent[0]!.text, /won't message/);
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'converse'`)).length, 0);
  // they later comment: no opener
  await handleEvent(d, client, commentEv('c-after', 'u2', 'how much is the program?'));
  const c = await q1<{ id: string }>(`SELECT id FROM comments WHERE platform_comment_id = 'c-after'`);
  await classifyCommentJob(mk(), c!.id);
  assert.equal((await q1<{ reason: string }>(`SELECT reason FROM comments WHERE id = $1`, [c!.id]))?.reason, 'do_not_contact');
});

run('brake pauses openers but inbound replies still go out', async () => {
  // 35 openers sent 8h ago with zero replies -> reply rate 0%
  for (let i = 0; i < 35; i++) await q(`INSERT INTO send_queue (client_id, kind, status, sent_at, last_attempt_at) VALUES ($1,'opener','sent', now() - interval '8 hours', now() - interval '8 hours')`, [client.id]);
  await brakeScan();
  const brake = await repo.activeBrake(client.id);
  assert.match(brake!.reason, /low_reply_rate/);

  // a queued opener and a reply: only the reply goes
  const dm = mk();
  await handleEvent(dm, client, dmEv('m1', 'u5', 'hi there'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: 'Hi! How can I help?' });
  await handleEvent(dm, client, commentEv('cc', 'u6', 'how much?'));
  const cm = await q1<{ id: string }>(`SELECT id FROM comments WHERE platform_comment_id = 'cc'`);
  await q(`UPDATE comments SET status = 'queued' WHERE id = $1`, [cm!.id]);
  await repo.enqueueSend({ clientId: client.id, kind: 'opener', commentId: cm!.id, priority: 99 });
  const d = mk();
  await makeSendable();
  await sendTick(d);
  await sendTick(d);
  assert.deepEqual(d.adapter.sent.map((s) => s.text), ['Hi! How can I help?']);
  assert.equal((await q1<{ status: string }>(`SELECT status FROM send_queue WHERE kind = 'opener' AND comment_id IS NOT NULL`))?.status, 'pending');
});

run('replies outside the 24h DM window expire instead of being sent', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u7', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await q(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [conv.id]);
  await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: 'late reply' });
  await makeSendable();
  await sendTick(d);
  assert.equal(d.adapter.sent.length, 0);
  assert.equal((await q1<{ status: string }>(`SELECT status FROM send_queue`))?.status, 'expired');
});

run('platform send errors retry with backoff, then fail permanently', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u8', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: 'hello back' });
  d.adapter.failNext = new Error('boom');
  await makeSendable();
  await sendTick(d);
  const row = await q1<{ status: string; attempts: number; scheduledFor: Date }>(`SELECT status, attempts, scheduled_for FROM send_queue`);
  assert.equal(row!.status, 'pending');
  assert.equal(row!.attempts, 1);
  assert.ok(row!.scheduledFor.getTime() > Date.now() + 200_000);
});

run('follow-ups: the planner (not a fixed timer) schedules one; caps and booked calls stop it', async () => {
  let d = mk();
  await handleEvent(d, client, dmEv('m1', 'u9', 'interested in the program'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await q(`UPDATE conversations SET state = 'qualifying', last_inbound_at = now() - interval '3 hours', last_outbound_at = now() - interval '2 hours' WHERE id = $1`, [conv.id]);
  // safety-net scan notices a quiet thread with no plan and asks for one
  await q(`DELETE FROM jobs`);
  await followupScan();
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'plan_followup'`)).length, 1);
  // the model plans: 90 minutes, goal = get_booking_completed
  d = mk([toolUse('submit_plan', { should_follow_up: true, recommended_delay_minutes: 90, goal: 'get_booking_completed', rationale: 'asked about booking then went quiet', message_angle: 'offer to hold a slot', lead_score: 77 })]);
  await planJob(d, conv.id);
  const planned = await repo.getConversation(conv.id);
  assert.equal(planned!.conversationGoal, 'get_booking_completed');
  assert.equal(planned!.leadScore, 77);
  assert.ok(planned!.nextFollowUpAt && planned!.nextFollowUpAt.getTime() > Date.now() + 60 * 60_000);
  const job = await q1<{ payload: { conversationId: string } }>(`SELECT payload FROM jobs WHERE type = 'followup' AND status = 'pending'`);
  assert.equal(job!.payload.conversationId, conv.id);
  // the follow-up job writes the message for that goal and queues it with the goal attached
  d = mk([text('Want me to hold a time for you this week?')]);
  await followupJob(d, conv.id, 1);
  const row = await q1<{ kind: string; goal: string }>(`SELECT kind, goal FROM send_queue`);
  assert.equal(row?.kind, 'followup'); assert.equal(row?.goal, 'get_booking_completed');
  // after the cap, no plan
  await q(`DELETE FROM jobs`); await q(`DELETE FROM send_queue`);
  await q(`UPDATE conversations SET followups_sent = 3, next_follow_up_at = NULL WHERE id = $1`, [conv.id]);
  await planJob(mk(), conv.id);
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'followup'`)).length, 0);
});

run('call monitor: a confirmed booking cancels stale follow-ups; a cancel flips to noshow_recovery and replans', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u12', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.enqueueSend({ clientId: client.id, kind: 'followup', conversationId: conv.id, body: 'Ready to book?', goal: 'get_booking_completed' });
  await enqueue('followup', { conversationId: conv.id, n: 1 }, { clientId: client.id, dedupeKey: `followup:${conv.id}` });
  let c = (await repo.getConversation(conv.id))!;
  await applyCallStatus(c, client, 'call_booked', { source: 'calendar_webhook', startsAt: new Date(Date.now() + 86_400_000), externalId: 'b1', email: 'sam@example.com' });
  assert.equal((await q1<{ status: string }>(`SELECT status FROM send_queue WHERE kind = 'followup'`))?.status, 'cancelled');
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'followup' AND status = 'pending'`)).length, 0);
  c = (await repo.getConversation(conv.id))!;
  assert.equal(c.callStatus, 'call_booked'); assert.equal(c.state, 'booked');
  assert.equal((await q(`SELECT 1 FROM appointments`)).length, 1);
  // duplicate delivery is a no-op
  assert.equal((await applyCallStatus(c, client, 'call_booked', { source: 'calendar_webhook', externalId: 'b1' })).changed, false);
  // cancellation
  await applyCallStatus(c, client, 'call_canceled', { source: 'calendar_webhook', externalId: 'b1' });
  c = (await repo.getConversation(conv.id))!;
  assert.equal(c.callStatus, 'call_canceled'); assert.equal(c.mode, 'noshow_recovery'); assert.equal(c.state, 'scheduling');
  assert.equal(c.conversationGoal, 'rebook_canceled');
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'plan_followup' AND status = 'pending'`)).length, 1);
  assert.equal((await q1<{ status: string }>(`SELECT status FROM appointments`))?.status, 'cancelled');
});

run('booking link in a sent message records booking_link_sent_at and the call status', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u13', 'yes I want to book'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: 'Great! Grab a time here: https://cal.com/test/intro' });
  await makeSendable();
  await sendTick(d);
  const c = (await repo.getConversation(conv.id))!;
  assert.equal(c.callStatus, 'booking_link_sent'); assert.ok(c.bookingLinkSentAt);
  assert.equal((await q(`SELECT 1 FROM thread_events WHERE kind = 'booking_link_sent'`)).length, 1);
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'plan_followup'`)).length, 1);
});

run('multi-bubble replies go out as separate messages with pauses between', async () => {
  const d = { ...mk(), sleep: async () => undefined };
  await handleEvent(d, client, dmEv('m1', 'u14', 'tell me more'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: 'Happy to!\n\nThe starter is $400 for four weeks.\n\nWant a free intro call first?' });
  await makeSendable();
  await sendTick(d);
  assert.equal(d.adapter.sent.length, 3);
  assert.equal((await q(`SELECT 1 FROM messages WHERE direction = 'out'`)).length, 3);
});

run('rapid-fire messages share one converse job whose run time keeps moving out', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('r1', 'u15', 'hey'));
  const first = await q1<{ runAt: Date }>(`SELECT run_at FROM jobs WHERE type = 'converse'`);
  await new Promise((r) => setTimeout(r, 50));
  await handleEvent(d, client, dmEv('r2', 'u15', 'quick question'));
  await handleEvent(d, client, dmEv('r3', 'u15', 'about pricing'));
  const rows = await q<{ runAt: Date }>(`SELECT run_at FROM jobs WHERE type = 'converse'`);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.runAt.getTime() > first!.runAt.getTime());
});

run('voice notes and shared posts are stored as placeholders and still reach the AI', async () => {
  const d = mk();
  await handleEvent(d, client, { type: 'dm', eventId: 'v1', platformUserId: 'u16', messageId: 'v1', text: '', at: new Date(), attachments: [{ kind: 'audio' }] });
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  assert.equal((await q1<{ body: string }>(`SELECT body FROM messages`))?.body, '[voice note]');
  assert.equal((await q(`SELECT 1 FROM jobs WHERE type = 'converse'`)).length, 1);
  const d2 = mk([text('As an AI language model I cannot hear this.')]);
  await converseJob(d2, conv.id);
  assert.match((await q1<{ body: string }>(`SELECT body FROM send_queue WHERE kind = 'reply'`))?.body ?? '', /voice note/i);
  assert.equal((await repo.getConversation(conv.id))!.state === 'needs_human', false);
});

run('human takeover sets a paused_until cooldown; the AI resumes after it expires', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u17', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await handleEvent(d, client, { type: 'echo', eventId: 'e9', recipientId: 'u17', messageId: 'h-9', text: 'Dana here, taking over', at: new Date() });
  const paused = (await repo.getConversation(conv.id))!;
  assert.equal(paused.humanTakeover, true);
  assert.ok(paused.pausedUntil && paused.pausedUntil.getTime() > Date.now() + 20 * 3_600_000);
  await q(`UPDATE conversations SET paused_until = now() - interval '1 minute' WHERE id = $1`, [conv.id]);
  assert.equal(await pauseExpiryScan(), 1);
  assert.equal((await repo.getConversation(conv.id))!.humanTakeover, false);
});

run('comment score threshold: low scores are held for review (or public-reply only); approve queues the opener', async () => {
  await q(`UPDATE clients SET min_comment_dm_score = 80`);
  client = (await repo.getClient(client.id))!;
  let d = mk();
  await handleEvent(d, client, commentEv('s1', 'u20', 'how much is the program?'));
  const c = (await q<{ id: string }>(`SELECT id FROM comments`))[0]!;
  d = mk([toolUse('submit', { decision: 'engage', intent_score: 70, fit_score: 60, reason: 'asks price' })]);   // lead score 66 < 80
  await classifyCommentJob(d, c.id);
  assert.equal((await q1<{ status: string; leadScore: number }>(`SELECT status, lead_score FROM comments`))?.status, 'review');
  assert.equal((await q(`SELECT 1 FROM send_queue`)).length, 0);
  assert.equal(await approveReviewedComment(c.id), true);
  assert.equal((await q1<{ kind: string }>(`SELECT kind FROM send_queue`))?.kind, 'opener');

  await q(`DELETE FROM send_queue`); await q(`DELETE FROM comments`);
  await q(`UPDATE clients SET low_score_action = 'public_reply_only'`);
  client = (await repo.getClient(client.id))!;
  await handleEvent(d, client, commentEv('s2', 'u21', 'how much is the program?'));
  const c2 = (await q<{ id: string }>(`SELECT id FROM comments`))[0]!;
  await classifyCommentJob(mk([toolUse('submit', { decision: 'engage', intent_score: 70, fit_score: 60, reason: 'asks price' })]), c2.id);
  assert.equal((await q1<{ kind: string }>(`SELECT kind FROM send_queue`))?.kind, 'public_reply');
});

run('daily comment-DM cap: at most N comment DMs per local day, and comment_dm_sent_at is recorded', async () => {
  await q(`UPDATE clients SET max_comment_dms_per_day = 1, comment_dm_min_gap_minutes = 2`);
  client = (await repo.getClient(client.id))!;
  for (const [id, user] of [['k1', 'u30'], ['k2', 'u31']] as const) {
    const d = mk();
    await handleEvent(d, client, commentEv(id, user, 'how much is the program?'));
    const row = await q1<{ id: string }>(`SELECT id FROM comments WHERE platform_comment_id = $1`, [id]);
    await classifyCommentJob(mk([toolUse('submit', { decision: 'engage', intent_score: 90, fit_score: 90, reason: 'asks price' })]), row!.id);
  }
  const opener = toolUse('submit', { opener: 'Hey! What got you curious about the program?', public_reply: 'Sent a DM!' });
  const d = mk([opener, { ...opener }]);
  await makeSendable(); await sendTick(d);
  await q(`UPDATE clients SET next_opener_at = now() - interval '1 hour'`); await makeSendable(); await sendTick(d);
  const sentDms = d.adapter.sent.filter((s) => s.kind === 'private');
  assert.equal(sentDms.length, 1, 'second comment DM must wait for tomorrow');
  const conv = (await q<{ commentDmSentAt: Date; commentDmCommentId: string }>(`SELECT comment_dm_sent_at, comment_dm_comment_id FROM conversations`))[0]!;
  assert.ok(conv.commentDmSentAt); assert.match(conv.commentDmCommentId, /^k[12]$/);
  assert.equal(await repo.commentDmsToday(client.id, client.timezone), 1);
  assert.equal((await q(`SELECT 1 FROM thread_events WHERE kind = 'comment_dm_sent'`)).length, 1);
});

run('reminders are queued once, 24h before', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u10', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await repo.insertAppointment({ clientId: client.id, conversationId: conv.id, startsAt: new Date(Date.now() + 24 * 3_600_000), name: 'Sam' });
  await reminderScan();
  await reminderScan();
  const rows = await q<{ kind: string; body: string }>(`SELECT kind, body FROM send_queue`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'reminder');
  assert.match(rows[0]!.body, /Test Studio/);
});

run('job queue: dedupe, retry with backoff, dead-letter', async () => {
  await enqueue('converse', { conversationId: 'x' }, { dedupeKey: 'same' });
  await enqueue('converse', { conversationId: 'x' }, { dedupeKey: 'same' });
  assert.equal((await q(`SELECT 1 FROM jobs`)).length, 1);
  let [job] = await claimJobs(5);
  assert.equal(job!.attempts, 1);
  await failJob(job!.id, 'first failure');
  const retry = await q1<{ status: string; runAt: Date }>(`SELECT status, run_at FROM jobs`);
  assert.equal(retry!.status, 'pending');
  assert.ok(retry!.runAt.getTime() > Date.now());
  await q(`UPDATE jobs SET run_at = now(), attempts = max_attempts - 1`);
  [job] = await claimJobs(5);
  await failJob(job!.id, 'final failure');
  assert.equal((await q1<{ status: string }>(`SELECT status FROM jobs`))?.status, 'dead');
  await q(`UPDATE jobs SET status = 'pending', attempts = 0, run_at = now()`);
  [job] = await claimJobs(5);
  await completeJob(job!.id);
  assert.equal((await q1<{ status: string }>(`SELECT status FROM jobs`))?.status, 'done');
});

run('sales outside the attribution window are rejected', async () => {
  const d = mk();
  await handleEvent(d, client, dmEv('m1', 'u11', 'hello'));
  const conv = (await q<{ id: string }>(`SELECT id FROM conversations`))[0]!;
  await q(`UPDATE conversations SET first_touch_at = now() - interval '60 days' WHERE id = $1`, [conv.id]);
  assert.equal(await repo.recordSale(conv.id, 50_000), null);
});
