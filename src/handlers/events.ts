import type { Llm } from '../ai/llm.js';
import type { ChannelAdapter } from '../platform/types.js';
import type { Attachment, Client, NormalizedEvent } from '../types.js';
import * as repo from '../repo.js';
import { enqueue, enqueueDebounced } from '../jobs.js';
import { prefilterComment } from '../scoring.js';
import { aiMayAct, isOptOut } from '../guard.js';
import { debounceWindowMs } from '../pacing.js';
import { dmBody } from '../platform/instantdm.js';
import { effectiveMode } from '../modes.js';

export interface Deps {
  llm: Llm;
  adapter: ChannelAdapter;
  /** Injectable pause between chat bubbles (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export async function processEvent(deps: Deps, rawEventId: number) {
  const raw = await repo.getRawEvent(rawEventId);
  if (!raw) return;
  const client = await repo.getClient(raw.clientId);
  if (!client || client.status === 'paused') { await repo.markRawProcessed(rawEventId, 'client_paused_or_missing'); return; }
  try {
    const events = deps.adapter.normalize(raw.payload);
    for (const ev of events) await handleEvent(deps, client, ev);
    // Record WHY nothing happened, so a real DM with an unexpected envelope is diagnosable from the DB and logs.
    if (events.length && events.every((ev) => ev.type === 'ignored')) {
      const keys = Object.keys((raw.payload ?? {}) as object);
      console.warn(`[process_event] raw event ${rawEventId} matched no handler (event shape not recognized). Payload keys: ${keys.join(', ') || '(empty)'}`);
      await repo.markRawProcessed(rawEventId, 'unmatched_event_shape');
      return;
    }
    await repo.markRawProcessed(rawEventId);
  } catch (e) {
    await repo.markRawProcessed(rawEventId, (e as Error).message);
    throw e;   // let the job retry
  }
}

interface InboundInput {
  platformUserId: string; username?: string; messageId: string; text: string; at: Date; isStoryReply?: boolean; attachments?: Attachment[];
  /** Label stored in the thread timeline, e.g. 'postback' | 'question_answered'. */
  via?: string;
}

/** Shared path for every inbound message-like event (DM, button postback, answered question). */
async function ingestInbound(deps: Deps, client: Client, m: InboundInput) {
  const contact = await repo.upsertContact(client.id, m.platformUserId, m.username);
  if (contact.doNotContact) return;
  const conv = await repo.upsertConversation(client.id, contact.id, m.isStoryReply ? 'story_reply' : 'inbound_dm');
  const body = dmBody(m.text, m.attachments) || '[attachment]';
  const fresh = await repo.insertMessage({ clientId: client.id, conversationId: conv.id, direction: 'in', body, platformMessageId: m.messageId, at: m.at });
  if (!fresh) return;                                         // duplicate delivery: never double-reply or double-schedule

  await repo.touchInbound(conv.id, m.at);
  // They answered, so any planned nudge is obsolete (the planner re-plans after our next reply) and the unanswered streak resets.
  await repo.cancelPendingFollowups(conv.id, 'lead_replied');
  await repo.clearPlan(conv.id, conv.conversationGoal);
  await repo.resetUnansweredFollowups(conv.id);
  if (m.attachments?.length) await repo.addThreadEvent(client.id, conv.id, 'attachment_received', { kinds: m.attachments.map((a) => a.kind) }, m.at);
  if (m.via) await repo.addThreadEvent(client.id, conv.id, m.via, { text: m.text.slice(0, 200) }, m.at);

  if (m.text && isOptOut(m.text)) {
    await repo.markContactDnc(contact.id);
    await repo.setState(conv.id, 'do_not_contact');
    await repo.cancelPendingSends(conv.id);
    await repo.addSignal(client.id, 'optout', contact.id);
    await repo.addThreadEvent(client.id, conv.id, 'opt_out', {}, m.at);
    try {
      await deps.adapter.sendDm({ apiKey: client.platformApiKey, instagramAccountId: client.instagramAccountId }, m.platformUserId, "No problem, I won't message you again.");
    } catch { /* best effort */ }
    return;
  }

  // Human takeover / needs_human / paused mode: the message is stored for the transcript, the AI stays quiet.
  const may = aiMayAct({ state: conv.state, humanTakeover: conv.humanTakeover, pausedUntil: conv.pausedUntil, mode: effectiveMode(conv, client), contactDnc: contact.doNotContact }, new Date());
  if (!may.ok) return;

  // Rapid-fire debounce: every new message pushes the single pending job back 4-6s (capped), so the AI reads the whole burst.
  await enqueueDebounced('converse', { conversationId: conv.id }, { clientId: client.id, dedupeKey: `converse:${conv.id}`, windowMs: debounceWindowMs(), maxWaitMs: 20_000 });
}

export async function handleEvent(deps: Deps, client: Client, ev: NormalizedEvent) {
  switch (ev.type) {
    case 'ignored': return;

    case 'negative_signal': {
      const contact = ev.platformUserId ? await repo.findContact(client.id, ev.platformUserId) : null;
      if (contact) {
        await repo.markContactDnc(contact.id);
        const conv = await repo.findConversationByContact(client.id, contact.id);
        if (conv) {
          await repo.setState(conv.id, 'do_not_contact'); await repo.cancelPendingSends(conv.id);
          await repo.cancelPendingFollowups(conv.id, ev.kind); await repo.clearPlan(conv.id, null);
        }
      }
      await repo.addSignal(client.id, ev.kind, contact?.id);
      return;
    }

    case 'echo': {
      // A message the business account sent. If we did not send it, a human did: stand down for the cooldown.
      const contact = await repo.findContact(client.id, ev.recipientId);
      if (!contact) return;
      const conv = await repo.findConversationByContact(client.id, contact.id);
      if (!conv) return;
      const ours = (await repo.messageIdKnown(client.id, ev.messageId)) || (await repo.recentOutboundWithBody(conv.id, ev.text));
      if (ours) return;
      await repo.insertMessage({ clientId: client.id, conversationId: conv.id, direction: 'out', body: ev.text || '(human message)', platformMessageId: ev.messageId, at: ev.at });
      await repo.touchOutbound(conv.id, ev.at);     // the human answered: do not resume by replying to an already-answered message
      const until = new Date(ev.at.getTime() + client.humanPauseHours * 3_600_000);
      await repo.startHumanPause(conv.id, until);   // every new human message extends the cooldown
      await repo.cancelPendingSends(conv.id);
      await repo.cancelPendingFollowups(conv.id, 'human_takeover');
      await repo.clearPlan(conv.id, conv.conversationGoal);
      await repo.addThreadEvent(client.id, conv.id, 'human_takeover', { pausedUntil: until.toISOString() }, ev.at);
      return;
    }

    case 'dm':
      return ingestInbound(deps, client, { platformUserId: ev.platformUserId, username: ev.username, messageId: ev.messageId, text: ev.text, at: ev.at, isStoryReply: ev.isStoryReply, attachments: ev.attachments });

    case 'postback':
      // A button tap is the lead talking: treat the button label as their message.
      return ingestInbound(deps, client, { platformUserId: ev.platformUserId, username: ev.username, messageId: ev.messageId, text: ev.title ?? ev.payload, at: ev.at, via: 'postback' });

    case 'question_answered':
      return ingestInbound(deps, client, { platformUserId: ev.platformUserId, username: ev.username, messageId: ev.messageId, text: ev.answer, at: ev.at, via: 'question_answered' });

    case 'flow_completed': {
      // A milestone only. It does not open the 24h window and does not trigger a reply by itself.
      const contact = await repo.findContact(client.id, ev.platformUserId);
      const conv = contact ? await repo.findConversationByContact(client.id, contact.id) : null;
      if (conv) await repo.addThreadEvent(client.id, conv.id, 'flow_completed', { flow: ev.flowName ?? null }, ev.at);
      return;
    }

    case 'comment': {
      const pre = prefilterComment(ev.text, ev.authorId, client.instagramAccountId);
      const row = await repo.insertComment({
        clientId: client.id, platformCommentId: ev.commentId, postId: ev.postId, postCaption: ev.postCaption, isAd: ev.isAd,
        authorId: ev.authorId, authorUsername: ev.username, text: ev.text, likeCount: ev.likeCount, commentedAt: ev.at,
      });
      if (!row) return;                                           // duplicate
      if (pre.skip) { await repo.setCommentStatus(row.id, 'skipped', `prefilter:${pre.reason}`); return; }
      await enqueue('classify_comment', { commentId: row.id }, { clientId: client.id });
      return;
    }
  }
}
