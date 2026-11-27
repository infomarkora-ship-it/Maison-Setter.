import type { Deps } from './events.js';
import { q } from '../db.js';
import * as repo from '../repo.js';
import { enqueue, enqueueDebounced, hasPendingJob, scheduleJobAt } from '../jobs.js';
import { planFollowUp, runTurn } from '../ai/converse.js';
import { DbToolHost } from '../host.js';
import { evaluateBrakes, isWithinWindow } from '../pacing.js';
import { automatedSendAllowed, followUpHardBlock, guardFollowUp, isHumanPaused, nextOpenTime, nudgeDeadline, type FollowUpContext } from '../guard.js';
import { defaultGoal, effectiveMode, MODE_PROFILES } from '../modes.js';
import { alertOperator, notifyClient } from '../notify.js';
import type { Client, ConversationGoal } from '../types.js';

const minutesAgo = (d: Date | null, now: Date) => (d ? Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 60_000)) : null);

function contextFor(client: Client, conv: repo.Conversation, contactDnc: boolean, now: Date): FollowUpContext {
  const mode = effectiveMode(conv, client);
  return {
    now, mode, state: conv.state, callStatus: conv.callStatus, contactDnc, followupsSent: conv.followupsSent,
    humanPaused: isHumanPaused({ humanTakeover: conv.humanTakeover, pausedUntil: conv.pausedUntil, mode }, now),
    lastInboundAt: conv.lastInboundAt ? new Date(conv.lastInboundAt) : null,
    timezone: client.timezone, windowStart: client.openerWindowStart, windowEnd: client.openerWindowEnd,
  };
}

/**
 * Free-thinking planner. After we message a lead, the model reads the conversation and the timing signals and decides
 * whether to follow up, when, why (the goal) and what angle to take. guardFollowUp() then clamps that plan to the hard limits.
 * If the model is unavailable the mode's default cadence is used, so a planner outage never silently stops follow-ups.
 */
export async function planJob(deps: Deps, conversationId: string, now = new Date()) {
  const conv = await repo.getConversation(conversationId);
  if (!conv) return;
  const [client, contact] = await Promise.all([repo.getClient(conv.clientId), repo.getContact(conv.contactId)]);
  if (!client || !contact || client.status === 'paused') return;
  const ctx = contextFor(client, conv, contact.doNotContact, now);
  const profile = MODE_PROFILES[ctx.mode].followUp;

  // Hard blocks first: no model spend when the answer cannot be "yes".
  const pre = guardFollowUp({ shouldFollowUp: true, delayMinutes: profile.minDelayMin, goal: defaultGoal(conv.callStatus, ctx.mode) }, ctx);
  if (!pre.ok) { await declinePlan(client, conv, pre.reason, now); return; }

  const history = await repo.loadHistory(conv.id, 30);
  const sig = {
    nowLocal: new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeStyle: 'short', timeZone: client.timezone }).format(now),
    state: conv.state, callStatus: conv.callStatus, currentGoal: conv.conversationGoal, leadScore: conv.leadScore, followupsSent: conv.followupsSent,
    minutesSinceLastReply: minutesAgo(conv.lastInboundAt, now), minutesSinceLastOutbound: minutesAgo(conv.lastOutboundAt, now),
    minutesSinceBookingLink: minutesAgo(conv.bookingLinkSentAt, now), minutesSinceCommentDm: minutesAgo(conv.commentDmSentAt, now),
    source: conv.source, notes: conv.leadNotes,
  };
  const plan = await planFollowUp(deps.llm, client, ctx.mode, history, sig).catch((e) => { console.error('[planner]', (e as Error).message); return null; });

  const goal: ConversationGoal = plan?.goal ?? defaultGoal(conv.callStatus, ctx.mode);
  const decision = guardFollowUp(
    { shouldFollowUp: plan ? plan.should_follow_up : true, delayMinutes: plan ? plan.recommended_delay_minutes : profile.defaultDelayMin, goal }, ctx);
  if (plan) await repo.setLeadScore(conv.id, plan.lead_score);

  if (!decision.ok) { await declinePlan(client, conv, decision.reason, now, goal); return; }
  await repo.setPlan(conv.id, {
    at: decision.at, goal, leadScore: plan?.lead_score ?? null,
    rationale: plan?.rationale ?? 'Planner unavailable: default cadence for this mode.',
    angle: plan?.message_angle ?? '',
  });
  await repo.addThreadEvent(client.id, conv.id, 'followup_planned', {
    at: decision.at.toISOString(), delayMinutes: decision.delayMinutes, goal, rationale: plan?.rationale ?? 'default_cadence', usedModel: !!plan,
  });
  await scheduleJobAt('followup', { conversationId: conv.id, n: conv.followupsSent + 1 }, { clientId: client.id, runAt: decision.at, dedupeKey: `followup:${conv.id}` });
}

async function declinePlan(client: Client, conv: repo.Conversation, reason: string, now: Date, goal?: ConversationGoal) {
  await repo.cancelPendingFollowups(conv.id, `not_planned:${reason}`);
  await repo.clearPlan(conv.id, goal ?? conv.conversationGoal);
  await repo.addThreadEvent(client.id, conv.id, 'followup_not_planned', { reason }, now);
  // A canceled / no-show lead we can no longer reach automatically needs a person.
  if (reason === 'no_slot_inside_messaging_window' && (conv.callStatus === 'call_canceled' || conv.callStatus === 'call_no_show')) {
    const c = await repo.getContact(conv.contactId);
    await notifyClient(client, `@${c?.username ?? c?.platformUserId ?? 'a lead'} ${conv.callStatus === 'call_no_show' ? 'missed' : 'canceled'} their call and Meta's 24h window is about to close or has closed. Reach out manually.`);
  }
}

/** Fires at the planned time: re-checks every hard guard against the CURRENT state, then writes and queues the message. */
export async function followupJob(deps: Deps, conversationId: string, n: number, now = new Date()) {
  const conv = await repo.getConversation(conversationId);
  if (!conv || await repo.hasPendingSend(conv.id)) return;
  const [client, contact] = await Promise.all([repo.getClient(conv.clientId), repo.getContact(conv.contactId)]);
  if (!client || !contact || client.status === 'paused') return;
  // Send hold (dashboard pause button): keep the plan on the board, send nothing.
  // When the hold lifts, followupScan re-enqueues anything still due.
  if (client.sendHold) {
    await repo.addThreadEvent(client.id, conv.id, 'send_hold_skipped', { kind: 'followup', plannedFor: conv.nextFollowUpAt?.toISOString() ?? null }, now);
    return;
  }

  const ctx = contextFor(client, conv, contact.doNotContact, now);
  const blocked = followUpHardBlock(ctx);
  if (blocked) { await repo.clearPlan(conv.id, conv.conversationGoal); await repo.addThreadEvent(client.id, conv.id, 'followup_cancelled', { reason: blocked }, now); return; }
  const win = automatedSendAllowed(ctx.lastInboundAt, now);
  if (!win.ok) { await repo.clearPlan(conv.id, conv.conversationGoal); await repo.addThreadEvent(client.id, conv.id, 'followup_cancelled', { reason: win.reason }, now); return; }
  // Outside the client's outreach hours: move to the next open slot if one still fits inside the messaging window.
  if (!isWithinWindow(now, client.timezone, client.openerWindowStart, client.openerWindowEnd)) {
    const next = ctx.lastInboundAt ? nextOpenTime(now, client.timezone, client.openerWindowStart, client.openerWindowEnd, nudgeDeadline(ctx.lastInboundAt)) : null;
    if (next) { await scheduleJobAt('followup', { conversationId: conv.id, n }, { clientId: client.id, runAt: next, dedupeKey: `followup:${conv.id}` }); await repo.setPlan(conv.id, { at: next, goal: conv.conversationGoal ?? defaultGoal(conv.callStatus, ctx.mode), rationale: conv.followUpRationale ?? '', angle: conv.followUpAngle ?? '' }); return; }
    await repo.clearPlan(conv.id, conv.conversationGoal); await repo.addThreadEvent(client.id, conv.id, 'followup_cancelled', { reason: 'outside_outreach_hours' }, now); return;
  }

  const goal = conv.conversationGoal ?? defaultGoal(conv.callStatus, ctx.mode);
  const history = await repo.loadHistory(conv.id, 30);
  const host = new DbToolHost(client, conv, contact);
  const r = await runTurn({
    llm: deps.llm, client, history, host, mode: 'followup', followupNumber: n, opMode: ctx.mode, goal, angle: conv.followUpAngle,
    context: { nowLocal: now.toISOString(), source: conv.source, state: conv.state, notes: conv.leadNotes, callStatus: conv.callStatus, goal },
  });
  await repo.clearPlan(conv.id, goal);
  if (r.text) {
    await repo.enqueueSend({ clientId: client.id, kind: 'followup', conversationId: conv.id, body: r.text, priority: 50, delayMs: Math.round(Math.random() * 3 * 60_000), goal });
    await repo.addThreadEvent(client.id, conv.id, 'followup_queued', { goal, n }, now);
  }
}

/**
 * Safety net (every 10 min). The planner normally schedules follow-ups itself after each outbound message; this finds
 *  (a) threads that are waiting on the lead with no plan and no pending planner job (a planner job was lost), and
 *  (b) planned follow-ups that came due but whose scheduled job vanished.
 */
export async function followupScan(now = new Date()) {
  const unplanned = await q<{ conversationId: string; clientId: string }>(
    `SELECT c.id AS conversation_id, c.client_id
     FROM conversations c JOIN clients cl ON cl.id = c.client_id
     WHERE cl.status IN ('pilot','active') AND c.human_takeover = false AND c.mode IS DISTINCT FROM 'paused_human'
       AND c.state IN ('qualifying','qualified','objection','scheduling')
       AND c.call_status NOT IN ('call_booked','call_rescheduled','call_completed')
       AND c.next_follow_up_at IS NULL
       AND c.last_outbound_at IS NOT NULL AND c.last_inbound_at IS NOT NULL AND c.last_inbound_at < c.last_outbound_at
       AND c.last_outbound_at < now() - interval '15 minutes'
       AND c.last_inbound_at > now() - interval '23 hours'
       AND c.followups_sent < 4
       AND NOT EXISTS (SELECT 1 FROM send_queue s WHERE s.conversation_id = c.id AND s.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status = 'pending' AND j.type IN ('plan_followup','followup') AND j.payload->>'conversationId' = c.id::text)
       AND NOT EXISTS (SELECT 1 FROM thread_events e WHERE e.conversation_id = c.id AND e.kind = 'followup_not_planned' AND e.at > c.last_outbound_at)
     LIMIT 100`);
  for (const r of unplanned) await enqueue('plan_followup', { conversationId: r.conversationId }, { clientId: r.clientId, dedupeKey: `plan:${r.conversationId}` });

  const due = await q<{ conversationId: string; clientId: string; followupsSent: number }>(
    `SELECT c.id AS conversation_id, c.client_id, c.followups_sent
     FROM conversations c JOIN clients cl ON cl.id = c.client_id
     WHERE cl.status IN ('pilot','active') AND c.next_follow_up_at IS NOT NULL AND c.next_follow_up_at <= $1
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status = 'pending' AND j.type = 'followup' AND j.payload->>'conversationId' = c.id::text)
     LIMIT 100`, [now]);
  for (const r of due) await enqueue('followup', { conversationId: r.conversationId, n: r.followupsSent + 1 }, { clientId: r.clientId, dedupeKey: `followup:${r.conversationId}` });
}

/** Ends human-takeover cooldowns. If the lead wrote while the AI was paused and nobody answered, the AI picks that up. */
export async function pauseExpiryScan(now = new Date()) {
  const rows = await q<{ id: string; clientId: string; lastInboundAt: Date | null; lastOutboundAt: Date | null }>(
    `UPDATE conversations SET human_takeover = false, paused_until = NULL
     WHERE human_takeover = true AND paused_until IS NOT NULL AND paused_until <= $1 AND state NOT IN ('needs_human','do_not_contact')
     RETURNING id, client_id, last_inbound_at, last_outbound_at`, [now]);
  for (const r of rows) {
    await repo.addThreadEvent(r.clientId, r.id, 'ai_resumed', { reason: 'cooldown_elapsed' }, now);
    const unanswered = r.lastInboundAt && (!r.lastOutboundAt || new Date(r.lastInboundAt) > new Date(r.lastOutboundAt));
    if (unanswered) await enqueueDebounced('converse', { conversationId: r.id }, { clientId: r.clientId, dedupeKey: `converse:${r.id}`, windowMs: 5_000 });
    else if (!(await hasPendingJob('plan_followup', r.id))) await enqueue('plan_followup', { conversationId: r.id }, { clientId: r.clientId, dedupeKey: `plan:${r.id}` });
  }
  return rows.length;
}

/** 24h and 2h reminders. The sender drops any that fall outside the DM window; use the calendar's own email reminders as backup. */
export async function reminderScan() {
  const rows = await q<{ id: string; clientId: string; conversationId: string; startsAt: Date; name: string; tz: string; r24: boolean }>(
    `SELECT a.id, a.client_id, a.conversation_id, a.starts_at, cl.name, cl.timezone AS tz,
            (a.starts_at > now() + interval '12 hours') AS r24
     FROM appointments a JOIN clients cl ON cl.id = a.client_id
     WHERE a.status IN ('booked','confirmed') AND cl.status IN ('pilot','active')
       AND ((NOT a.reminder24_sent AND a.starts_at BETWEEN now() + interval '22 hours' AND now() + interval '26 hours')
         OR (NOT a.reminder2_sent AND a.starts_at BETWEEN now() + interval '90 minutes' AND now() + interval '150 minutes'))`);
  for (const r of rows) {
    const when = new Intl.DateTimeFormat('en-CA', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: r.tz }).format(new Date(r.startsAt));
    const body = r.r24
      ? `Quick reminder: you're booked with ${r.name} ${when}. Reply here if you need to change it.`
      : `See you soon! Your appointment with ${r.name} is at ${when}. Reply here if anything's come up.`;
    await repo.enqueueSend({ clientId: r.clientId, kind: 'reminder', conversationId: r.conversationId, body, priority: 80 });
    await q(`UPDATE appointments SET ${r.r24 ? 'reminder24_sent' : 'reminder2_sent'} = true WHERE id = $1`, [r.id]);
  }
}

/** Trips a per-client brake (never global) when reply rate, errors or negative signals look bad. */
export async function brakeScan() {
  for (const c of await repo.listLiveClients()) {
    if (await repo.activeBrake(c.id)) continue;
    const verdict = evaluateBrakes(await repo.brakeStats(c.id));
    if (verdict.brake) {
      await repo.createBrake(c.id, verdict.reason ?? 'unknown', verdict.hours);
      await alertOperator(`Brake on ${c.name}: ${verdict.reason}. Openers paused ${verdict.hours}h; replies to inbound DMs continue.`);
    }
  }
}

const lastSilenceAlert = new Map<string, number>();
/** If a live client's webhook goes quiet for 48h, either their account disconnected or your webhook is broken. */
export async function silenceCheck() {
  const rows = await q<{ id: string; name: string }>(
    `SELECT cl.id, cl.name FROM clients cl
     WHERE cl.status IN ('pilot','active') AND cl.launched_at < now() - interval '2 days'
       AND NOT EXISTS (SELECT 1 FROM raw_events r WHERE r.client_id = cl.id AND r.received_at > now() - interval '48 hours')`);
  for (const r of rows) {
    if (Date.now() - (lastSilenceAlert.get(r.id) ?? 0) < 24 * 3_600_000) continue;
    lastSilenceAlert.set(r.id, Date.now());
    await alertOperator(`${r.name}: no webhook events for 48h. Check the InstantDM connection and webhook URL.`);
  }
}
