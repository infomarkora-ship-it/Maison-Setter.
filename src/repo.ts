import { q, q1 } from './db.js';
import type { CallStatus, Client, ConversationGoal, ConversationState, LowScoreAction, OperatingMode, QueueKind, Source, Turn } from './types.js';

export interface Contact { id: string; clientId: string; platformUserId: string; username: string | null; doNotContact: boolean }
export interface Conversation {
  id: string; clientId: string; contactId: string; source: Source; state: ConversationState;
  humanTakeover: boolean; triaged: boolean; followupsSent: number; leadNotes: string | null;
  lastInboundAt: Date | null; lastOutboundAt: Date | null;
  mode: OperatingMode | null; callStatus: CallStatus; pausedUntil: Date | null; leadScore: number | null;
  conversationGoal: ConversationGoal | null; nextFollowUpAt: Date | null; followUpRationale: string | null; followUpAngle: string | null;
  bookingLinkSentAt: Date | null; commentDmSentAt: Date | null; commentDmCommentId: string | null; commentDmPostId: string | null;
  firstTouchAt: Date;
}
export interface CommentRow {
  id: string; clientId: string; platformCommentId: string; postId: string | null; postCaption: string | null; isAd: boolean;
  authorId: string; authorUsername: string | null; text: string; likeCount: number; commentedAt: Date; status: string;
  leadScore: number | null; priorityScore: string | null; reason: string | null; intentScore: number | null; fitScore: number | null;
}
export interface QueueItem {
  id: number; clientId: string; kind: QueueKind; conversationId: string | null; commentId: string | null;
  body: string | null; priority: number; scheduledFor: Date; attempts: number; goal: string | null;
}

// ---------- clients ----------
export const getClient = (id: string) => q1<Client>(`SELECT * FROM clients WHERE id = $1`, [id]);
export const listLiveClients = () => q<Client>(`SELECT * FROM clients WHERE status IN ('pilot','active')`);

// ---------- raw events ----------
export async function insertRawEvent(clientId: string, dedupeKey: string, payload: unknown): Promise<number | null> {
  const r = await q1<{ id: number }>(
    `INSERT INTO raw_events (client_id, dedupe_key, payload) VALUES ($1, $2, $3)
     ON CONFLICT (client_id, dedupe_key) DO NOTHING RETURNING id`,
    [clientId, dedupeKey, JSON.stringify(payload)],
  );
  return r?.id ?? null;
}
export const getRawEvent = (id: number) =>
  q1<{ id: number; clientId: string; payload: unknown }>(`SELECT id, client_id, payload FROM raw_events WHERE id = $1`, [id]);
export const markRawProcessed = (id: number, error?: string) =>
  q(`UPDATE raw_events SET processed_at = now(), error = $2 WHERE id = $1`, [id, error ?? null]);

// ---------- contacts & conversations ----------
export async function upsertContact(clientId: string, platformUserId: string, username?: string): Promise<Contact> {
  const r = await q1<Contact>(
    `INSERT INTO contacts (client_id, platform_user_id, username) VALUES ($1, $2, $3)
     ON CONFLICT (client_id, platform_user_id) DO UPDATE SET username = COALESCE(EXCLUDED.username, contacts.username)
     RETURNING *`,
    [clientId, platformUserId, username ?? null],
  );
  return r as Contact;
}
export const findContact = (clientId: string, platformUserId: string) =>
  q1<Contact>(`SELECT * FROM contacts WHERE client_id = $1 AND platform_user_id = $2`, [clientId, platformUserId]);
export const getContact = (id: string) => q1<Contact>(`SELECT * FROM contacts WHERE id = $1`, [id]);
export const markContactDnc = (id: string) => q(`UPDATE contacts SET do_not_contact = true WHERE id = $1`, [id]);

export async function upsertConversation(clientId: string, contactId: string, source: Source, triaged = false): Promise<Conversation> {
  const r = await q1<Conversation>(
    `INSERT INTO conversations (client_id, contact_id, source, triaged) VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, contact_id) DO UPDATE SET client_id = EXCLUDED.client_id
     RETURNING *`,
    [clientId, contactId, source, triaged],
  );
  return r as Conversation;
}
export const getConversation = (id: string) => q1<Conversation>(`SELECT * FROM conversations WHERE id = $1`, [id]);
export const findConversationByContact = (clientId: string, contactId: string) =>
  q1<Conversation>(`SELECT * FROM conversations WHERE client_id = $1 AND contact_id = $2`, [clientId, contactId]);

export const setState = (id: string, state: ConversationState) => q(`UPDATE conversations SET state = $2 WHERE id = $1`, [id, state]);
export const setNotes = (id: string, notes: string) => q(`UPDATE conversations SET lead_notes = $2 WHERE id = $1`, [id, notes.slice(0, 600)]);
export const setTriaged = (id: string) => q(`UPDATE conversations SET triaged = true WHERE id = $1`, [id]);
export const setTakeover = (id: string, on: boolean) => q(`UPDATE conversations SET human_takeover = $2 WHERE id = $1`, [id, on]);
export const touchInbound = (id: string, at: Date) => q(`UPDATE conversations SET last_inbound_at = $2 WHERE id = $1`, [id, at]);
export const touchOutbound = (id: string, at: Date, followup = false) =>
  q(`UPDATE conversations SET last_outbound_at = $2, followups_sent = followups_sent + $3 WHERE id = $1`, [id, at, followup ? 1 : 0]);

// ---------- messages ----------
/** Returns false when the platform message id was already stored (duplicate delivery). */
export async function insertMessage(m: { clientId: string; conversationId: string; direction: 'in' | 'out'; body: string; platformMessageId?: string; promptVersion?: string; at?: Date }): Promise<boolean> {
  const r = await q1<{ id: number }>(
    `INSERT INTO messages (client_id, conversation_id, direction, body, platform_message_id, prompt_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
     ON CONFLICT (client_id, platform_message_id) WHERE platform_message_id IS NOT NULL DO NOTHING RETURNING id`,
    [m.clientId, m.conversationId, m.direction, m.body, m.platformMessageId ?? null, m.promptVersion ?? null, m.at ?? null],
  );
  return r !== null;
}
export const loadHistory = (conversationId: string, limit = 30) =>
  q<Turn>(`SELECT direction, body, created_at FROM (
             SELECT direction, body, created_at, id FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
           ) t ORDER BY id ASC`, [conversationId, limit]);
export async function recentOutboundWithBody(conversationId: string, body: string, minutes = 5): Promise<boolean> {
  const r = await q1(`SELECT 1 AS x FROM messages WHERE conversation_id = $1 AND direction = 'out' AND body = $2
                      AND created_at > now() - ($3::text || ' minutes')::interval LIMIT 1`, [conversationId, body, String(minutes)]);
  return r !== null;
}
export async function messageIdKnown(clientId: string, platformMessageId: string): Promise<boolean> {
  return (await q1(`SELECT 1 AS x FROM messages WHERE client_id = $1 AND platform_message_id = $2`, [clientId, platformMessageId])) !== null;
}

// ---------- comments ----------
export async function insertComment(c: {
  clientId: string; platformCommentId: string; postId?: string; postCaption?: string; isAd?: boolean;
  authorId: string; authorUsername?: string; text: string; likeCount?: number; commentedAt: Date;
}): Promise<CommentRow | null> {
  return q1<CommentRow>(
    `INSERT INTO comments (client_id, platform_comment_id, post_id, post_caption, is_ad, author_id, author_username, text, like_count, commented_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (client_id, platform_comment_id) DO NOTHING RETURNING *`,
    [c.clientId, c.platformCommentId, c.postId ?? null, c.postCaption ?? null, c.isAd ?? false, c.authorId, c.authorUsername ?? null, c.text, c.likeCount ?? 0, c.commentedAt],
  );
}
export const getComment = (id: string) => q1<CommentRow>(`SELECT * FROM comments WHERE id = $1`, [id]);
export const setCommentVerdict = (id: string, v: { decision: string; intent: number; fit: number; reason: string; priority?: number; status: string; leadScore?: number }) =>
  q(`UPDATE comments SET decision=$2, intent_score=$3, fit_score=$4, reason=$5, priority_score=$6, status=$7, lead_score=$8 WHERE id=$1`,
    [id, v.decision, v.intent, v.fit, v.reason, v.priority ?? null, v.status, v.leadScore ?? null]);
export const setCommentStatus = (id: string, status: string, reason?: string) =>
  q(`UPDATE comments SET status = $2, reason = COALESCE($3, reason) WHERE id = $1`, [id, status, reason ?? null]);

// ---------- send hold (dashboard pause button) ----------
export const setSendHold = (id: string, on: boolean) => q(`UPDATE clients SET send_hold = $2 WHERE id = $1`, [id, on]);

// ---------- send queue ----------
export async function enqueueSend(s: { clientId: string; kind: QueueKind; conversationId?: string; commentId?: string; body?: string; priority?: number; delayMs?: number; goal?: ConversationGoal }) {
  await q(
    `INSERT INTO send_queue (client_id, kind, conversation_id, comment_id, body, priority, scheduled_for, goal)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7::text || ' milliseconds')::interval, $8)`,
    [s.clientId, s.kind, s.conversationId ?? null, s.commentId ?? null, s.body ?? null, s.priority ?? 0, String(s.delayMs ?? 0), s.goal ?? null],
  );
}
export const cancelPendingSends = (conversationId: string) =>
  q(`UPDATE send_queue SET status = 'cancelled' WHERE conversation_id = $1 AND status = 'pending'`, [conversationId]);
export const hasPendingSend = async (conversationId: string) =>
  (await q1(`SELECT 1 AS x FROM send_queue WHERE conversation_id = $1 AND status = 'pending' LIMIT 1`, [conversationId])) !== null;

export const dueCandidates = (clientId: string, now: Date) =>
  q<{ id: number; kind: QueueKind; priority: string; scheduledFor: Date }>(
    `SELECT id, kind, priority, scheduled_for FROM send_queue
     WHERE client_id = $1 AND status = 'pending' AND scheduled_for <= $2
     ORDER BY CASE kind WHEN 'reply' THEN 0 WHEN 'reminder' THEN 1 WHEN 'followup' THEN 2 ELSE 3 END, priority DESC, scheduled_for
     LIMIT 50`, [clientId, now]);

export const claimQueueItem = (id: number) =>
  q1<QueueItem>(`UPDATE send_queue SET attempts = attempts + 1, last_attempt_at = now()
                 WHERE id = $1 AND status = 'pending' RETURNING *`, [id]);
export const markSent = (id: number) => q(`UPDATE send_queue SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [id]);
export const markQueue = (id: number, status: 'failed' | 'cancelled' | 'expired', error?: string) =>
  q(`UPDATE send_queue SET status = $2, error = $3 WHERE id = $1`, [id, status, error?.slice(0, 500) ?? null]);
export const rescheduleQueue = (id: number, delayMs: number, error: string) =>
  q(`UPDATE send_queue SET scheduled_for = now() + ($2::text || ' milliseconds')::interval, error = $3 WHERE id = $1`, [id, String(delayMs), error.slice(0, 500)]);

export async function sendCounters(clientId: string, tz: string): Promise<{ openersToday: number; lastHour: number; commentDmsToday: number }> {
  const r = await q1<{ openersToday: number; lastHour: number }>(
    `SELECT
       count(*) FILTER (WHERE kind = 'opener' AND sent_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)::int AS openers_today,
       count(*) FILTER (WHERE sent_at >= now() - interval '1 hour')::int AS last_hour
     FROM send_queue WHERE client_id = $1 AND status = 'sent' AND sent_at >= now() - interval '2 days'`,
    [clientId, tz]);
  return { openersToday: r?.openersToday ?? 0, lastHour: r?.lastHour ?? 0, commentDmsToday: await commentDmsToday(clientId, tz) };
}

/** Comment-triggered DMs sent since local midnight. Counted from the conversations that recorded comment_dm_sent_at. */
export async function commentDmsToday(clientId: string, tz: string): Promise<number> {
  const r = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM conversations
     WHERE client_id = $1 AND comment_dm_sent_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`, [clientId, tz]);
  return r?.n ?? 0;
}
export const setNextOpenerAt = (clientId: string, at: Date) => q(`UPDATE clients SET next_opener_at = $2 WHERE id = $1`, [clientId, at]);

// ---------- brakes & signals ----------
export const activeBrake = (clientId: string) =>
  q1<{ id: number; reason: string; until: Date }>(`SELECT id, reason, until FROM brakes WHERE client_id = $1 AND until > now() ORDER BY until DESC LIMIT 1`, [clientId]);
export const createBrake = (clientId: string, reason: string, hours: number) =>
  q(`INSERT INTO brakes (client_id, reason, until) VALUES ($1, $2, now() + ($3::text || ' hours')::interval)`, [clientId, reason, String(hours)]);
export const addSignal = (clientId: string, kind: string, contactId?: string) =>
  q(`INSERT INTO signals (client_id, kind, contact_id) VALUES ($1, $2, $3)`, [clientId, kind, contactId ?? null]);

export async function brakeStats(clientId: string) {
  const opener = await q1<{ sent: number; replied: number }>(
    `WITH last AS (
       SELECT conversation_id, sent_at FROM send_queue
       WHERE client_id = $1 AND kind = 'opener' AND status = 'sent' AND sent_at < now() - interval '6 hours'
       ORDER BY sent_at DESC LIMIT 50)
     SELECT count(*)::int AS sent,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = last.conversation_id AND m.direction = 'in' AND m.created_at > last.sent_at))::int AS replied
     FROM last`, [clientId]);
  const att = await q1<{ attempts: number; errors: number }>(
    `WITH r AS (SELECT status FROM send_queue WHERE client_id = $1 AND last_attempt_at IS NOT NULL AND status IN ('sent','failed') ORDER BY last_attempt_at DESC LIMIT 20)
     SELECT count(*)::int AS attempts, count(*) FILTER (WHERE status = 'failed')::int AS errors FROM r`, [clientId]);
  const sig = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM signals WHERE client_id = $1 AND created_at > now() - interval '24 hours'`, [clientId]);
  return {
    openersSent: opener?.sent ?? 0, openersReplied: opener?.replied ?? 0,
    recentAttempts: att?.attempts ?? 0, recentErrors: att?.errors ?? 0, negativeSignals24h: sig?.n ?? 0,
  };
}

// ---------- appointments, sales, usage ----------
export async function insertAppointment(a: { clientId: string; conversationId: string; startsAt: Date; name?: string; email?: string; externalId?: string }) {
  await q(`INSERT INTO appointments (client_id, conversation_id, starts_at, attendee_name, attendee_email, external_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.clientId, a.conversationId, a.startsAt, a.name ?? null, a.email ?? null, a.externalId ?? null]);
}
export async function recordSale(conversationId: string, amountCents: number, note?: string) {
  return q1<{ id: string; commissionCents: string }>(
    `INSERT INTO sales (client_id, conversation_id, amount_cents, commission_cents, note)
     SELECT c.client_id, c.id, $2::bigint, round($2::bigint * cl.commission_rate), $3::text
     FROM conversations c JOIN clients cl ON cl.id = c.client_id
     WHERE c.id = $1
       AND c.first_touch_at > now() - (cl.attribution_days::text || ' days')::interval
     RETURNING id, commission_cents`, [conversationId, amountCents, note ?? null]);
}
export const logUsage = (u: { clientId?: string; kind: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }) =>
  q(`INSERT INTO usage_log (client_id, kind, input_tokens, output_tokens, cache_read, cache_write, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [u.clientId ?? null, u.kind, u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd]);

/** Funnel by first-touch source: the numbers you show clients and use to get paid. */
export const funnel = (clientId: string, days = 30) =>
  q<{ source: string; conversations: number; replied: number; qualified: number; booked: number; closed: number; revenueCents: string; commissionCents: string }>(
    `SELECT c.source,
        count(*)::int AS conversations,
        count(*) FILTER (WHERE c.last_inbound_at IS NOT NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction='in'))::int AS replied,
        count(*) FILTER (WHERE c.state IN ('qualified','scheduling','booked'))::int AS qualified,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM appointments a WHERE a.conversation_id = c.id))::int AS booked,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sales s WHERE s.conversation_id = c.id))::int AS closed,
        COALESCE(sum((SELECT sum(amount_cents) FROM sales s WHERE s.conversation_id = c.id)), 0)::text AS revenue_cents,
        COALESCE(sum((SELECT sum(commission_cents) FROM sales s WHERE s.conversation_id = c.id)), 0)::text AS commission_cents
     FROM conversations c WHERE c.client_id = $1 AND c.first_touch_at > now() - ($2::text || ' days')::interval GROUP BY c.source`,
    [clientId, String(days)]);

// =====================================================================================
// v2: modes, call status, pauses, planned follow-ups, milestones
// =====================================================================================
export const setMode = (id: string, mode: OperatingMode | null) => q(`UPDATE conversations SET mode = $2 WHERE id = $1`, [id, mode]);
export const setCallStatus = (id: string, status: CallStatus) => q(`UPDATE conversations SET call_status = $2 WHERE id = $1`, [id, status]);
export const setPausedUntil = (id: string, at: Date | null) => q(`UPDATE conversations SET paused_until = $2 WHERE id = $1`, [id, at]);
export const setLeadScore = (id: string, score: number) => q(`UPDATE conversations SET lead_score = $2 WHERE id = $1`, [id, Math.round(score)]);
export const resetUnansweredFollowups = (id: string) => q(`UPDATE conversations SET followups_sent = 0 WHERE id = $1`, [id]);

/** Human takeover with a cooldown. Each new human message pushes paused_until out again. */
export const startHumanPause = (id: string, until: Date) =>
  q(`UPDATE conversations SET human_takeover = true, paused_until = $2 WHERE id = $1`, [id, until]);

export const setPlan = (id: string, p: { at: Date; goal: ConversationGoal; rationale: string; angle: string; leadScore?: number | null }) =>
  q(`UPDATE conversations SET next_follow_up_at = $2, conversation_goal = $3, follow_up_rationale = $4, follow_up_angle = $5,
       lead_score = COALESCE($6, lead_score) WHERE id = $1`, [id, p.at, p.goal, p.rationale.slice(0, 400), p.angle.slice(0, 400), p.leadScore ?? null]);
export const clearPlan = (id: string, goal?: ConversationGoal | null) =>
  q(`UPDATE conversations SET next_follow_up_at = NULL, follow_up_rationale = NULL, follow_up_angle = NULL, conversation_goal = $2 WHERE id = $1`, [id, goal ?? null]);

export const markBookingLinkSent = (id: string, at: Date) => q(`UPDATE conversations SET booking_link_sent_at = $2 WHERE id = $1`, [id, at]);
export const markCommentDmSent = (id: string, o: { at: Date; platformCommentId: string; postId?: string | null; leadScore?: number | null }) =>
  q(`UPDATE conversations SET comment_dm_sent_at = $2, comment_dm_comment_id = $3, comment_dm_post_id = $4, lead_score = COALESCE($5, lead_score)
     WHERE id = $1`, [id, o.at, o.platformCommentId, o.postId ?? null, o.leadScore ?? null]);

export async function addThreadEvent(clientId: string, conversationId: string, kind: string, data: Record<string, unknown> = {}, at?: Date) {
  await q(`INSERT INTO thread_events (client_id, conversation_id, kind, data, at) VALUES ($1,$2,$3,$4, COALESCE($5, now()))`,
    [clientId, conversationId, kind, JSON.stringify(data), at ?? null]);
}
export interface ThreadEvent { id: number; kind: string; data: Record<string, unknown>; at: Date }
export const listThreadEvents = (conversationId: string) =>
  q<ThreadEvent>(`SELECT id, kind, data, at FROM thread_events WHERE conversation_id = $1 ORDER BY at, id`, [conversationId]);

/** Pending "book a call" style sends and jobs for a thread: stale once the call is confirmed, or when the lead opts out. */
export async function cancelPendingFollowups(conversationId: string, why = 'stale') {
  await q(`UPDATE send_queue SET status = 'cancelled', error = $2 WHERE conversation_id = $1 AND status = 'pending' AND kind = 'followup'`, [conversationId, why]);
  await q(`UPDATE jobs SET status = 'done', last_error = $2 WHERE status = 'pending' AND type IN ('followup','plan_followup') AND payload->>'conversationId' = $1`, [conversationId, `cancelled:${why}`]);
}
/** A newer inbound message makes any queued (not yet sent) AI reply stale: it gets regenerated with the full burst. */
export const cancelPendingReplies = (conversationId: string) =>
  q(`UPDATE send_queue SET status = 'cancelled', error = 'superseded_by_newer_message' WHERE conversation_id = $1 AND status = 'pending' AND kind = 'reply'`, [conversationId]);

export const countOutboundSince = async (conversationId: string, since: Date) =>
  (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'out' AND created_at >= $2`, [conversationId, since]))?.n ?? 0;

// ---------- appointments / call lookups ----------
export interface Appointment { id: string; clientId: string; conversationId: string; startsAt: Date; attendeeName: string | null; attendeeEmail: string | null; externalId: string | null; status: string }
export const latestAppointment = (conversationId: string) =>
  q1<Appointment>(`SELECT * FROM appointments WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conversationId]);
export const findAppointmentByExternalId = (clientId: string, externalId: string) =>
  q1<Appointment>(`SELECT * FROM appointments WHERE client_id = $1 AND external_id = $2 LIMIT 1`, [clientId, externalId]);
export const findConversationByEmail = (clientId: string, email: string) =>
  q1<Conversation>(`SELECT c.* FROM conversations c JOIN appointments a ON a.conversation_id = c.id
                    WHERE c.client_id = $1 AND lower(a.attendee_email) = lower($2) ORDER BY a.created_at DESC LIMIT 1`, [clientId, email]);
export const findContactByUsername = (clientId: string, username: string) =>
  q1<Contact>(`SELECT * FROM contacts WHERE client_id = $1 AND lower(username) = lower($2) LIMIT 1`, [clientId, username.replace(/^@/, '')]);
export const setAppointmentStatus = (id: string, status: string) => q(`UPDATE appointments SET status = $2 WHERE id = $1`, [id, status]);
export const rescheduleAppointment = (id: string, startsAt: Date) =>
  q(`UPDATE appointments SET starts_at = $2, status = 'booked', reminder24_sent = false, reminder2_sent = false WHERE id = $1`, [id, startsAt]);

// ---------- dashboard / controls ----------
export interface ClientControls {
  defaultMode: OperatingMode; minCommentDmScore: number; maxCommentDmsPerDay: number | null;
  commentDmMinGapMinutes: number; lowScoreAction: LowScoreAction; humanPauseHours: number;
}
export async function updateClientControls(id: string, c: Partial<ClientControls>) {
  const sets: string[] = []; const vals: unknown[] = [id];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (c.defaultMode !== undefined) add('default_mode', c.defaultMode);
  if (c.minCommentDmScore !== undefined) add('min_comment_dm_score', c.minCommentDmScore);
  if (c.maxCommentDmsPerDay !== undefined) add('max_comment_dms_per_day', c.maxCommentDmsPerDay);
  if (c.commentDmMinGapMinutes !== undefined) add('comment_dm_min_gap_minutes', c.commentDmMinGapMinutes);
  if (c.lowScoreAction !== undefined) add('low_score_action', c.lowScoreAction);
  if (c.humanPauseHours !== undefined) add('human_pause_hours', c.humanPauseHours);
  if (!sets.length) return;
  await q(`UPDATE clients SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/** Write the settings blob the AI reads (tone, offer, rules, facts) + the knowledge file. One write path for the Clients form, AI Studio and the describe-it box. */
export const updateClientSettings = (id: string, settings: Client['settings'], knowledge?: string) =>
  q(`UPDATE clients SET settings = $2, knowledge = COALESCE($3, knowledge) WHERE id = $1`, [id, JSON.stringify(settings), knowledge ?? null]);

export interface ConversationRow {
  id: string; clientId: string; username: string | null; platformUserId: string; source: Source; state: ConversationState;
  mode: OperatingMode | null; callStatus: CallStatus; leadScore: number | null; conversationGoal: ConversationGoal | null;
  nextFollowUpAt: Date | null; bookingLinkSentAt: Date | null; commentDmSentAt: Date | null; humanTakeover: boolean; pausedUntil: Date | null;
  lastInboundAt: Date | null; lastOutboundAt: Date | null; doNotContact: boolean;
}
export const listConversations = (clientId: string, limit = 100) =>
  q<ConversationRow>(
    `SELECT c.id, c.client_id, ct.username, ct.platform_user_id, c.source, c.state, c.mode, c.call_status, c.lead_score, c.conversation_goal,
            c.next_follow_up_at, c.booking_link_sent_at, c.comment_dm_sent_at, c.human_takeover, c.paused_until,
            c.last_inbound_at, c.last_outbound_at, ct.do_not_contact
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.client_id = $1 ORDER BY GREATEST(c.last_inbound_at, c.last_outbound_at, c.created_at) DESC LIMIT $2`, [clientId, limit]);

/** Same as listConversations plus each thread's newest message (used for pipeline cards and inbox previews). */
export const listConversationsWithPreview = (clientId: string, limit = 200) =>
  q<ConversationRow & { lastMessage: string | null; lastDirection: 'in' | 'out' | null }>(
    `SELECT c.id, c.client_id, ct.username, ct.platform_user_id, c.source, c.state, c.mode, c.call_status, c.lead_score, c.conversation_goal,
            c.next_follow_up_at, c.booking_link_sent_at, c.comment_dm_sent_at, c.human_takeover, c.paused_until,
            c.last_inbound_at, c.last_outbound_at, ct.do_not_contact,
            m.body AS last_message, m.direction AS last_direction
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN LATERAL (SELECT body, direction FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) m ON true
     WHERE c.client_id = $1 ORDER BY GREATEST(c.last_inbound_at, c.last_outbound_at, c.created_at) DESC LIMIT $2`, [clientId, limit]);

export const listReviewComments = (clientId: string, limit = 100) =>
  q<CommentRow>(`SELECT * FROM comments WHERE client_id = $1 AND status = 'review' ORDER BY commented_at DESC LIMIT $2`, [clientId, limit]);

/** Every comment ever seen with the opportunity it created (if any), optionally filtered by status. */
export interface CommentOutcome { oppId: string | null; oppState: string | null; oppCallStatus: string | null; oppLeadScore: number | null }
export const listComments = (clientId: string, status: string | null, limit = 200) => {
  const sel = `SELECT c.*, cv.id AS opp_id, cv.state AS opp_state, cv.call_status AS opp_call_status, cv.lead_score AS opp_lead_score
               FROM comments c
               LEFT JOIN conversations cv ON cv.client_id = c.client_id AND cv.comment_dm_comment_id = c.platform_comment_id`;
  return status
    ? q<CommentRow & CommentOutcome>(`${sel} WHERE c.client_id = $1 AND c.status = $2 ORDER BY c.commented_at DESC LIMIT $3`, [clientId, status, limit])
    : q<CommentRow & CommentOutcome>(`${sel} WHERE c.client_id = $1 ORDER BY c.commented_at DESC LIMIT $2`, [clientId, limit]);
};
export const countCommentsByStatus = (clientId: string) =>
  q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM comments WHERE client_id = $1 GROUP BY status`, [clientId]);
export const setCommentQueued = (id: string) => q(`UPDATE comments SET status = 'queued' WHERE id = $1 AND status = 'review'`, [id]);

/** Every opportunity created from a comment DM, newest activity first, with how it is going right now. */
export const listOpportunities = (clientId: string, limit = 200) =>
  q<{
    id: string; username: string | null; state: string; callStatus: string; leadScore: number | null;
    commentDmSentAt: Date; lastInboundAt: Date | null; lastOutboundAt: Date | null; firstTouchAt: Date;
    commentText: string | null; appointmentStatus: string | null; appointmentStartsAt: Date | null;
    saleCents: string | null; lastMessage: string | null; lastDirection: 'in' | 'out' | null;
  }>(
    `SELECT cv.id, ct.username, cv.state, cv.call_status, cv.lead_score, cv.comment_dm_sent_at, cv.last_inbound_at, cv.last_outbound_at, cv.first_touch_at,
            cm.text AS comment_text,
            a.status AS appointment_status, a.starts_at AS appointment_starts_at,
            (SELECT sum(amount_cents) FROM sales s WHERE s.conversation_id = cv.id)::text AS sale_cents,
            m.body AS last_message, m.direction AS last_direction
     FROM conversations cv
     JOIN contacts ct ON ct.id = cv.contact_id
     LEFT JOIN comments cm ON cm.client_id = cv.client_id AND cm.platform_comment_id = cv.comment_dm_comment_id
     LEFT JOIN LATERAL (SELECT status, starts_at FROM appointments WHERE conversation_id = cv.id ORDER BY created_at DESC LIMIT 1) a ON true
     LEFT JOIN LATERAL (SELECT body, direction FROM messages WHERE conversation_id = cv.id ORDER BY id DESC LIMIT 1) m ON true
     WHERE cv.client_id = $1 AND cv.comment_dm_sent_at IS NOT NULL
     ORDER BY GREATEST(cv.last_inbound_at, cv.last_outbound_at, cv.comment_dm_sent_at) DESC LIMIT $2`, [clientId, limit]);
