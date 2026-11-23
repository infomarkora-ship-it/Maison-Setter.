import { q, q1 } from '../db.js';
import * as repo from '../repo.js';

// =====================================================================================
// Overview: everything the Home page (and Ask AI's data packet) needs, computed with SQL
// from the real tables. Nothing here writes anything — read-only by design.
// =====================================================================================

export interface NeedsYouItem {
  kind: 'needs_human' | 'flagged_comment' | 'held_comment' | 'no_show' | 'cancelled_call';
  title: string;
  detail: string;
  at: string | null;
  conversationId: string | null;
  commentId: string | null;
}

export interface Overview {
  today: {
    dmsSent: number; repliesIn: number; newLeads: number; callsBooked: number;
    sales: number; revenueCents: number; commentDmsSent: number; openersPending: number;
  };
  totals30d: { conversations: number; replied: number; qualified: number; booked: number; closed: number; revenueCents: number };
  needsYou: NeedsYouItem[];
  counts: { needsHuman: number; heldComments: number; flaggedComments: number; noShows: number; cancelledCalls: number; pausedThreads: number };
  comments7d: { classified: number; becameDms: number; becameBookings: number; revenueCents: number; heldForReview: number; flagged: number; skipped: number };
  workerAlive: boolean | null;
}

const n = (v: unknown) => Number(v ?? 0);

export async function buildOverview(clientId: string, tz: string): Promise<Overview> {
  // "Today" = since local midnight in the client's timezone (same rule the send caps use).
  const todayWhere = (col: string) => `${col} >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`;

  const t = await q1<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM send_queue WHERE client_id = $1 AND status = 'sent' AND ${todayWhere('sent_at')}) AS dms_sent,
       (SELECT count(*)::int FROM messages WHERE client_id = $1 AND direction = 'in' AND ${todayWhere('created_at')}) AS replies_in,
       (SELECT count(*)::int FROM conversations WHERE client_id = $1 AND ${todayWhere('first_touch_at')}) AS new_leads,
       (SELECT count(*)::int FROM appointments WHERE client_id = $1 AND ${todayWhere('created_at')}) AS calls_booked,
       (SELECT count(*)::int FROM sales WHERE client_id = $1 AND ${todayWhere('reported_at')}) AS sales,
       (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM sales WHERE client_id = $1 AND ${todayWhere('reported_at')}) AS revenue_cents,
       (SELECT count(*)::int FROM conversations WHERE client_id = $1 AND comment_dm_sent_at IS NOT NULL AND ${todayWhere('comment_dm_sent_at')}) AS comment_dms,
       (SELECT count(*)::int FROM send_queue WHERE client_id = $1 AND status = 'pending' AND kind = 'opener') AS openers_pending`,
    [clientId, tz]) ?? {};

  // Funnel totals for the last 30 days, one row per source; we sum them for the headline.
  const funnelRows = await repo.funnel(clientId, 30);
  const totals30d = funnelRows.reduce(
    (a, r) => ({
      conversations: a.conversations + n(r.conversations), replied: a.replied + n(r.replied),
      qualified: a.qualified + n(r.qualified), booked: a.booked + n(r.booked), closed: a.closed + n(r.closed),
      revenueCents: a.revenueCents + Number(r.revenueCents ?? 0),
    }),
    { conversations: 0, replied: 0, qualified: 0, booked: 0, closed: 0, revenueCents: 0 },
  );

  // ---- needs-you list: the four kinds of thing a human should look at ----
  const needsYou: NeedsYouItem[] = [];

  const humanRows = await q<{ id: string; username: string | null; platformUserId: string; lastInboundAt: Date | null }>(
    `SELECT c.id, ct.username, ct.platform_user_id, c.last_inbound_at
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.client_id = $1 AND (c.state = 'needs_human' OR c.call_status = 'call_no_show' OR c.call_status = 'call_canceled')
     ORDER BY GREATEST(c.last_inbound_at, c.last_outbound_at, c.first_touch_at) DESC LIMIT 15`, [clientId]);
  for (const r of humanRows) {
    const who = '@' + (r.username || r.platformUserId);
    const conv = await repo.getConversation(r.id);
    if (conv?.callStatus === 'call_no_show') needsYou.push({ kind: 'no_show', title: `No-show: ${who}`, detail: 'They missed their call. The AI is trying to rebook them — check in if it stalls.', at: conv.lastInboundAt?.toISOString() ?? null, conversationId: r.id, commentId: null });
    else if (conv?.callStatus === 'call_canceled') needsYou.push({ kind: 'cancelled_call', title: `Call cancelled: ${who}`, detail: 'Their call was cancelled. The AI offers an easy rebook — step in if they ask for a human.', at: conv.lastInboundAt?.toISOString() ?? null, conversationId: r.id, commentId: null });
    if (conv?.state === 'needs_human') needsYou.push({ kind: 'needs_human', title: `Handed off to you: ${who}`, detail: 'The AI stepped back on this thread (complaint, anger, or something it must not handle alone).', at: conv.lastInboundAt?.toISOString() ?? null, conversationId: r.id, commentId: null });
  }

  const flagged = await q<{ id: string; authorUsername: string | null; authorId: string; text: string; reason: string | null; commentedAt: Date }>(
    `SELECT id, author_username, author_id, text, reason, commented_at FROM comments
     WHERE client_id = $1 AND status = 'flagged' AND commented_at > now() - interval '7 days'
     ORDER BY commented_at DESC LIMIT 15`, [clientId]);
  for (const c of flagged) {
    needsYou.push({ kind: 'flagged_comment', title: `Flagged comment from @${c.authorUsername || c.authorId}`, detail: `${c.text.slice(0, 120)}${c.reason ? ` — ${c.reason.slice(0, 120)}` : ''}`, at: c.commentedAt.toISOString(), conversationId: null, commentId: c.id });
  }

  const held = await repo.listReviewComments(clientId, 15);
  for (const c of held) {
    needsYou.push({ kind: 'held_comment', title: `Held comment from @${c.authorUsername || c.authorId}`, detail: `${c.text.slice(0, 120)} (score ${c.leadScore ?? 'n/a'})`, at: c.commentedAt.toISOString(), conversationId: null, commentId: c.id });
  }
  needsYou.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  const counts = await q1<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM conversations WHERE client_id = $1 AND state = 'needs_human') AS needs_human,
       (SELECT count(*)::int FROM comments WHERE client_id = $1 AND status = 'review') AS held_comments,
       (SELECT count(*)::int FROM comments WHERE client_id = $1 AND status = 'flagged' AND commented_at > now() - interval '7 days') AS flagged_comments,
       (SELECT count(*)::int FROM appointments WHERE client_id = $1 AND status = 'no_show' AND starts_at > now() - interval '7 days') AS no_shows,
       (SELECT count(*)::int FROM appointments WHERE client_id = $1 AND status = 'cancelled' AND starts_at > now() - interval '7 days') AS cancelled_calls,
       (SELECT count(*)::int FROM conversations WHERE client_id = $1 AND (human_takeover = true OR mode = 'paused_human' OR paused_until > now())) AS paused_threads`,
    [clientId]) ?? {};

  // ---- comment engine results, last 7 days ----
  const c7 = await q1<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM comments WHERE client_id = $1 AND created_at > now() - interval '7 days') AS classified,
       (SELECT count(*)::int FROM conversations WHERE client_id = $1 AND comment_dm_sent_at > now() - interval '7 days') AS became_dms,
       (SELECT count(*)::int FROM appointments a JOIN conversations c2 ON c2.id = a.conversation_id
          WHERE c2.client_id = $1 AND c2.comment_dm_sent_at IS NOT NULL AND a.created_at > now() - interval '7 days') AS became_bookings,
       (SELECT COALESCE(sum(s.amount_cents), 0)::bigint FROM sales s JOIN conversations c3 ON c3.id = s.conversation_id
          WHERE c3.client_id = $1 AND c3.comment_dm_sent_at IS NOT NULL AND s.reported_at > now() - interval '7 days') AS revenue_cents,
       (SELECT count(*)::int FROM comments WHERE client_id = $1 AND status = 'review') AS held,
       (SELECT count(*)::int FROM comments WHERE client_id = $1 AND status = 'flagged' AND created_at > now() - interval '7 days') AS flagged,
       (SELECT count(*)::int FROM comments WHERE client_id = $1 AND status = 'skipped' AND created_at > now() - interval '7 days') AS skipped`,
    [clientId]) ?? {};

  const hb = await q1<{ at: Date }>(`SELECT at FROM worker_status WHERE name = 'worker'`);
  const workerAlive = hb ? (Date.now() - new Date(hb.at).getTime()) < 3 * 60_000 : null;

  return {
    today: {
      dmsSent: n(t.dms_sent), repliesIn: n(t.replies_in), newLeads: n(t.new_leads), callsBooked: n(t.calls_booked),
      sales: n(t.sales), revenueCents: n(t.revenue_cents), commentDmsSent: n(t.comment_dms), openersPending: n(t.openers_pending),
    },
    totals30d,
    needsYou,
    counts: {
      needsHuman: n(counts.needs_human), heldComments: n(counts.held_comments), flaggedComments: n(counts.flagged_comments),
      noShows: n(counts.no_shows), cancelledCalls: n(counts.cancelled_calls), pausedThreads: n(counts.paused_threads),
    },
    comments7d: {
      classified: n(c7.classified), becameDms: n(c7.became_dms), becameBookings: n(c7.became_bookings),
      revenueCents: n(c7.revenue_cents), heldForReview: n(c7.held), flagged: n(c7.flagged), skipped: n(c7.skipped),
    },
    workerAlive,
  };
}
