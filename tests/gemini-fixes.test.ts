// Part 2: dedupe keys, ignored envelopes, and the Gemini 3.x request fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventKey, mapPayload } from '../src/platform/instantdm.js';
import { GeminiLlm, toGeminiContents } from '../src/ai/llm.js';

test('dedupe keys come from mid / comment id inside the envelope', () => {
  const dm = {
    object: 'instagram',
    entry: [{
      time: 1,
      id: 'a',
      messaging: [{
        sender: { id: 's' },
        recipient: { id: 'r' },
        timestamp: 2,
        message: { mid: 'MID1', text: 'x' },
      }],
    }],
  };
  assert.equal(eventKey(dm), 'MID1');
  // duplicate delivery of the same envelope -> same key
  assert.equal(eventKey(dm), eventKey(JSON.parse(JSON.stringify(dm))));

  const commentEnvelope = {
    object: 'instagram',
    entry: [{
      id: 'a',
      time: 1,
      changes: [{
        field: 'comments',
        value: { id: 'C1', text: 'x', from: { id: 'f' } },
      }],
    }],
  };
  assert.equal(eventKey(commentEnvelope), 'comment:C1');
});

test('read receipts / empty messaging items are ignored, not flagged unmatched', () => {
  const read = {
    object: 'instagram',
    entry: [{
      id: 'a',
      time: 1,
      messaging: [{
        sender: { id: 's' },
        recipient: { id: 'r' },
        timestamp: 2,
        read: { watermark: 3 },
      }],
    }],
  };
  assert.equal(mapPayload(read)[0]?.type, 'ignored');
});

// ---------- Gemini 3.x behaviour ----------

test('Gemini 3.x: no thinkingConfig, signature bypass on replayed tool calls, headroom for thinking tokens', async () => {
  let seen: { generationConfig?: Record<string, unknown> } | null = null;
  const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }) };
  };
  const llm = new GeminiLlm(undefined, 'k', 'gemini-3.5-flash-lite', f as never);
  await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 400, kind: 'converse' });
  assert.equal('thinkingConfig' in (seen!.generationConfig ?? {}), false);   // the 400 fix
  assert.ok((seen!.generationConfig!.maxOutputTokens as number) >= 1500);   // thinking-token headroom

  // Replayed functionCall parts carry Google's documented bypass signature on 3.x.
  const withSig = toGeminiContents([
    { role: 'user', content: 'book it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'book_appointment', input: {} }] },
  ], { signToolCalls: true });
  assert.equal(withSig[1]!.parts[0]!.thoughtSignature, 'skip_thought_signature_validator');

  // 2.5-shaped replay stays signature-free (unchanged behaviour).
  const noSig = toGeminiContents([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'book_appointment', input: {} }] },
  ]);
  assert.equal(noSig[0]!.parts[0]!.thoughtSignature, undefined);
});

test('Gemini 2.5 Flash keeps thinkingBudget 0; Pro and 3.x never get it', async () => {
  let seen: { generationConfig?: Record<string, unknown> } | null = null;
  const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }) };
  };
  await new GeminiLlm(undefined, 'k', 'gemini-2.5-flash', f as never).complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 400, kind: 'converse' });
  assert.deepEqual(seen!.generationConfig!.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(seen!.generationConfig!.maxOutputTokens, 400);

  await new GeminiLlm(undefined, 'k', 'gemini-2.5-pro', f as never).complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 400, kind: 'converse' });
  assert.equal('thinkingConfig' in seen!.generationConfig!, false);

  await new GeminiLlm(undefined, 'k', 'gemini-3.5-flash-lite', f as never).complete({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 400, kind: 'converse' });
  assert.equal('thinkingConfig' in seen!.generationConfig!, false);
});
