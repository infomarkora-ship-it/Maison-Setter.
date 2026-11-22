import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { authorizeWebhook } from './platform/signature.js';
import { calendarEventKey, applyCallStatus } from './booking.js';
import { approveReviewedComment } from './handlers/comments.js';
import { askAboutThread, loadBotThread } from './handlers/contextbot.js';
import { buildMilestones } from './contextbot.js';
import { createLlm, type Llm } from './ai/llm.js';
import { isCallStatus } from './state.js';
import { isOperatingMode, MODE_PROFILES, OPERATING_MODES } from './modes.js';
import { dashboardHtml } from './dashboard/page.js';
import { registerTestChat } from './testchat.js';
import { commentDmCap } from './scoring.js';
import { rampCap } from './pacing.js';
import { z } from 'zod';
import { config } from './config.js';
import * as repo from './repo.js';
import { enqueue } from './jobs.js';
import { eventKey } from './platform/instantdm.js';
import { q, q1 } from './db.js';

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

declare module 'fastify' { interface FastifyRequest { rawBody?: string } }

// Keep the exact bytes of every JSON body: the HMAC signature is computed over the raw body, never a re-serialized one.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  req.rawBody = text;
  if (!text) return done(null, {});
  try { done(null, JSON.parse(text)); } catch (e) { (e as Error & { statusCode?: number }).statusCode = 400; done(e as Error, undefined); }
});

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Tiny TTL cache so each webhook doesn't need its own DB round-trip for the secret.
const secretCache = new Map<string, { secret: string; signingSecret: string; paused: boolean; at: number }>();
async function clientAuth(id: string) {
  const hit = secretCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const c = await repo.getClient(id);
  if (!c) return null;
  const v = { secret: c.webhookSecret, signingSecret: c.instantdmWebhookSecret || config.instantDmWebhookSecret, paused: c.status === 'paused', at: Date.now() };
  secretCache.set(id, v);
  return v;
}

app.get('/health', async () => {
  await q('SELECT 1');
  return { ok: true };
});

/**
 * InstantDM calls this for every event. Bare minimum here: authenticate (HMAC signature over the raw body when a
 * secret is configured, else the per-client URL token), store the raw payload (deduped by event id), queue a job, return 200.
 * Nothing slow happens here: LLM, calendar and notification work all run in the worker.
 */
app.post<{ Params: { clientId: string }; Querystring: { token?: string } }>('/webhooks/instantdm/:clientId', async (req, reply) => {
  const { clientId } = req.params;
  if (!z.string().uuid().safeParse(clientId).success) return reply.code(404).send({ ok: false });
  const auth = await clientAuth(clientId);
  if (!auth) return reply.code(404).send({ ok: false });
  const sig = req.headers['x-webhook-signature'];
  const verdict = authorizeWebhook({
    rawBody: req.rawBody, signatureHeader: Array.isArray(sig) ? sig[0] : sig, token: req.query.token,
    urlToken: auth.secret, signingSecret: auth.signingSecret || undefined,
  });
  if (!verdict.ok) { req.log.warn({ reason: verdict.reason }, 'instantdm webhook rejected'); return reply.code(401).send({ ok: false }); }

  const items: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
  for (const item of items) {
    const id = await repo.insertRawEvent(clientId, eventKey(item), item);      // null = duplicate delivery: nothing queued
    if (id !== null && !auth.paused) await enqueue('process_event', { rawEventId: id }, { clientId });
  }
  return { ok: true };
});

/** Calendar / CRM webhook (Cal.com style or generic). Auth: the same per-client ?token=. Heavy work is queued. */
app.post<{ Params: { clientId: string }; Querystring: { token?: string } }>('/webhooks/calendar/:clientId', async (req, reply) => {
  const { clientId } = req.params;
  if (!z.string().uuid().safeParse(clientId).success) return reply.code(404).send({ ok: false });
  const auth = await clientAuth(clientId);
  if (!auth) return reply.code(404).send({ ok: false });
  if (!req.query.token || !safeEq(req.query.token, auth.secret)) return reply.code(401).send({ ok: false });
  const id = await repo.insertRawEvent(clientId, calendarEventKey(req.body), req.body);
  if (id !== null) await enqueue('calendar_event', { rawEventId: id }, { clientId });
  return { ok: true };
});

// ---------------- dashboard (static page; every data call below needs the bearer token) ----------------
app.get('/dashboard', async (_req, reply) =>
  reply.header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    .header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
    .send(dashboardHtml()));

let botLlm: Llm | null | undefined;
const getBotLlm = () => {
  if (botLlm === undefined) { try { botLlm = createLlm(); } catch { botLlm = null; } }
  return botLlm;
};

// ---------------- admin API (bearer token) ----------------
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token || !safeEq(token, config.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
});

const uuid = z.string().uuid();

app.post<{ Params: { id: string } }>('/api/conversations/:id/takeover', async (req) => {
  const id = uuid.parse(req.params.id);
  await repo.setTakeover(id, true); await repo.setPausedUntil(id, null);   // manual takeover: indefinite until handback
  await repo.cancelPendingSends(id); await repo.cancelPendingFollowups(id, 'manual_takeover');
  const conv = await repo.getConversation(id);
  if (conv) await repo.addThreadEvent(conv.clientId, id, 'human_takeover', { manual: true });
  return { ok: true };
});
app.post<{ Params: { id: string } }>('/api/conversations/:id/handback', async (req) => {
  const id = uuid.parse(req.params.id);
  const conv = await repo.getConversation(id);
  if (!conv) return { ok: false };
  await repo.setTakeover(id, false); await repo.setPausedUntil(id, null);
  if (conv.state === 'needs_human') await repo.setState(id, 'qualifying');
  await repo.addThreadEvent(conv.clientId, id, 'ai_resumed', { manual: true });
  await enqueue('plan_followup', { conversationId: id }, { clientId: conv.clientId, dedupeKey: `plan:${id}` });
  return { ok: true };
});

/** Record a closed sale. Commission = client.commission_rate x amount, only inside the attribution window. */
app.post('/api/sales', async (req, reply) => {
  const b = z.object({ conversationId: uuid, amountCents: z.number().int().positive(), note: z.string().optional() }).parse(req.body);
  const r = await repo.recordSale(b.conversationId, b.amountCents, b.note);
  if (!r) return reply.code(422).send({ error: 'conversation not found or outside the attribution window' });
  return { ok: true, saleId: r.id, commissionCents: Number(r.commissionCents) };
});

app.post<{ Params: { id: string } }>('/api/appointments/:id/outcome', async (req) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ status: z.enum(['confirmed', 'showed', 'no_show', 'cancelled']) }).parse(req.body);
  await q(`UPDATE appointments SET status = $2 WHERE id = $1`, [id, b.status]);
  // Keep the call monitor in step with manual outcomes.
  const map = { showed: 'call_completed', no_show: 'call_no_show', cancelled: 'call_canceled' } as const;
  const to = b.status === 'confirmed' ? null : map[b.status];
  const appt = await q1<{ conversationId: string }>(`SELECT conversation_id FROM appointments WHERE id = $1`, [id]);
  const conv = appt ? await repo.getConversation(appt.conversationId) : null;
  const client = conv ? await repo.getClient(conv.clientId) : null;
  if (to && conv && client) await applyCallStatus(conv, client, to, { source: 'dashboard', force: true });
  return { ok: true };
});

app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/api/clients/:id/funnel', async (req) =>
  repo.funnel(uuid.parse(req.params.id), Number(req.query.days ?? 30)));

app.get<{ Params: { id: string } }>('/api/clients/:id/usage', async (req) =>
  q(`SELECT kind, count(*)::int AS calls, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output, round(sum(cost_usd)::numeric, 4) AS cost_usd
     FROM usage_log WHERE client_id = $1 AND created_at > now() - interval '30 days' GROUP BY kind ORDER BY cost_usd DESC`, [uuid.parse(req.params.id)]));


// ---------------- dashboard API ----------------
const controlsSchema = z.object({
  defaultMode: z.enum(OPERATING_MODES as [string, ...string[]]).optional(),
  minCommentDmScore: z.number().int().min(0).max(100).optional(),
  maxCommentDmsPerDay: z.number().int().min(0).max(1000).nullable().optional(),
  commentDmMinGapMinutes: z.number().int().min(2).max(240).optional(),
  lowScoreAction: z.enum(['review', 'public_reply_only', 'skip']).optional(),
  humanPauseHours: z.number().int().min(1).max(168).optional(),
});

const publicClient = (c: NonNullable<Awaited<ReturnType<typeof repo.getClient>>>) => ({
  id: c.id, name: c.name, status: c.status, timezone: c.timezone, defaultMode: c.defaultMode,
  minCommentDmScore: c.minCommentDmScore, maxCommentDmsPerDay: c.maxCommentDmsPerDay, commentDmMinGapMinutes: c.commentDmMinGapMinutes,
  lowScoreAction: c.lowScoreAction, humanPauseHours: c.humanPauseHours, openerDailyMax: c.openerDailyMax,
});

app.get('/api/modes', async () => OPERATING_MODES.map((m) => ({ id: m, label: MODE_PROFILES[m].label, description: MODE_PROFILES[m].description })));

app.get('/api/clients', async () => {
  const rows = await q<{ id: string }>(`SELECT id FROM clients ORDER BY name`);
  const out = [];
  for (const r of rows) { const c = await repo.getClient(r.id); if (c) out.push(publicClient(c)); }
  return out;
});

app.get<{ Params: { id: string } }>('/api/clients/:id', async (req, reply) => {
  const c = await repo.getClient(uuid.parse(req.params.id));
  if (!c) return reply.code(404).send({ error: 'not_found' });
  const [today, review] = await Promise.all([repo.commentDmsToday(c.id, c.timezone), repo.listReviewComments(c.id, 500)]);
  const cap = commentDmCap(rampCap((Date.now() - new Date(c.launchedAt).getTime()) / 86_400_000, c.openerDailyMax), c.maxCommentDmsPerDay);
  return { ...publicClient(c), commentDmsToday: today, commentDmCapToday: cap, reviewQueue: review.length };
});

app.patch<{ Params: { id: string } }>('/api/clients/:id/controls', async (req, reply) => {
  const id = uuid.parse(req.params.id);
  const b = controlsSchema.parse(req.body);
  if (!(await repo.getClient(id))) return reply.code(404).send({ error: 'not_found' });
  await repo.updateClientControls(id, b as Parameters<typeof repo.updateClientControls>[1]);
  secretCache.delete(id);
  return { ok: true };
});

app.get<{ Params: { id: string } }>('/api/clients/:id/conversations', async (req) => repo.listConversations(uuid.parse(req.params.id), 200));

app.get<{ Params: { id: string } }>('/api/clients/:id/review-comments', async (req) => repo.listReviewComments(uuid.parse(req.params.id), 200));
app.post<{ Params: { id: string } }>('/api/comments/:id/approve', async (req, reply) =>
  (await approveReviewedComment(uuid.parse(req.params.id))) ? { ok: true } : reply.code(409).send({ error: 'not_in_review' }));
app.post<{ Params: { id: string } }>('/api/comments/:id/dismiss', async (req) => {
  await repo.setCommentStatus(uuid.parse(req.params.id), 'skipped', 'dismissed_in_review');
  return { ok: true };
});

app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
  const thread = await loadBotThread(uuid.parse(req.params.id));
  const conv = await repo.getConversation(uuid.parse(req.params.id));
  if (!thread || !conv) return reply.code(404).send({ error: 'not_found' });
  return {
    conversation: { id: conv.id, state: conv.state, mode: conv.mode, callStatus: conv.callStatus, leadScore: conv.leadScore, goal: conv.conversationGoal,
      nextFollowUpAt: conv.nextFollowUpAt, followUpRationale: conv.followUpRationale, followUpAngle: conv.followUpAngle, humanTakeover: conv.humanTakeover,
      pausedUntil: conv.pausedUntil, bookingLinkSentAt: conv.bookingLinkSentAt, commentDmSentAt: conv.commentDmSentAt,
      commentDmCommentId: conv.commentDmCommentId, commentDmPostId: conv.commentDmPostId, username: thread.username, source: conv.source, followupsSent: conv.followupsSent },
    milestones: buildMilestones(thread),
    messages: thread.messages.map((m) => ({ direction: m.direction, body: m.body, at: m.at.toISOString() })),
  };
});

app.post<{ Params: { id: string } }>('/api/conversations/:id/mode', async (req, reply) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ mode: z.string().nullable() }).parse(req.body);
  if (b.mode !== null && !isOperatingMode(b.mode)) return reply.code(400).send({ error: 'bad_mode' });
  const conv = await repo.getConversation(id);
  if (!conv) return reply.code(404).send({ error: 'not_found' });
  await repo.setMode(id, b.mode);
  await repo.addThreadEvent(conv.clientId, id, 'mode_changed', { to: b.mode ?? 'default', source: 'dashboard' });
  if (b.mode === 'paused_human') { await repo.cancelPendingSends(id); await repo.cancelPendingFollowups(id, 'mode_paused_human'); await repo.clearPlan(id, conv.conversationGoal); }
  else await enqueue('plan_followup', { conversationId: id }, { clientId: conv.clientId, dedupeKey: `plan:${id}` });
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/conversations/:id/call-status', async (req, reply) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ status: z.string() }).parse(req.body);
  if (!isCallStatus(b.status)) return reply.code(400).send({ error: 'bad_status' });
  const conv = await repo.getConversation(id);
  const client = conv ? await repo.getClient(conv.clientId) : null;
  if (!conv || !client) return reply.code(404).send({ error: 'not_found' });
  if (b.status === 'no_booking_link_sent') { await repo.setCallStatus(id, b.status); await repo.addThreadEvent(client.id, id, 'call_status_changed', { from: conv.callStatus, to: b.status, source: 'dashboard' }); return { ok: true }; }
  const r = await applyCallStatus(conv, client, b.status, { source: 'dashboard', force: true });
  return { ok: true, changed: r.changed };
});

/** Context Bot: ask anything about one lead; answers carry real quotes, timestamps, style and milestones. */
app.post<{ Params: { id: string } }>('/api/conversations/:id/ask', async (req, reply) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ question: z.string().trim().min(2).max(500) }).parse(req.body);
  const out = await askAboutThread(getBotLlm(), id, b.question);
  return out ?? reply.code(404).send({ error: 'not_found' });
});

registerTestChat(app);   // /test page + /api/test-chat (after the admin hook above, so the API needs ADMIN_TOKEN)

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: 'bad_request', issues: err.issues });
  app.log.error(err);
  return reply.code(500).send({ error: 'internal' });
});

app.listen({ port: config.port, host: '0.0.0.0' }).catch((e) => { app.log.error(e); process.exit(1); });
