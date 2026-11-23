import { z } from 'zod';
import type { ToolDef } from './llm.js';
import type { Client, ConversationState, ToolHost } from '../types.js';
import { MODEL_SETTABLE } from '../state.js';

export function toolDefs(c: Pick<Client, 'calendarProvider' | 'knowledge'>, kbInline: boolean): ToolDef[] {
  const t: ToolDef[] = [];
  if (!kbInline) {
    t.push({
      name: 'search_knowledge',
      description: "Search the business's knowledge base. Use for any factual question about the business.",
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    });
  }
  if (c.calendarProvider !== 'link') {
    t.push({
      name: 'check_availability',
      description: 'List open appointment times between two ISO dates. Call before offering times.',
      input_schema: {
        type: 'object',
        properties: { from_date: { type: 'string', description: 'ISO date or datetime' }, to_date: { type: 'string', description: 'ISO date or datetime' } },
        required: ['from_date', 'to_date'],
      },
    });
    t.push({
      name: 'book_appointment',
      description: 'Book an appointment at one of the times returned by check_availability.',
      input_schema: {
        type: 'object',
        properties: {
          slot_start: { type: 'string', description: 'ISO datetime exactly as returned by check_availability' },
          name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' },
        },
        required: ['slot_start', 'name'],
      },
    });
  }
  t.push(
    {
      name: 'update_lead_status',
      description: 'Record where this lead is in the conversation.',
      input_schema: {
        type: 'object',
        properties: { status: { type: 'string', enum: MODEL_SETTABLE }, reason: { type: 'string', description: 'One short sentence of what you learned about them' } },
        required: ['status', 'reason'],
      },
    },
    {
      name: 'handoff_to_human',
      description: 'Pass this conversation to the business owner. Use when unsure, upset customers, complaints, safety issues, or anything outside the knowledge base.',
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string' }, urgency: { type: 'string', enum: ['low', 'high'] } },
        required: ['reason', 'urgency'],
      },
    },
    {
      name: 'mark_do_not_contact',
      description: 'The person asked to stop being messaged, or is clearly hostile. Never message them again.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  );
  return t;
}

const schemas = {
  search_knowledge: z.object({ query: z.string().min(1) }),
  check_availability: z.object({ from_date: z.string(), to_date: z.string() }),
  book_appointment: z.object({
    slot_start: z.string(), name: z.string().min(1),
    email: z.string().optional(), phone: z.string().optional(), notes: z.string().optional(),
  }),
  update_lead_status: z.object({ status: z.enum(MODEL_SETTABLE as [ConversationState, ...ConversationState[]]), reason: z.string() }),
  handoff_to_human: z.object({ reason: z.string(), urgency: z.enum(['low', 'high']) }),
  mark_do_not_contact: z.object({ reason: z.string() }),
};

export interface ToolOutcome { content: string; isError: boolean; handoff?: boolean; dnc?: boolean }

export async function executeTool(host: ToolHost, name: string, input: unknown): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'search_knowledge': {
        const a = schemas.search_knowledge.parse(input);
        return { content: (await host.searchKnowledge(a.query)) || 'No matching information found. If you are unsure, call handoff_to_human.', isError: false };
      }
      case 'check_availability': {
        const a = schemas.check_availability.parse(input);
        const slots = await host.checkAvailability(a.from_date, a.to_date);
        return { content: slots.length ? `Open times (ISO): ${slots.join(', ')}` : 'No open times in that range. Try a wider range.', isError: false };
      }
      case 'book_appointment': {
        const a = schemas.book_appointment.parse(input);
        const r = await host.book({ startIso: a.slot_start, name: a.name, email: a.email, phone: a.phone, notes: a.notes });
        return { content: r.message, isError: !r.ok };
      }
      case 'update_lead_status': {
        const a = schemas.update_lead_status.parse(input);
        return { content: await host.updateStatus(a.status, a.reason), isError: false };
      }
      case 'handoff_to_human': {
        const a = schemas.handoff_to_human.parse(input);
        return { content: await host.handoff(a.reason, a.urgency), isError: false, handoff: true };
      }
      case 'mark_do_not_contact': {
        const a = schemas.mark_do_not_contact.parse(input);
        return { content: await host.markDoNotContact(a.reason), isError: false, dnc: true };
      }
      default:
        return { content: `Unknown tool ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message}`, isError: true };
  }
}
