import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type { Attachment, AttachmentKind, NormalizedEvent } from '../types.js';
import { PlatformError, type ChannelAdapter, type SendCtx } from './types.js';

/**
 * ============================  PAYLOAD SPEC  ============================
 * Confirmed from the InstantDM docs (treat as fact):
 *   Outbound: POST https://openapi.instantdm.com/action
 *             Authorization: Bearer <INSTANTDM_API_KEY>, Content-Type: application/json
 *   A. DM:        { action: "send_message", type: "dm", recipient_id, message: { text } }
 *   B. Public reply: { action: "post_comment", comment_id, comment_text }
 *   C. Private reply to a comment:
 *                 { action: "send_message", type: "comment_reply", comment_id, message: { text } }
 *   Inbound events (POST /webhooks/instantdm/:clientId):
 *     new comment, comment reply, live comment, new DM (dm_received), story reply, postback,
 *     question_answered, flow_completed, message sent (echo/outbound) — signed with
 *     X-Webhook-Signature = HMAC-SHA256(raw body, webhook secret). Deduped by event id.
 *
 * ASSUMED (not in the docs; verify against real payloads in `raw_events`):
 *   - The event name is in `event` or `type`; fields may sit at the top level or under `data`.
 *   - Sender id: sender_id | from_id | user_id | contact_id (or nested sender.id / from.id).
 *   - DM text: text | message | message.text.  Attachments: `attachments: [{ type, url }]`.
 *   - comment: comment_id, text|comment, media_id, media_caption, from_id, username.
 *   - Echo / outbound copies of messages the business account sent: event name containing
 *     "echo" or "outbound" (or dm_sent / message_sent), with recipient_id + message_id + text.
 * Everything else in the bot talks only to the ChannelAdapter interface.
 * ==============================================================================
 */

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Top-level fields overlaid with anything nested under `data`. */
const flatten = (raw: unknown): Json => ({ ...obj(raw), ...obj(obj(raw).data) });
const kindOf = (raw: unknown): string => {
  const root = obj(raw);
  return (str(root.event) ?? str(root.type) ?? str(root.event_type) ?? '').toLowerCase();
};

/** Stable dedupe key: the platform's event id, else a message / comment id, else a content hash. */
export function eventKey(raw: unknown): string {
  const o = flatten(raw);
  const id = str(o.event_id) ?? str(o.id);
  if (id) return id;
  const msg = str(o.message_id) ?? str(o.mid);
  if (msg) return `${kindOf(raw) || 'msg'}:${msg}`;
  const cm = str(o.comment_id);
  if (cm) return `comment:${cm}`;
  return createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex');
}

const ATTACHMENT_KINDS: Array<[RegExp, AttachmentKind]> = [
  [/audio|voice|ptt/, 'audio'],
  [/story_mention|mention/, 'story_mention'],
  [/share|reel_share|story_share|post/, 'share'],
  [/image|photo|picture|sticker|gif/, 'image'],
  [/video|reel/, 'video'],
  [/file|document/, 'file'],
];

export function parseAttachments(o: Json): Attachment[] {
  const list: unknown[] = Array.isArray(o.attachments) ? o.attachments : o.attachment ? [o.attachment] : o.media ? [o.media] : [];
  // Some platforms flag a voice note with a boolean or a top-level type instead of an attachments array.
  const out: Attachment[] = [];
  for (const a of list) {
    const x = obj(a);
    const t = (str(x.type) ?? str(x.kind) ?? str(x.mime_type) ?? '').toLowerCase();
    const kind = ATTACHMENT_KINDS.find(([re]) => re.test(t))?.[1] ?? 'unknown';
    out.push({ kind, url: str(x.url) ?? str(obj(x.payload).url) });
  }
  if (!out.length && (o.is_voice_note === true || o.voice_note === true)) out.push({ kind: 'audio' });
  return out;
}

const LABELS: Record<AttachmentKind, string> = {
  audio: '[voice note]', image: '[image]', video: '[video]', share: '[shared a post]',
  story_mention: '[mentioned our story]', file: '[file]', unknown: '[attachment]',
};
/** Placeholder text stored in the transcript for media the model cannot open. */
export const attachmentLabel = (a: Attachment) => LABELS[a.kind];
export const PLACEHOLDER_RE = /^\[(voice note|image|video|shared a post|mentioned our story|file|attachment)\]$/;

/** Text that goes into the transcript for a DM: the words plus a label per attachment. */
export function dmBody(text: string, attachments: Attachment[] = []): string {
  const labels = attachments.map(attachmentLabel).join(' ');
  return [text.trim(), labels].filter(Boolean).join(' ').trim();
}

export function mapPayload(raw: unknown): NormalizedEvent[] {
  try {
    const o = flatten(raw);
    const eventId = eventKey(raw);
    const kind = kindOf(raw);
    const at = new Date(str(o.timestamp) ?? str(o.created_at) ?? Date.now());
    const validAt = Number.isNaN(at.getTime()) ? new Date() : at;
    const senderId = str(o.sender_id) ?? str(o.from_id) ?? str(o.user_id) ?? str(o.contact_id) ?? str(obj(o.sender).id) ?? str(obj(o.from).id);
    const username = str(o.username) ?? str(obj(o.sender).username) ?? str(obj(o.from).username);
    const messageId = str(o.message_id) ?? str(o.mid) ?? eventId;

    if (kind.includes('flow')) {
      if (!senderId) return [{ type: 'ignored', eventId }];
      return [{ type: 'flow_completed', eventId, platformUserId: senderId, username, flowName: str(o.flow_name) ?? str(o.flow), at: validAt }];
    }
    if (kind.includes('postback')) {
      const payload = str(o.payload) ?? str(o.postback) ?? str(o.title) ?? str(o.button);
      if (!senderId || !payload) return [{ type: 'ignored', eventId }];
      return [{ type: 'postback', eventId, platformUserId: senderId, username, messageId, payload, title: str(o.title) ?? str(o.button_title), at: validAt }];
    }
    if (kind.includes('question')) {
      const answer = str(o.answer) ?? str(o.response) ?? str(o.text);
      if (!senderId || !answer) return [{ type: 'ignored', eventId }];
      return [{ type: 'question_answered', eventId, platformUserId: senderId, username, messageId, question: str(o.question), answer, at: validAt }];
    }
    if (kind.includes('echo') || kind.includes('outbound') || kind === 'dm_sent' || kind === 'message_sent') {
      const recipientId = str(o.recipient_id) ?? str(obj(o.recipient).id);
      const mid = str(o.message_id) ?? str(o.mid);
      if (!recipientId || !mid) return [{ type: 'ignored', eventId }];
      return [{ type: 'echo', eventId, recipientId, messageId: mid, text: str(o.text) ?? str(o.message) ?? '', at: validAt }];
    }
    if (kind.includes('comment')) {
      const commentId = str(o.comment_id) ?? str(o.id);
      const text = str(o.text) ?? str(o.comment);
      if (!commentId || !senderId || !text) return [{ type: 'ignored', eventId }];
      return [{
        type: 'comment', eventId, commentId, authorId: senderId, text, at: validAt, username,
        postId: str(o.media_id) ?? str(o.post_id),
        postCaption: str(o.media_caption) ?? str(o.post_caption),
        isAd: o.is_ad === true || kind.includes('ad'),
        likeCount: typeof o.like_count === 'number' ? o.like_count : 0,
      }];
    }
    if (kind.includes('block') || kind.includes('report')) {
      return [{ type: 'negative_signal', eventId, platformUserId: senderId, kind: kind.includes('block') ? 'block' : 'report' }];
    }
    if (kind.includes('message') || kind.includes('dm') || kind.includes('story')) {
      const text = str(o.text) ?? str(o.message) ?? str(obj(o.message).text) ?? '';
      const attachments = parseAttachments(o);
      if (kind.includes('story_mention') && !attachments.length) attachments.push({ kind: 'story_mention' });
      if (!senderId || (!text && !attachments.length)) return [{ type: 'ignored', eventId }];
      return [{ type: 'dm', eventId, platformUserId: senderId, messageId, text, at: validAt, username, isStoryReply: kind.includes('story_reply') || kind === 'story', attachments: attachments.length ? attachments : undefined }];
    }
    return [{ type: 'ignored', eventId }];
  } catch {
    return [{ type: 'ignored', eventId: eventKey(raw) }];
  }
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null };
}>;

export class InstantDmAdapter implements ChannelAdapter {
  constructor(private fetchImpl: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>) {}

  normalize(raw: unknown) { return mapPayload(raw); }

  /** One POST to the single InstantDM endpoint. Never swallows an error: every failure throws a PlatformError. */
  private async call(ctx: SendCtx, body: Json): Promise<Json> {
    const key = ctx.apiKey || config.instantDmApiKey;
    if (!key) throw new PlatformError('InstantDM: no API key configured for this client or INSTANTDM_API_KEY', 401, false);
    let res;
    try {
      res = await this.fetchImpl(`${config.instantDmBaseUrl}${config.instantDmPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new PlatformError(`InstantDM network error: ${(e as Error).message}`, 0, true);
    }
    const text = await res.text();
    let json: Json = {};
    try { json = obj(JSON.parse(text)); } catch { /* empty or non-JSON body */ }

    if (res.status === 429) {
      throw new PlatformError(`InstantDM rate limited (429): ${text.slice(0, 200)}`, 429, true, retryAfterMs(res.headers.get('retry-after')) ?? 60_000);
    }
    if (!res.ok) {
      throw new PlatformError(`InstantDM ${res.status}: ${text.slice(0, 300)}`, res.status, res.status >= 500);
    }
    // A 2xx can still carry a rejection. Surface it instead of treating it as sent.
    const rejected = json.success === false || json.ok === false || str(json.status) === 'error' || (json.error !== undefined && json.error !== null && json.error !== false && json.success !== true);
    if (rejected) {
      const msg = str(json.error) ?? str(obj(json.error).message) ?? str(json.message) ?? text.slice(0, 200);
      const transient = /rate|too many|try again|temporar/i.test(msg);
      throw new PlatformError(`InstantDM rejected the request: ${msg}`, transient ? 429 : 422, transient, transient ? 60_000 : undefined);
    }
    return json;
  }

  async sendDm(ctx: SendCtx, recipientId: string, text: string) {
    const r = await this.call(ctx, { action: 'send_message', type: 'dm', recipient_id: recipientId, message: { text } });
    return { messageId: str(r.message_id) ?? str(r.id) ?? str(obj(r.data).message_id) };
  }
  /** Public comment reply (visible on the post). Exact docs format: action "post_comment". */
  async replyToComment(ctx: SendCtx, commentId: string, text: string) {
    await this.call(ctx, { action: 'post_comment', comment_id: commentId, comment_text: text });
  }
  /** Private DM sent as a reply to a comment. Exact docs format: type "comment_reply". */
  async sendPrivateReply(ctx: SendCtx, commentId: string, text: string) {
    const r = await this.call(ctx, { action: 'send_message', type: 'comment_reply', comment_id: commentId, message: { text } });
    const d = obj(r.data);
    return { messageId: str(r.message_id) ?? str(r.id) ?? str(d.message_id), recipientId: str(r.recipient_id) ?? str(d.recipient_id) };
  }
}
