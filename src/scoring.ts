// Pure helpers for the comment engine: cheap pre-filter, then priority scoring.

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s\u200d\ufe0f!?.,]+$/u;
const MENTION_ONLY = /^(\s*@[\w.]+\s*)+$/;
const HAS_LINK = /(https?:\/\/|www\.|\.com\/)/i;
const SPAM_HINTS = /(follow me|check my page|dm me for|promo|giveaway|crypto|forex|onlyfans|free followers)/i;

export function prefilterComment(text: string, authorId: string, ownAccountId: string): { skip: boolean; reason?: string } {
  const t = text.trim();
  if (authorId === ownAccountId) return { skip: true, reason: 'own_account' };
  if (t.length < 3) return { skip: true, reason: 'too_short' };
  if (EMOJI_ONLY.test(t)) return { skip: true, reason: 'emoji_only' };
  if (MENTION_ONLY.test(t)) return { skip: true, reason: 'tag_only' };
  if (HAS_LINK.test(t) || SPAM_HINTS.test(t)) return { skip: true, reason: 'spam_pattern' };
  return { skip: false };
}

export interface PriorityInput {
  intent: number;       // 0-100 from classifier
  fit: number;          // 0-100 from classifier
  commentedAt: Date;
  likeCount: number;
  now: Date;
}

/** intent 50%, freshness 20%, fit 20%, likes 10%. Weights are a starting guess to tune. */
export function priorityScore(i: PriorityInput): number {
  const ageHours = Math.max(0, (i.now.getTime() - i.commentedAt.getTime()) / 3_600_000);
  const freshness = Math.max(0, 1 - ageHours / (7 * 24)) * 100;
  const likes = (Math.min(Math.max(i.likeCount, 0), 10) / 10) * 100;
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return Math.round((0.5 * clamp(i.intent) + 0.2 * freshness + 0.2 * clamp(i.fit) + 0.1 * likes) * 100) / 100;
}

/** One 0-100 number for "how good a lead is this commenter": 60% intent, 40% fit. Used for the DM threshold. */
export function leadScore(intent: number, fit: number): number {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  return Math.round(0.6 * clamp(intent) + 0.4 * clamp(fit));
}

export type CommentDmGate =
  | { action: 'send' }
  | { action: 'review' | 'public_reply_only' | 'skip'; reason: string };

/** Decides whether a scored comment may trigger an automatic DM. minScore 0 (or less) disables the gate. */
export function commentDmGate(score: number, c: { minCommentDmScore: number; lowScoreAction: 'review' | 'public_reply_only' | 'skip' }): CommentDmGate {
  if (c.minCommentDmScore <= 0 || score >= c.minCommentDmScore) return { action: 'send' };
  return { action: c.lowScoreAction, reason: `below_min_score:${score}<${c.minCommentDmScore}` };
}

/** Daily comment-DM cap: the ramp cap, further limited by the client's own maxCommentDmsPerDay when set. */
export function commentDmCap(rampCapToday: number, maxCommentDmsPerDay: number | null): number {
  if (maxCommentDmsPerDay === null || maxCommentDmsPerDay === undefined) return rampCapToday;
  return Math.max(0, Math.min(rampCapToday, maxCommentDmsPerDay));
}
