import * as repo from '../repo.js';
import { askContextBot, type BotThread, type ContextAnswer } from '../contextbot.js';
import type { Llm } from '../ai/llm.js';

export async function loadBotThread(conversationId: string): Promise<BotThread | null> {
  const conv = await repo.getConversation(conversationId);
  if (!conv) return null;
  const [client, contact, history, events] = await Promise.all([
    repo.getClient(conv.clientId), repo.getContact(conv.contactId), repo.loadHistory(conv.id, 400), repo.listThreadEvents(conv.id),
  ]);
  if (!client || !contact) return null;
  return {
    conversationId: conv.id, username: contact.username, source: conv.source, state: conv.state, callStatus: conv.callStatus, mode: conv.mode,
    leadScore: conv.leadScore, goal: conv.conversationGoal, nextFollowUpAt: conv.nextFollowUpAt ? new Date(conv.nextFollowUpAt) : null,
    followUpRationale: conv.followUpRationale, bookingLinkSentAt: conv.bookingLinkSentAt ? new Date(conv.bookingLinkSentAt) : null,
    commentDmSentAt: conv.commentDmSentAt ? new Date(conv.commentDmSentAt) : null, commentDmCommentId: conv.commentDmCommentId, commentDmPostId: conv.commentDmPostId,
    firstTouchAt: new Date(conv.firstTouchAt), timezone: client.timezone,
    messages: history.map((h) => ({ direction: h.direction, body: h.body, at: new Date(h.createdAt) })),
    events: events.map((e) => ({ kind: e.kind, at: new Date(e.at), data: e.data })),
  };
}

export async function askAboutThread(llm: Llm | null, conversationId: string, question: string): Promise<ContextAnswer | null> {
  const thread = await loadBotThread(conversationId);
  return thread ? askContextBot(llm, thread, question) : null;
}
