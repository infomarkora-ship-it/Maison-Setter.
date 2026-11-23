import test from 'node:test';
import assert from 'node:assert/strict';
import { InstantDmAdapter } from '../src/platform/instantdm.js';
import { PlatformError } from '../src/platform/types.js';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
function fake(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
  };
  return { f, calls };
}
const ctx = { apiKey: 'key-1', instagramAccountId: 'ig' };

test('sendDm posts the exact documented body to openapi.instantdm.com/action with a Bearer key', async () => {
  const { f, calls } = fake(200, { success: true, message_id: 'mid-9' });
  const r = await new InstantDmAdapter(f).sendDm(ctx, '42', 'Hello!');
  assert.equal(r.messageId, 'mid-9');
  assert.equal(calls[0]!.url, 'https://openapi.instantdm.com/action');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers.Authorization, 'Bearer key-1');
  assert.equal(calls[0]!.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0]!.init.body), { action: 'send_message', type: 'dm', recipient_id: '42', message: { text: 'Hello!' } });
});

test('429 is retryable and carries Retry-After; 5xx retryable; 4xx not', async () => {
  const rl = await new InstantDmAdapter(fake(429, 'slow down', { 'retry-after': '30' }).f).sendDm(ctx, '1', 'x').catch((e) => e);
  assert.ok(rl instanceof PlatformError && rl.retryable && rl.retryAfterMs === 30_000);
  const s5 = await new InstantDmAdapter(fake(503, 'down').f).sendDm(ctx, '1', 'x').catch((e) => e);
  assert.ok(s5 instanceof PlatformError && s5.retryable);
  const s4 = await new InstantDmAdapter(fake(400, 'bad').f).sendDm(ctx, '1', 'x').catch((e) => e);
  assert.ok(s4 instanceof PlatformError && !s4.retryable);
});

test('a 2xx that carries an error body is NOT treated as sent (no silent drops)', async () => {
  const rejected = await new InstantDmAdapter(fake(200, { success: false, error: 'recipient not reachable' }).f).sendDm(ctx, '1', 'x').catch((e) => e);
  assert.ok(rejected instanceof PlatformError && !rejected.retryable && /not reachable/.test(rejected.message));
  const transient = await new InstantDmAdapter(fake(200, { error: 'Too many requests, try again' }).f).sendDm(ctx, '1', 'x').catch((e) => e);
  assert.ok(transient instanceof PlatformError && transient.retryable);
});

test('network failures and a missing key surface as errors', async () => {
  const boom = new InstantDmAdapter(async () => { throw new Error('ECONNRESET'); });
  const e1 = await boom.sendDm(ctx, '1', 'x').catch((e) => e);
  assert.ok(e1 instanceof PlatformError && e1.retryable && e1.status === 0);
  const e2 = await new InstantDmAdapter(fake(200, {}).f).sendDm({ apiKey: '', instagramAccountId: 'ig' }, '1', 'x').catch((e) => e);
  assert.ok(e2 instanceof PlatformError && !e2.retryable);
});

test('public comment reply uses the exact post_comment body; private reply the exact comment_reply body', async () => {
  const a = fake(200, { success: true, recipient_id: '77', message_id: 'p1' });
  const ad = new InstantDmAdapter(a.f);
  await ad.replyToComment(ctx, 'c1', 'Thanks for your comment!');
  assert.equal(a.calls[0]!.url, 'https://openapi.instantdm.com/action');
  assert.deepEqual(JSON.parse(a.calls[0]!.init.body), { action: 'post_comment', comment_id: 'c1', comment_text: 'Thanks for your comment!' });

  // Private reply to a comment: exact docs format — action send_message, type comment_reply, message is an object.
  const pr = await ad.sendPrivateReply(ctx, 'c1', 'Hello!');
  assert.equal(a.calls[1]!.url, 'https://openapi.instantdm.com/action');
  assert.deepEqual(JSON.parse(a.calls[1]!.init.body),
    { action: 'send_message', type: 'comment_reply', comment_id: 'c1', message: { text: 'Hello!' } });
  assert.equal(pr.recipientId, '77');
});

test('long DM text is never truncated or reshaped: message.text carries the full bubble verbatim', async () => {
  const { f, calls } = fake(200, { success: true });
  const text = 'hey! '.padEnd(480, 'x');
  await new InstantDmAdapter(f).sendDm(ctx, '42', text);
  const body = JSON.parse(calls[0]!.init.body);
  assert.equal((body as { message: { text: string } }).message.text.length, 480);
});

// ---------- Gemini provider ----------
import { GeminiLlm, toGeminiContents } from '../src/ai/llm.js';

test('Gemini: request shape, tool-call mapping, usage', async () => {
  let seen: { url: string; headers: Record<string, string>; body: any } | null = null;
  const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'submit', args: { a: 1 } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) };
  };
  let cost = -1;
  const llm = new GeminiLlm((u) => { cost = u.costUsd; }, 'k', 'gemini-2.5-flash', f as never);
  const r = await llm.complete({
    system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, kind: 'classify',
    tools: [{ name: 'submit', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false } as never }],
    toolChoice: { type: 'tool', name: 'submit' },
  });
  assert.match(seen!.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(seen!.headers['x-goog-api-key'], 'k');
  assert.equal(seen!.body.systemInstruction.parts[0].text, 'sys');
  assert.deepEqual(seen!.body.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['submit'] });
  assert.equal('additionalProperties' in seen!.body.tools[0].functionDeclarations[0].parameters, false);
  assert.equal(r.stopReason, 'tool_use');
  assert.deepEqual(r.content[0] && r.content[0].type === 'tool_use' ? r.content[0].input : null, { a: 1 });
  assert.deepEqual(r.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.equal(cost, 0);
});

test('Gemini: tool results are matched back to the function by name; errors surface', async () => {
  const c = toGeminiContents([
    { role: 'user', content: 'book it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'book_call', input: { x: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]);
  assert.equal(c[1]!.role, 'model');
  assert.deepEqual(c[2]!.parts[0], { functionResponse: { name: 'book_call', response: { result: 'ok' } } });
  const bad = new GeminiLlm(undefined, 'k', 'gemini-2.5-flash', (async () => ({ ok: false, status: 429, text: async () => 'quota' })) as never);
  await assert.rejects(() => bad.complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, kind: 'converse' }), /Gemini 429/);
});
