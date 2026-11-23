import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { q1, closePool } from '../src/db.js';

// Usage: npm run create-client -- clients/acme.json
const Input = z.object({
  name: z.string(),
  timezone: z.string().default('America/Toronto'),
  platformApiKey: z.string(),
  instagramAccountId: z.string(),
  settings: z.object({
    businessSummary: z.string(), offer: z.string(), idealCustomer: z.string(),
    disqualifiers: z.array(z.string()).default([]), qualificationQuestions: z.array(z.string()).default([]),
    tone: z.string(), forbiddenClaims: z.array(z.string()).default([]), bookingLink: z.string().url().optional(),
  }),
  knowledge: z.string().default(''),
  commissionRate: z.number().min(0).max(1).default(0.2),
  attributionDays: z.number().int().default(45),
  openerDailyMax: z.number().int().default(50),
  minIntentScore: z.number().int().default(60),
  notifyWebhookUrl: z.string().url().optional(),
  calendarProvider: z.enum(['link', 'cal_com', 'mock']).default('link'),
  calendarConfig: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['pilot', 'active', 'paused']).default('pilot'),
  defaultMode: z.enum(['qualify_and_book', 'soft_nurture', 'direct_closer', 'noshow_recovery', 'paused_human']).default('qualify_and_book'),
  minCommentDmScore: z.number().int().min(0).max(100).default(0),
  maxCommentDmsPerDay: z.number().int().min(0).nullable().default(null),
  commentDmMinGapMinutes: z.number().int().min(2).default(2),
  lowScoreAction: z.enum(['review', 'public_reply_only', 'skip']).default('review'),
  humanPauseHours: z.number().int().min(1).default(24),
  instantdmWebhookSecret: z.string().optional(),
});

const file = process.argv[2];
if (!file) { console.error('Usage: npm run create-client -- clients/<file>.json'); process.exit(1); }
const c = Input.parse(JSON.parse(readFileSync(file, 'utf8')));
const secret = randomBytes(24).toString('hex');

const row = await q1<{ id: string }>(
  `INSERT INTO clients (name, status, timezone, webhook_secret, platform_api_key, instagram_account_id, settings, knowledge,
     commission_rate, attribution_days, opener_daily_max, min_intent_score, notify_webhook_url, calendar_provider, calendar_config,
     default_mode, min_comment_dm_score, max_comment_dms_per_day, comment_dm_min_gap_minutes, low_score_action, human_pause_hours, instantdm_webhook_secret)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
  [c.name, c.status, c.timezone, secret, c.platformApiKey, c.instagramAccountId, JSON.stringify(c.settings), c.knowledge,
   c.commissionRate, c.attributionDays, c.openerDailyMax, c.minIntentScore, c.notifyWebhookUrl ?? null, c.calendarProvider, JSON.stringify(c.calendarConfig),
   c.defaultMode, c.minCommentDmScore, c.maxCommentDmsPerDay, c.commentDmMinGapMinutes, c.lowScoreAction, c.humanPauseHours, c.instantdmWebhookSecret ?? null],
);
const base = process.env.PUBLIC_BASE_URL ?? 'https://YOUR-APP-URL';
console.log(`Client created: ${row?.id}`);
console.log(`Webhook URL for InstantDM:\n  ${base}/webhooks/instantdm/${row?.id}?token=${secret}`);
console.log(`Calendar / CRM webhook URL (booked, rescheduled, canceled, completed, no-show):\n  ${base}/webhooks/calendar/${row?.id}?token=${secret}`);
console.log(`Dashboard: ${base}/dashboard`);
await closePool();
