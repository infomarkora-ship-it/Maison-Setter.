import { z } from 'zod';
import type { Llm, ToolDef } from './llm.js';
import type { Client } from '../types.js';
import { classifierSystemPrompt, openerSystemPrompt, triageSystemPrompt } from './prompts.js';
import { guardReply } from '../guard.js';

export async function forced<T extends z.ZodTypeAny>(
  llm: Llm, kind: string, client: Client, system: string, user: string, tool: ToolDef, schema: T,
): Promise<z.infer<T> | null> {
  const res = await llm.complete({
    system, kind, clientId: client.id, maxTokens: 500,
    messages: [{ role: 'user', content: user }],
    tools: [tool], toolChoice: { type: 'tool', name: tool.name },
  });
  const use = res.content.find((b) => b.type === 'tool_use');
  if (!use || use.type !== 'tool_use') return null;
  const parsed = schema.safeParse(use.input);
  return parsed.success ? parsed.data : null;
}

// ---- comment classification ----
export const CommentVerdict = z.object({
  decision: z.enum(['engage', 'ignore', 'flag']),
  intent_score: z.number().min(0).max(100),
  fit_score: z.number().min(0).max(100),
  reason: z.string(),
});
export type CommentVerdict = z.infer<typeof CommentVerdict>;

const commentTool: ToolDef = {
  name: 'submit', description: 'Submit the verdict.',
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['engage', 'ignore', 'flag'] },
      intent_score: { type: 'number' }, fit_score: { type: 'number' }, reason: { type: 'string' },
    },
    required: ['decision', 'intent_score', 'fit_score', 'reason'],
  },
};

/** Returns null on any model/parse failure; callers treat null as "ignore" (fail closed). */
export function classifyComment(llm: Llm, client: Client, a: { caption?: string | null; text: string }) {
  return forced(llm, 'classify', client, classifierSystemPrompt(client),
    `Post caption: ${a.caption?.slice(0, 500) || '(none)'}\nComment: ${a.text.slice(0, 600)}`, commentTool, CommentVerdict);
}

// ---- first-DM triage ----
export const TriageVerdict = z.object({
  category: z.enum(['buying_inquiry', 'support', 'spam', 'vendor_pitch', 'personal_or_complaint', 'other']),
  reason: z.string(),
});
export type TriageVerdict = z.infer<typeof TriageVerdict>;

const triageTool: ToolDef = {
  name: 'submit', description: 'Submit the category.',
  input_schema: {
    type: 'object',
    properties: { category: { type: 'string', enum: ['buying_inquiry', 'support', 'spam', 'vendor_pitch', 'personal_or_complaint', 'other'] }, reason: { type: 'string' } },
    required: ['category', 'reason'],
  },
};

export function triageDm(llm: Llm, client: Client, text: string) {
  return forced(llm, 'triage', client, triageSystemPrompt(client), `First DM: ${text.slice(0, 800)}`, triageTool, TriageVerdict);
}

// ---- comment opener ----
const OpenerOut = z.object({ opener: z.string().min(5), public_reply: z.string().min(2) });
const openerTool: ToolDef = {
  name: 'submit', description: 'Submit the opener DM and the public reply.',
  input_schema: { type: 'object', properties: { opener: { type: 'string' }, public_reply: { type: 'string' } }, required: ['opener', 'public_reply'] },
};

export async function generateOpener(llm: Llm, client: Client, a: { caption?: string | null; text: string }) {
  const out = await forced(llm, 'opener', client, openerSystemPrompt(client),
    `Post caption: ${a.caption?.slice(0, 500) || '(none)'}\nTheir comment: ${a.text.slice(0, 600)}`, openerTool, OpenerOut);
  if (!out) return null;
  const dm = guardReply(out.opener, client);
  if (!dm.ok || dm.cleaned.length > 320) return null;       // fail closed: skip rather than send something off
  const pub = out.public_reply.trim().replace(/https?:\/\/\S+/g, '').slice(0, 80);
  return { opener: dm.cleaned, publicReply: pub };
}
