import type { Deps } from './events.js';
import * as repo from '../repo.js';
import { isAttachmentOnly, runTurn } from '../ai/converse.js';
import { triageDm } from '../ai/classify.js';
import { DbToolHost } from '../host.js';
import { replyDelayMs } from '../pacing.js';
import { aiMayAct } from '../guard.js';
import { effectiveMode } from '../modes.js';
import { notifyClient } from '../notify.js';

const nowLocal = (tz: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(now);

export async function converseJob(deps: Deps, conversationId: string) {
  const conv = await repo.getConversation(conversationId);
  if (!conv) return;
  const [client, contact] = await Promise.all([repo.getClient(conv.clientId), repo.getContact(conv.contactId)]);
  if (!client || !contact || client.status === 'paused') return;
  const opMode = effectiveMode(conv, client);
  if (!aiMayAct({ state: conv.state, humanTakeover: conv.humanTakeover, pausedUntil: conv.pausedUntil, mode: opMode, contactDnc: contact.doNotContact }, new Date()).ok) return;

  // A newer message arrived after a reply was already queued: that reply no longer fits, regenerate it with the whole burst.
  await repo.cancelPendingReplies(conv.id);

  const history = await repo.loadHistory(conv.id, 30);
  const first = history.find((h) => h.direction === 'in');
  const attachmentOnly = isAttachmentOnly(history);

  // First DM from someone who messaged us: triage before spending a full conversation turn.
  // Media-only openers (voice note, shared post) skip triage: there are no words to classify.
  if (!conv.triaged && first && !attachmentOnly && conv.source !== 'comment_opener' && conv.source !== 'ad_comment') {
    const t = await triageDm(deps.llm, client, first.body);
    await repo.setTriaged(conv.id);
    if (t && (t.category === 'spam' || t.category === 'vendor_pitch')) { await repo.setState(conv.id, 'disqualified'); await repo.setNotes(conv.id, `triage:${t.category}`); return; }
    if (t && t.category === 'personal_or_complaint') {
      await repo.setState(conv.id, 'needs_human');
      await notifyClient(client, `Personal/complaint DM from @${contact.username ?? contact.platformUserId}: "${first.body.slice(0, 140)}". Not auto-replied.`);
      return;
    }
  }

  const host = new DbToolHost(client, conv, contact);
  const result = await runTurn({
    llm: deps.llm, client, history, host, opMode, attachmentOnly,
    context: { nowLocal: nowLocal(client.timezone), source: conv.source, state: conv.state, notes: conv.leadNotes, callStatus: conv.callStatus, goal: conv.conversationGoal },
  });
  if (result.text) {
    await repo.enqueueSend({ clientId: client.id, kind: 'reply', conversationId: conv.id, body: result.text, priority: 100, delayMs: replyDelayMs(result.text) });
  }
}
