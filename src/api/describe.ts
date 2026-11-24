import { z } from 'zod';
import type { Llm, ToolDef } from '../ai/llm.js';
import * as repo from '../repo.js';
import { aiErrorMessage } from './friendly.js';
import type { Client } from '../types.js';

// =====================================================================================
// Describe-it box (AI Studio): the operator types what they want in plain words, the
// model proposes exact setting changes, the dashboard shows before/after and the
// operator presses Apply. ONLY the settings the AI reads can change — never the
// prompt template, the tools, the guard, the modes or any other logic.
// =====================================================================================

/** The complete, closed list of editable fields. Anything else the model returns is dropped. */
const FIELD_LABELS: Record<string, string> = {
  tone: 'How the AI talks (tone)',
  offer: 'What we book people in for',
  idealCustomer: 'Who is a great fit',
  businessSummary: 'What the business does',
  disqualifiers: 'Not a fit (politely disqualify)',
  qualificationQuestions: 'Things to find out before booking',
  forbiddenClaims: 'Things the AI must never say',
  knowledge: 'Facts file (knowledge base)',
  bookingLink: 'Booking link',
};

const Str = z.string().max(20_000);
const ChangesSchema = z.object({
  changes: z.array(z.object({
    field: z.enum(Object.keys(FIELD_LABELS) as [string, ...string[]]),
    value: z.union([Str, z.array(Str).max(40), z.null()]),
    explanation: z.string().max(400).default(''),
  })).max(9).default([]),
  summary: z.string().max(600).default(''),
});

const changesTool: ToolDef = {
  name: 'submit_changes',
  description: 'Submit the setting changes. Only fields from the ALLOWED list. Value replaces the whole field.',
  input_schema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: Object.keys(FIELD_LABELS) },
            value: { type: 'string', description: 'string for single-value fields; array of strings for list fields; null to clear the booking link' },
            explanation: { type: 'string', description: 'one short sentence: why this change matches what the operator asked' },
          },
          required: ['field', 'value'],
        },
      },
      summary: { type: 'string', description: 'one short paragraph describing the overall change in plain words' },
    },
    required: ['changes', 'summary'],
  },
};

const DESCRIBE_SYSTEM = `You translate a business owner's plain-words requests into exact changes to their DM-assistant settings. The settings feed the assistant's behaviour (tone, offer, rules, facts). You never change how the assistant is built — only these setting fields.
ALLOWED fields: ${Object.keys(FIELD_LABELS).join(', ')}.
Rules:
- Only propose changes the owner actually asked for. If their request is vague, make the most reasonable concrete version and explain it in one sentence.
- tone: a short description like "friendly, casual, a bit of humour" plus any standing instructions that belong to tone (e.g. "never mention price first").
- forbiddenClaims: list of exact phrases/claims the assistant must never say. Merge sensibly with the intent of the request.
- disqualifiers / qualificationQuestions: arrays of short strings. Merge with existing entries when the owner says "add"; replace when they say "make it" / "change it to".
- knowledge: the full replacement facts text. Keep every still-true fact from the current text and fold in the request.
- bookingLink: full URL, or null to remove.
- value is the COMPLETE new value for the field, not a delta.
Call submit_changes once.`;

export interface DescribeChange { field: string; label: string; before: string; after: string; afterRaw: string | string[] | null; explanation: string }
export interface DescribeResult { summary: string; changes: DescribeChange[]; usedModel: boolean }

const asText = (v: unknown): string => Array.isArray(v) ? v.map((x) => `- ${String(x)}`).join('\n') : String(v ?? '');
const norm = (v: unknown): string => asText(v).trim();

export function diffChanges(client: Client, parsed: z.infer<typeof ChangesSchema>): DescribeChange[] {
  const s = client.settings;
  const out: DescribeChange[] = [];
  for (const c of parsed.changes) {
    if (!(c.field in FIELD_LABELS)) continue;                    // not in the closed list: dropped
    if (c.field === 'bookingLink') {
      const before = s.bookingLink ?? '';
      const after = c.value === null ? '' : String(c.value);
      if (norm(before) !== norm(after)) out.push({ field: c.field, label: FIELD_LABELS[c.field] ?? c.field, before, after, afterRaw: c.value, explanation: c.explanation });
      continue;
    }
    const before = (s as unknown as Record<string, unknown>)[c.field];
    const after = c.value;
    if (norm(before) === norm(after)) continue;                 // no-op change: dropped
    if (c.field === 'knowledge' && typeof after === 'string') {
      out.push({ field: c.field, label: FIELD_LABELS[c.field] ?? c.field, before: norm(before), after, afterRaw: after, explanation: c.explanation });
      continue;
    }
    out.push({ field: c.field, label: FIELD_LABELS[c.field] ?? c.field, before: norm(before), after: asText(after), afterRaw: after, explanation: c.explanation });
  }
  return out;
}

export async function describeChanges(llm: Llm | null, client: Client, request: string): Promise<DescribeResult> {
  if (!llm) return { summary: 'No AI model is configured, so the describe-it box cannot draft changes. Edit the fields directly below.', changes: [], usedModel: false };
  const s = client.settings;
  const current = Object.keys(FIELD_LABELS).map((f) => {
    const v = f === 'bookingLink' ? (s.bookingLink ?? '(none)') : norm((s as unknown as Record<string, unknown>)[f]) || '(empty)';
    return `### ${f}\n${v.slice(0, 4000)}`;
  }).join('\n\n');
  const user = `WHAT THE OWNER WANTS:
${request.slice(0, 2000)}

CURRENT SETTINGS
${current}`;
  const res = await llm.complete({
    system: DESCRIBE_SYSTEM, kind: 'describe', clientId: client.id, maxTokens: 1500,
    messages: [{ role: 'user', content: user }], tools: [changesTool], toolChoice: { type: 'tool', name: 'submit_changes' },
  });
  const use = res.content.find((b) => b.type === 'tool_use');
  if (!use || use.type !== 'tool_use') return { summary: 'The AI could not draft changes this time — try rephrasing, or edit the fields directly.', changes: [], usedModel: true };
  const parsed = ChangesSchema.safeParse(use.input);
  if (!parsed.success) return { summary: 'The AI proposed something the settings cannot express — try rephrasing.', changes: [], usedModel: true };
  return { summary: parsed.data.summary, changes: diffChanges(client, parsed.data), usedModel: true };
}

export function describeError(e: unknown): { error: string; message: string } {
  return aiErrorMessage(e);
}

/** Apply = the same settings PATCH the normal edit form uses, so there is exactly one write path. */
export async function applyFieldValues(clientId: string, changes: Array<{ field: string; value: string | string[] | null }>): Promise<{ applied: number }> {
  const c = await repo.getClient(clientId);
  if (!c) return { applied: 0 };
  const s: Record<string, unknown> = { ...c.settings };
  let knowledge = c.knowledge;
  let bookingLink: string | undefined | null = c.settings.bookingLink;
  let applied = 0;
  for (const ch of changes) {
    if (!(ch.field in FIELD_LABELS)) continue;
    if (ch.field === 'knowledge') { if (typeof ch.value === 'string') { knowledge = ch.value; applied++; } continue; }
    if (ch.field === 'bookingLink') { bookingLink = ch.value === null ? undefined : String(ch.value); applied++; continue; }
    if (s[ch.field] === undefined && !['tone', 'offer', 'idealCustomer', 'businessSummary'].includes(ch.field)) continue;
    s[ch.field] = Array.isArray(ch.value) ? ch.value.map(String) : String(ch.value);
    applied++;
  }
  const settings = { ...s, bookingLink: bookingLink ?? undefined } as typeof c.settings;
  await repo.updateClientSettings(clientId, settings, knowledge);
  return { applied };
}
