import type { Deps } from './events.js';
import * as repo from '../repo.js';
import { classifyComment } from '../ai/classify.js';
import { commentDmGate, leadScore, priorityScore } from '../scoring.js';
import { commentStillReplyable } from '../pacing.js';
import { notifyClient } from '../notify.js';

export async function classifyCommentJob(deps: Deps, commentId: string, now = new Date()) {
  const c = await repo.getComment(commentId);
  if (!c || c.status !== 'pending') return;
  const client = await repo.getClient(c.clientId);
  if (!client || client.status === 'paused') return;

  if (!commentStillReplyable(c.commentedAt, now)) { await repo.setCommentStatus(c.id, 'expired', 'too_old'); return; }

  // Already talking to this person (or they opted out)? Never open a second thread.
  const existing = await repo.findContact(client.id, c.authorId);
  if (existing?.doNotContact) { await repo.setCommentStatus(c.id, 'skipped', 'do_not_contact'); return; }
  if (existing && (await repo.findConversationByContact(client.id, existing.id))) { await repo.setCommentStatus(c.id, 'skipped', 'already_in_conversation'); return; }

  const v = await classifyComment(deps.llm, client, { caption: c.postCaption, text: c.text });
  if (!v) { await repo.setCommentStatus(c.id, 'skipped', 'classifier_failed'); return; }   // fail closed

  if (v.decision === 'flag') {
    await repo.setCommentVerdict(c.id, { decision: v.decision, intent: v.intent_score, fit: v.fit_score, reason: v.reason, status: 'flagged' });
    await notifyClient(client, `Flagged comment from @${c.authorUsername ?? c.authorId}: "${c.text.slice(0, 120)}" (${v.reason})`);
    return;
  }
  const lead = leadScore(v.intent_score, v.fit_score);
  if (v.decision === 'ignore' || v.intent_score < client.minIntentScore) {
    await repo.setCommentVerdict(c.id, { decision: v.decision, intent: v.intent_score, fit: v.fit_score, reason: v.reason, status: 'skipped', leadScore: lead });
    return;
  }
  const priority = priorityScore({ intent: v.intent_score, fit: v.fit_score, commentedAt: c.commentedAt, likeCount: c.likeCount, now });
  const verdict = { decision: v.decision, intent: v.intent_score, fit: v.fit_score, priority, leadScore: lead };

  // Score threshold: below minCommentDmScore the commenter does not get an automatic DM.
  const gate = commentDmGate(lead, client);
  if (gate.action === 'review') {
    await repo.setCommentVerdict(c.id, { ...verdict, reason: `${gate.reason}; ${v.reason}`.slice(0, 300), status: 'review' });     // dashboard review queue; approve to send
    return;
  }
  if (gate.action === 'skip') {
    await repo.setCommentVerdict(c.id, { ...verdict, reason: `${gate.reason}; ${v.reason}`.slice(0, 300), status: 'skipped' });
    return;
  }
  if (gate.action === 'public_reply_only') {
    await repo.setCommentVerdict(c.id, { ...verdict, reason: `${gate.reason}; ${v.reason}`.slice(0, 300), status: 'queued' });
    await repo.enqueueSend({ clientId: client.id, kind: 'public_reply', commentId: c.id, priority });
    return;
  }
  await repo.setCommentVerdict(c.id, { ...verdict, reason: v.reason, status: 'queued' });
  // Opener text is generated at send time (fresher, and no tokens spent on openers that never go out).
  // The daily cap and pacing are enforced by the sender when it picks the next item.
  await repo.enqueueSend({ clientId: client.id, kind: 'opener', commentId: c.id, priority });
}

/** Dashboard "approve": a reviewed low-score comment becomes a normal queued opener. */
export async function approveReviewedComment(commentId: string): Promise<boolean> {
  const c = await repo.getComment(commentId);
  if (!c || c.status !== 'review') return false;
  await repo.setCommentQueued(c.id);
  await repo.enqueueSend({ clientId: c.clientId, kind: 'opener', commentId: c.id, priority: Number(c.priorityScore ?? 0) });
  return true;
}
