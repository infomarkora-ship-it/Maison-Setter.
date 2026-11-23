import test from 'node:test';
import assert from 'node:assert/strict';
import { historyToMessages, runTurn } from '../src/ai/converse.js';
import type { Turn } from '../src/types.js';
import { FakeHost, FakeLlm, makeClient, text, toolUse } from './helpers.js';

const t = (direction: 'in' | 'out', body: string): Turn => ({ direction, body, createdAt: new Date() });
const ctx = { nowLocal: 'Tuesday 10:00', source: 'inbound_dm' as const, state: 'new' as const };

test('history merges consecutive same-role turns and never starts with the assistant', () => {
  const m = historyToMessages([t('out', 'Saw your comment!'), t('in', 'yes'), t('in', 'how much'), t('out', 'Hi')]);
  assert.equal(m[0]?.role, 'user');                         // synthetic opener context
  assert.equal(m[1]?.role, 'assistant');
  assert.equal(m[2]?.content, 'yes\nhow much');
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
});

test('plain reply passes the guard and is returned', async () => {
  const llm = new FakeLlm([text('Hey! The starter program is $400. What are you hoping to work on?')]);
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'how much is it?')], host: new FakeHost(), context: ctx });
  assert.match(r.text ?? '', /\$400/);
  assert.equal(r.handedOff, false);
  assert.ok(llm.calls[0]?.tools?.some((x) => x.name === 'handoff_to_human'));
});

test('tool loop: availability -> booking -> confirmation, with correct tool_result plumbing', async () => {
  const host = new FakeHost();
  const llm = new FakeLlm([
    toolUse('check_availability', { from_date: '2026-11-11', to_date: '2026-11-15' }, 'tu_a'),
    toolUse('book_appointment', { slot_start: '2026-11-12T15:00:00Z', name: 'Sam' }, 'tu_b'),
    text("You're booked, Sam. See you Thursday!"),
  ]);
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'thursday works, im Sam')], host, context: ctx });
  assert.deepEqual(host.log, ['avail:2026-11-11..2026-11-15', 'book:2026-11-12T15:00:00Z:Sam']);
  assert.deepEqual(r.toolsUsed, ['check_availability', 'book_appointment']);
  assert.match(r.text ?? '', /booked/);
  // second call must contain the assistant tool_use followed by a user tool_result for the same id
  const second = llm.calls[1]!.messages;
  const last = second[second.length - 1]!;
  assert.equal(last.role, 'user');
  assert.ok(Array.isArray(last.content) && last.content[0]?.type === 'tool_result');
});

test('handoff tool: still sends the courtesy line, marks handedOff', async () => {
  const host = new FakeHost();
  const llm = new FakeLlm([
    { content: [{ type: 'text', text: 'So sorry about that.' }, { type: 'tool_use', id: 'h1', name: 'handoff_to_human', input: { reason: 'refund request', urgency: 'high' } }], stopReason: 'tool_use' },
    text("I'm getting someone from the team to help you right away."),
  ]);
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'I want a refund NOW')], host, context: ctx });
  assert.equal(r.handedOff, true);
  assert.ok(host.log.includes('handoff:high:refund request'));
  assert.ok(r.text);
});

test('do-not-contact tool suppresses any reply', async () => {
  const llm = new FakeLlm([toolUse('mark_do_not_contact', { reason: 'asked to stop' }), text('Okay, sorry to bother you!')]);
  const host = new FakeHost();
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'please stop')], host, context: ctx });
  assert.equal(r.text, null);
  assert.equal(r.dnc, true);
});

test('invented price is blocked by the guard and escalated, never sent', async () => {
  const host = new FakeHost();
  const llm = new FakeLlm([text("It's only $199 if you sign up today!")]);
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'price?')], host, context: ctx });
  assert.equal(r.text, null);
  assert.equal(r.handedOff, true);
  assert.match(host.log.find((l) => l.startsWith('handoff')) ?? '', /unknown_price/);
});

test('empty model output escalates instead of silently dropping the lead', async () => {
  const host = new FakeHost();
  const r = await runTurn({ llm: new FakeLlm([{ content: [], stopReason: 'end_turn' }]), client: makeClient(), history: [t('in', 'hi')], host, context: ctx });
  assert.equal(r.text, null);
  assert.ok(host.log.some((l) => l.includes('model_returned_no_message')));
});

test('follow-up mode offers no tools and appends the nudge instruction', async () => {
  const llm = new FakeLlm([text('Still thinking it over? Happy to answer anything.')]);
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'maybe'), t('out', 'Totally, no rush.')], host: new FakeHost(), context: ctx, mode: 'followup', followupNumber: 1 });
  assert.ok(r.text);
  assert.equal(llm.calls[0]?.tools, undefined);
  const last = llm.calls[0]!.messages.at(-1)!;
  assert.match(String(last.content), /gone quiet/);
});

test('link-mode clients never get calendar tools; large KBs get search_knowledge', async () => {
  const llm = new FakeLlm([text('Sure, send me your email?')]);
  await runTurn({ llm, client: makeClient({ calendarProvider: 'link' }), history: [t('in', 'hi')], host: new FakeHost(), context: ctx });
  const names = llm.calls[0]!.tools!.map((x) => x.name);
  assert.ok(!names.includes('book_appointment') && !names.includes('check_availability') && !names.includes('search_knowledge'));

  const llm2 = new FakeLlm([text('Let me check.')]);
  await runTurn({ llm: llm2, client: makeClient({ knowledge: 'x'.repeat(40_000) }), history: [t('in', 'hi')], host: new FakeHost(), context: ctx });
  assert.ok(llm2.calls[0]!.tools!.some((x) => x.name === 'search_knowledge'));
});

test('model that never stops calling tools is cut off after maxIters and escalated', async () => {
  const llm = new FakeLlm(Array.from({ length: 6 }, (_, i) => toolUse('check_availability', { from_date: 'a', to_date: 'b' }, `tu_${i}`)));
  const host = new FakeHost();
  const r = await runTurn({ llm, client: makeClient(), history: [t('in', 'hi')], host, context: ctx, maxIters: 3 });
  assert.equal(r.text, null);
  assert.equal(r.handedOff, true);
});
