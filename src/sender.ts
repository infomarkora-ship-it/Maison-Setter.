import type { Deps } from './handlers/events.js';
import type { Client } from './types.js';
import * as repo from './repo.js';
import { generateOpener } from './ai/classify.js';
import { PlatformError } from './platform/types.js';
import { chunkGapMs, chunkMessage, commentStillReplyable, isWithinWindow, openerGapMs, pickNext, rampCap, type SendState } from './pacing.js';
import { automatedSendAllowed, containsBookingLink, isHumanPaused } from './guard.js';
import { recordBookingLinkSent } from './booking.js';
import { enqueue } from './jobs.js';
import { commentDmCap, leadScore as leadScoreOf } from './scoring.js';
import { CALL_CONFIRMED } from './state.js';
import { effectiveMode } from './modes.js';
import { notifyClient } from './notify.js';

/** Runs every ~10s. At most ONE message per client per tick, so bursts are impossible by construction. */
export async function sendTick(deps: Deps, now = new Date()) {
  for (const client of await repo.listLiveClients()) {
    // Dashboard send hold: the AI keeps reading, scoring and planning, but the queue itself
    // is frozen (openers included). Items stay pending; on resume, stale replies and
    // follow-ups are cancelled by the send-hold endpoint and openers send if still replyable.
    if (client.sendHold) continue;
    try { await sendOne(deps, client, now); }
    catch (e) { console.error(`[sender:${client.name}]`, (e as Error).message); }
  }
}

async function sendOne(deps: Deps, c: Client, now: Date) {
  const cands = (await repo.dueCandidates(c.id, now)).map((r) => ({ id: r.id, kind: r.kind, priority: Number(r.priority), scheduledFor: new Date(r.scheduledFor) }));
  if (!cands.length) return;
  const [brake, counters] = await Promise.all([repo.activeBrake(c.id), repo.sendCounters(c.id, c.timezone)]);
  const state: SendState = {
    now, braked: !!brake,
    openerWindowOpen: isWithinWindow(now, c.timezone, c.openerWindowStart, c.openerWindowEnd),
    // The daily cap counts comment-triggered DMs recorded on conversations (comment_dm_sent_at), against the
    // ramp cap further limited by the client's own maxCommentDmsPerDay.
    openersSentToday: counters.commentDmsToday,
    openerCapToday: commentDmCap(rampCap((now.getTime() - new Date(c.launchedAt).getTime()) / 86_400_000, c.openerDailyMax), c.maxCommentDmsPerDay),
    nextOpenerAt: new Date(c.nextOpenerAt),
    sentLastHour: counters.lastHour, hourlyCap: c.hourlySendCap,
  };
  const next = pickNext(cands, state);
  if (!next) return;
  const item = await repo.claimQueueItem(next.id);
  if (!item) return;
  await executeSend(deps, c, item, now);
}

async function handleSendError(c: Client, item: repo.QueueItem, e: unknown) {
  const err = e as Error;
  const retryable = e instanceof PlatformError ? e.retryable : true;
  console.error(`[send:${c.name}] ${item.kind} #${item.id}: ${err.message}`);
  // Rate limited: honour Retry-After (never retry sooner than the platform asked), otherwise the usual 5-minute steps.
  const backoff = Math.max(item.attempts * 5 * 60_000, e instanceof PlatformError ? e.retryAfterMs ?? 0 : 0);
  if (retryable && item.attempts < 3) { await repo.rescheduleQueue(item.id, backoff, err.message); return; }
  await repo.markQueue(item.id, 'failed', err.message);
  if (item.commentId) await repo.setCommentStatus(item.commentId, 'skipped', 'send_failed');
}

export async function executeSend(deps: Deps, c: Client, item: repo.QueueItem, now = new Date()) {
  const ctx = { apiKey: c.platformApiKey, instagramAccountId: c.instagramAccountId };

  // ---------- comment opener ----------
  if (item.kind === 'opener') {
    const comment = item.commentId ? await repo.getComment(item.commentId) : null;
    if (!comment || comment.status !== 'queued') { await repo.markQueue(item.id, 'cancelled', 'comment_not_queued'); return; }
    if (!commentStillReplyable(comment.commentedAt, now)) { await repo.markQueue(item.id, 'expired', 'reply_window'); await repo.setCommentStatus(comment.id, 'expired', 'reply_window'); return; }

    const existing = await repo.findContact(c.id, comment.authorId);
    if (existing?.doNotContact || (existing && (await repo.findConversationByContact(c.id, existing.id)))) {
      await repo.markQueue(item.id, 'cancelled', 'contact_known'); await repo.setCommentStatus(comment.id, 'skipped', 'contact_known'); return;
    }
    const op = await generateOpener(deps.llm, c, { caption: comment.postCaption, text: comment.text });
    if (!op) { await repo.markQueue(item.id, 'failed', 'opener_generation_failed'); await repo.setCommentStatus(comment.id, 'skipped', 'opener_generation_failed'); return; }

    try {
      await deps.adapter.replyToComment(ctx, comment.platformCommentId, op.publicReply).catch((e) => console.warn('[public reply failed]', (e as Error).message));
      const res = await deps.adapter.sendPrivateReply(ctx, comment.platformCommentId, op.opener);
      const contact = await repo.upsertContact(c.id, res.recipientId ?? comment.authorId, comment.authorUsername ?? undefined);
      const conv = await repo.upsertConversation(c.id, contact.id, comment.isAd ? 'ad_comment' : 'comment_opener', true);
      await repo.setState(conv.id, 'qualifying');
      await repo.insertMessage({ clientId: c.id, conversationId: conv.id, direction: 'out', body: op.opener, platformMessageId: res.messageId, promptVersion: c.promptVersion });
      await repo.touchOutbound(conv.id, now);
      // Milestone: this thread started from a comment DM. Records when, and which comment / post caused it.
      const score = comment.leadScore ?? (comment.intentScore !== null && comment.fitScore !== null ? leadScoreOf(comment.intentScore, comment.fitScore) : null);
      await repo.markCommentDmSent(conv.id, { at: now, platformCommentId: comment.platformCommentId, postId: comment.postId, leadScore: score });
      await repo.addThreadEvent(c.id, conv.id, 'comment_dm_sent', {
        commentId: comment.platformCommentId, postId: comment.postId, commentText: comment.text.slice(0, 300), leadScore: score, opener: op.opener,
      }, now);
      await repo.markSent(item.id);
      await repo.setCommentStatus(comment.id, 'sent');
      await repo.setNextOpenerAt(c.id, new Date(now.getTime() + openerGapMs(Math.random, c.commentDmMinGapMinutes)));
    } catch (e) { await handleSendError(c, item, e); }
    return;
  }

  // ---------- public reply only (low-score commenter, no DM) ----------
  if (item.kind === 'public_reply') {
    const comment = item.commentId ? await repo.getComment(item.commentId) : null;
    if (!comment || comment.status !== 'queued') { await repo.markQueue(item.id, 'cancelled', 'comment_not_queued'); return; }
    const op = await generateOpener(deps.llm, c, { caption: comment.postCaption, text: comment.text });
    if (!op) { await repo.markQueue(item.id, 'failed', 'public_reply_generation_failed'); await repo.setCommentStatus(comment.id, 'skipped', 'public_reply_generation_failed'); return; }
    try {
      await deps.adapter.replyToComment(ctx, comment.platformCommentId, op.publicReply);
      await repo.markSent(item.id);
      await repo.setCommentStatus(comment.id, 'public_replied');
    } catch (e) { await handleSendError(c, item, e); }
    return;
  }

  // ---------- reply / follow-up / reminder ----------
  const conv = item.conversationId ? await repo.getConversation(item.conversationId) : null;
  if (!conv || !item.body) { await repo.markQueue(item.id, 'failed', 'missing_conversation_or_body'); return; }
  const contact = await repo.getContact(conv.contactId);
  if (!contact || contact.doNotContact || conv.state === 'do_not_contact') { await repo.markQueue(item.id, 'cancelled', 'stood_down'); return; }
  // Human takeover (with its cooldown) or paused_human mode: the person owns the thread, nothing automated goes out.
  if (isHumanPaused({ humanTakeover: conv.humanTakeover, pausedUntil: conv.pausedUntil, mode: effectiveMode(conv, c) }, now)) { await repo.markQueue(item.id, 'cancelled', 'stood_down'); return; }
  if (conv.state === 'needs_human' && item.kind !== 'reply') { await repo.markQueue(item.id, 'cancelled', 'needs_human'); return; }
  // A call got confirmed after this nudge was queued: "please book a call" is stale.
  if (item.kind === 'followup' && (CALL_CONFIRMED as string[]).includes(conv.callStatus)) { await repo.markQueue(item.id, 'cancelled', 'stale_call_confirmed'); return; }
  // 24h bump guard: strictly no automated message once Meta's window is (about to be) closed.
  const win = automatedSendAllowed(conv.lastInboundAt ? new Date(conv.lastInboundAt) : null, now);
  if (!win.ok) {
    await repo.markQueue(item.id, 'expired', 'outside_messaging_window');
    await repo.addThreadEvent(c.id, conv.id, 'send_blocked_window', { kind: item.kind }, now);
    if (item.kind === 'reply') await notifyClient(c, `Could not reply to @${contact.username ?? contact.platformUserId}: outside the messaging window. Please follow up manually.`);
    return;
  }

  // Multi-message chunking: 2-3 short bubbles with natural pauses instead of a wall of text.
  const chunks = chunkMessage(item.body);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let sent = 0;
  let fresh = 0;
  let interrupted: string | null = null;
  try {
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0) {
        await sleep(chunkGapMs(chunk));
        // A human or an opt-out may have landed during the pause: stop mid-message rather than talk over them.
        const live = await repo.getConversation(conv.id);
        const liveContact = await repo.getContact(conv.contactId);
        if (!live || !liveContact || liveContact.doNotContact || live.state === 'do_not_contact' || isHumanPaused({ humanTakeover: live.humanTakeover, pausedUntil: live.pausedUntil, mode: effectiveMode(live, c) }, new Date())) { interrupted = 'stood_down_mid_message'; break; }
      }
      // Duplicate-send brake: if this exact bubble already went out in the last 10 minutes
      // (double-triggered converse, retry after a partial send), skip it instead of spamming.
      if (await repo.recentOutboundWithBody(conv.id, chunk, 10)) { sent++; continue; }
      const res = await deps.adapter.sendDm(ctx, contact.platformUserId, chunk);
      await repo.insertMessage({ clientId: c.id, conversationId: conv.id, direction: 'out', body: chunk, platformMessageId: res.messageId, promptVersion: c.promptVersion });
      sent++; fresh++;
    }
  } catch (e) {
    if (sent === 0) { await handleSendError(c, item, e); return; }     // nothing went out: normal retry path
    interrupted = `send_failed_after_${sent}_of_${chunks.length}: ${(e as Error).message}`.slice(0, 300);   // part went out: never resend the whole thing
  }
  if (sent === 0) { await repo.markQueue(item.id, 'cancelled', interrupted ?? 'stood_down'); return; }
  if (fresh === 0) {
    // Every bubble was a repeat of something already sent: mark done, but never touch the thread again.
    await repo.markSent(item.id);
    await repo.addThreadEvent(c.id, conv.id, 'duplicate_suppressed', { kind: item.kind, bubbles: sent }, now);
    console.warn(`[send:${c.name}] duplicate suppressed #${item.id} (${sent} bubbles already sent)`);
    return;
  }

  await repo.touchOutbound(conv.id, now, item.kind === 'followup');
  await repo.markSent(item.id);
  if (interrupted) {
    await repo.addThreadEvent(c.id, conv.id, 'partial_send', { kind: item.kind, sent, of: chunks.length, reason: interrupted }, now);
    console.warn(`[send:${c.name}] partial send #${item.id}: ${interrupted}`);
  }
  if (item.kind === 'followup') await repo.addThreadEvent(c.id, conv.id, 'followup_sent', { goal: item.goal, bubbles: sent }, now);

  // Milestone: booking link sent (also moves call status to booking_link_sent).
  if (item.kind !== 'reminder' && containsBookingLink(item.body, c)) await recordBookingLinkSent(conv, c, now);
  // Ask the planner what comes next now that we are waiting on the lead again.
  if (item.kind !== 'reminder') await enqueue('plan_followup', { conversationId: conv.id }, { clientId: c.id, dedupeKey: `plan:${conv.id}` });
}
