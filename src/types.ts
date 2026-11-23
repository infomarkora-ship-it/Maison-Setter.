export type Source = 'inbound_dm' | 'story_reply' | 'comment_opener' | 'ad_comment';

export type ConversationState =
  | 'new' | 'qualifying' | 'qualified' | 'objection' | 'scheduling'
  | 'booked' | 'lost' | 'disqualified' | 'needs_human' | 'do_not_contact';

export type QueueKind = 'reply' | 'followup' | 'reminder' | 'opener' | 'public_reply';

/** How the AI behaves on a thread. Set per client (default) and overridable per conversation. */
export type OperatingMode = 'qualify_and_book' | 'soft_nurture' | 'direct_closer' | 'noshow_recovery' | 'paused_human';

/** Lifecycle of the sales call itself, tracked separately from the chat state. */
export type CallStatus =
  | 'no_booking_link_sent' | 'booking_link_sent' | 'call_booked' | 'call_rescheduled'
  | 'call_canceled' | 'call_completed' | 'call_no_show';

/** What the next follow-up touch is for. Chosen by the planner, never a generic "just checking in". */
export type ConversationGoal =
  | 'qualify_fit' | 'clarify_objection' | 'confirm_preferred_slot'
  | 'get_booking_completed' | 'recover_no_show' | 'rebook_canceled';

/** What to do with a commenter whose lead score is below the client's threshold. */
export type LowScoreAction = 'review' | 'public_reply_only' | 'skip';

export type AttachmentKind = 'audio' | 'image' | 'video' | 'share' | 'story_mention' | 'file' | 'unknown';
export interface Attachment { kind: AttachmentKind; url?: string }

export interface ClientSettings {
  businessSummary: string;          // 2-4 sentences: what the business does
  offer: string;                    // what we are booking people for
  idealCustomer: string;
  disqualifiers: string[];
  qualificationQuestions: string[]; // things to find out before booking
  tone: string;                     // e.g. "friendly, casual, a bit of humour"
  forbiddenClaims: string[];        // phrases/claims the AI must never make
  bookingLink?: string;             // only URL the AI may send
  languages?: string[];
}

export interface Client {
  id: string;
  name: string;
  status: 'pilot' | 'active' | 'paused';
  timezone: string;
  webhookSecret: string;
  platformApiKey: string;
  instagramAccountId: string;
  settings: ClientSettings;
  knowledge: string;
  commissionRate: number;
  attributionDays: number;
  openerDailyMax: number;
  openerWindowStart: number;
  openerWindowEnd: number;
  hourlySendCap: number;
  minIntentScore: number;
  notifyWebhookUrl: string | null;
  calendarProvider: 'link' | 'cal_com' | 'mock';
  calendarConfig: Record<string, unknown>;
  launchedAt: Date;
  nextOpenerAt: Date;
  promptVersion: string;
  /** Mode used by threads that have no mode of their own. */
  defaultMode: OperatingMode;
  /** Comment commenters scoring below this (0-100, see leadScore()) do not get an automatic DM. 0 = off. */
  minCommentDmScore: number;
  /** Max comment-triggered DMs per local day. null = fall back to openerDailyMax (still ramped). */
  maxCommentDmsPerDay: number | null;
  /** Minimum gap between two comment-triggered DMs, minutes (a random extra 0-8 min is added). */
  commentDmMinGapMinutes: number;
  lowScoreAction: LowScoreAction;
  /** How long the AI stays quiet after a human types in the thread. */
  humanPauseHours: number;
  /** Per-client HMAC secret for X-Webhook-Signature. Falls back to INSTANTDM_WEBHOOK_SECRET. */
  instantdmWebhookSecret: string | null;
}

/** One turn of chat history as stored. */
export interface Turn {
  direction: 'in' | 'out';
  body: string;
  createdAt: Date;
}

export type NormalizedEvent =
  | { type: 'dm'; eventId: string; platformUserId: string; username?: string; messageId: string; text: string; at: Date; isStoryReply?: boolean; attachments?: Attachment[] }
  | { type: 'postback'; eventId: string; platformUserId: string; username?: string; messageId: string; payload: string; title?: string; at: Date }
  | { type: 'question_answered'; eventId: string; platformUserId: string; username?: string; messageId: string; question?: string; answer: string; at: Date }
  | { type: 'flow_completed'; eventId: string; platformUserId: string; username?: string; flowName?: string; at: Date }
  | { type: 'echo'; eventId: string; recipientId: string; messageId: string; text: string; at: Date }
  | { type: 'comment'; eventId: string; commentId: string; postId?: string; postCaption?: string; isAd?: boolean; authorId: string; username?: string; text: string; likeCount?: number; at: Date }
  | { type: 'negative_signal'; eventId: string; platformUserId?: string; kind: 'block' | 'report' | 'optout' }
  | { type: 'ignored'; eventId: string };

export interface ToolHost {
  searchKnowledge(query: string): Promise<string>;
  checkAvailability(fromIso: string, toIso: string): Promise<string[]>;
  book(a: { startIso: string; name: string; email?: string; phone?: string; notes?: string }): Promise<{ ok: boolean; message: string }>;
  updateStatus(status: ConversationState, reason: string): Promise<string>;
  handoff(reason: string, urgency: 'low' | 'high'): Promise<string>;
  markDoNotContact(reason: string): Promise<string>;
}
