import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import * as repo from '../repo.js';
import type { ClientSettings } from '../types.js';
import { config } from '../config.js';

// =====================================================================================
// Clients page: create and edit a business with a form. This touches client ROWS only —
// it never edits the prompt template or any conversation logic.
// =====================================================================================

const SettingsInput = z.object({
  businessSummary: z.string().max(2000).optional(),
  offer: z.string().max(2000).optional(),
  idealCustomer: z.string().max(2000).optional(),
  disqualifiers: z.array(z.string().max(500)).max(30).optional(),
  qualificationQuestions: z.array(z.string().max(500)).max(30).optional(),
  tone: z.string().max(1000).optional(),
  forbiddenClaims: z.array(z.string().max(300)).max(30).optional(),
  bookingLink: z.string().url().max(500).nullable().optional(),
  languages: z.array(z.string().max(40)).max(10).optional(),
});

export const CreateClientInput = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().max(60).default('America/Toronto'),
  platformApiKey: z.string().min(1).max(500),
  instagramAccountId: z.string().min(1).max(200),
  settings: SettingsInput,
  knowledge: z.string().max(200_000).default(''),
  status: z.enum(['pilot', 'active', 'paused']).default('pilot'),
});

export const EditClientInput = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().max(60).optional(),
  platformApiKey: z.string().max(500).optional(),
  instagramAccountId: z.string().max(200).optional(),
  settings: SettingsInput.optional(),
  knowledge: z.string().max(200_000).optional(),
  status: z.enum(['pilot', 'active', 'paused']).optional(),
});

const mergeSettings = (current: ClientSettings, patch: z.infer<typeof SettingsInput>): ClientSettings => ({
  businessSummary: patch.businessSummary ?? current.businessSummary ?? '',
  offer: patch.offer ?? current.offer ?? '',
  idealCustomer: patch.idealCustomer ?? current.idealCustomer ?? '',
  disqualifiers: patch.disqualifiers ?? current.disqualifiers ?? [],
  qualificationQuestions: patch.qualificationQuestions ?? current.qualificationQuestions ?? [],
  tone: patch.tone ?? current.tone ?? '',
  forbiddenClaims: patch.forbiddenClaims ?? current.forbiddenClaims ?? [],
  bookingLink: patch.bookingLink === undefined ? current.bookingLink : (patch.bookingLink ?? undefined),
  languages: patch.languages ?? current.languages,
});

export async function createClient(input: z.infer<typeof CreateClientInput>) {
  const s = input.settings;
  // Required prompt fields must exist or the AI would greet the first lead with blanks.
  for (const [k, v] of Object.entries(s) as Array<[keyof typeof s, unknown]>) {
    if ((k === 'businessSummary' || k === 'offer' || k === 'idealCustomer' || k === 'tone') && (!v || !(v as string).trim())) {
      return { error: `${k} is required — the AI reads it on every conversation.` };
    }
  }
  const secret = randomBytes(24).toString('hex');
  const defaults = { disqualifiers: [], qualificationQuestions: [], forbiddenClaims: [], languages: [] } as Partial<ClientSettings>;
  const settings = { ...defaults, ...s, bookingLink: s.bookingLink ?? undefined } as ClientSettings;
  const row = await q1<{ id: string }>(
    `INSERT INTO clients (name, status, timezone, webhook_secret, platform_api_key, instagram_account_id, settings, knowledge)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [input.name, input.status, input.timezone, secret, input.platformApiKey, input.instagramAccountId, JSON.stringify(settings), input.knowledge],
  );
  return { id: row?.id, webhookSecret: secret };
}

export async function updateClient(id: string, input: z.infer<typeof EditClientInput>) {
  const c = await repo.getClient(id);
  if (!c) return { error: 'not_found' };
  const settings = input.settings ? mergeSettings(c.settings, input.settings) : c.settings;
  await q(
    `UPDATE clients SET
       name = COALESCE($2, name), timezone = COALESCE($3, timezone), platform_api_key = COALESCE($4, platform_api_key),
       instagram_account_id = COALESCE($5, instagram_account_id), settings = $6, knowledge = COALESCE($7, knowledge),
       status = COALESCE($8, status)
     WHERE id = $1`,
    [id, input.name ?? null, input.timezone ?? null, input.platformApiKey ?? null, input.instagramAccountId ?? null,
     JSON.stringify(settings), input.knowledge ?? null, input.status ?? null],
  );
  return { ok: true };
}

/** Everything the Clients / AI Studio forms need, including the webhook URLs to paste into InstantDM. */
export async function fullClient(id: string) {
  const c = await repo.getClient(id);
  if (!c) return null;
  const base = config.publicBaseUrl;
  return {
    id: c.id, name: c.name, status: c.status, timezone: c.timezone,
    platformApiKey: c.platformApiKey, instagramAccountId: c.instagramAccountId,
    settings: c.settings, knowledge: c.knowledge,
    webhookUrl: `${base}/webhooks/instantdm/${c.id}?token=${c.webhookSecret}`,
    calendarWebhookUrl: `${base}/webhooks/calendar/${c.id}?token=${c.webhookSecret}`,
    launchedAt: c.launchedAt instanceof Date ? c.launchedAt.toISOString() : String(c.launchedAt),
  };
}
