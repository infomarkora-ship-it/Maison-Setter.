import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type { Attachment, AttachmentKind, NormalizedEvent } from '../types.js';
import { PlatformError, type ChannelAdapter, type SendCtx } from './types.js';

/**
 * ============================  PAYLOAD SPEC  ============================
 * Confirmed from the InstantDM docs (instantdm.com/instagram-api-docs; treat as fact):
 *   Outbound: POST https://api.instantdm.com/api-webhook
 *             Authorization: Bearer <INSTANTDM_API_KEY>, Content-Type: application/json
 *   A. DM:        { action: "send_message", type: "dm", recipient_id, message: { text } }
 *   B. Public reply: { action: "post_comment", comment_id, comment_text }
 *   C. Private reply to a comment:
 *                 { action: "send_message", type: "comment_reply", comment_id, message: { text } }
 *   Inbound events (POST /webhooks/instantdm/:clientId) — event name rides in the
 *   `X-Event-Type` HEADER; bodies as follows, signed with X-Webhook-Signature =
 *   HMAC-SHA256(raw body, webhook secret). Dedupe on message `mid` / comment `id`
 *   (at-least-once delivery: duplicates are possible and NOT retried on your errors).
 *     - dm_received   → raw Meta payload: {object:"instagram", entry:[{id,time,messaging:
 *                       [{sender:{id}, recipient:{id}, timestamp(ms), message:{mid, text,
 *                       attachments?}}]}]}
 *     - postback      → raw Meta payload: entry[].messaging[].postback {title, payload:
 *                       JSON STRING (from.username, media.id, text, story_reply...), mid}
 *     - question_answered → flat: {flow_id, sender_id, sender_username, question,
 *                       question_type, custom_variable_name, user_response, skip,
 *                       attempt_no, timestamp "YYYY-MM-DD HH:MM:SS.ffffff"}
 *     - flow_completed    → flat: {flow_id, flow_name, sender_id, sender_username,
 *                       completed_at, attempt_no, tags, response_variables, question_responses}
 *   Story replies arrive inside dm_received as story_mention attachments (no separate event).
 *   ECHOES: Meta relays the business account's own sends back through the same messaging
 *   shape (sender = the business). entry[].id IS the business account, so any messaging
 *   item whose sender.id equals entry[].id is classified as an echo even when the
 *   is_echo flag is missing — without this the bot answers itself and double-sends.
 *   No echo/outbound webhooks are documented — echo handling below is harmless if absent.
 *   Webhooks fire BEFORE InstantDM's own automations act (pre-processing), on eligible plans.
 *
 * ASSUMED (tolerated, not documented): flat legacy shapes with `event`/`type` in the body
 * (kept for compatibility with older tests and any InstantDM API changes).
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

// ---- InstantDM webhook facts (from instantdm.com/instagram-api-docs, confirmed) ----
// Event name arrives in the `X-Event-Type` HEADER, so the body itself carries no type
// for the raw Meta envelopes. `comment`, `dm_received` and `postback` are RAW META
// payloads: { object: "instagram", entry: [...] }. `question_answered` and
// `flow_completed` are InstantDM-specific FLAT payloads. Timestamps in envelopes are
// epoch MILLISECONDS; flow events use "YYYY-MM-DD HH:MM:SS.ffffff" strings.
const entriesOf = (raw: Json): Json[] => {
  const e = raw.entry;
  if (Array.isArray(e)) return e.filter((x) => x && typeof x === 'object') as Json[];
  if (e && typeof e === 'object') return [e as Json];
  return [];
};

/** Meta timestamps: epoch milliseconds in messaging, epoch SECONDS in entry[].time for
 * comment webhooks. Values below 1e11 are treated as seconds. */
const msDate = (v: unknown): Date | undefined => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 1e9) return new Date(v < 1e11 ? v * 1000 : v);
  if (typeof v === 'string' && /^\d{10,}$/.test(v)) { const n = Number(v); return new Date(n < 1e11 ? n * 1000 : n); }
  return undefined;
};
/** InstantDM flow-event timestamps like "2026-05-06 04:45:30.123456" (treated as UTC). */
const flowDate = (v: unknown): Date | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T').slice(0, 23)}Z` : s;
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const parseJsonSafe = (s: string | undefined): Json => {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}; } catch { return {}; }
};

/** Stable dedupe key: the platform's event id, else a message / comment id, else a content hash.
 * Digs ids out of the raw Meta envelope too (docs: dedupe on message `mid` or comment `id`). */
export function eventKey(raw: unknown): string {
  const o = flatten(raw);
  const id = str(o.event_id) ?? str(o.id);
  if (id) return id;
  const msg = str(o.message_id) ?? str(o.mid);
  if (msg) return `${kindOf(raw) || 'msg'}:${msg}`;
  const cm = str(o.comment_id);
  if (cm) return `comment:${cm}`;
  // Raw Meta envelope: entry[].messaging[].message.mid / postback.mid / entry[].changes[].value.id
  for (const e of entriesOf(o)) {
    for (const m of Array.isArray(e.messaging) ? (e.messaging as Json[]) : []) {
      const mo = obj(m);
      const inner = str(obj(mo.message).mid) ?? str(obj(mo.message).message_id) ?? str(mo.mid);
      if (inner) return inner;
    }
    for (const ch of Array.isArray(e.changes) ? (e.changes as Json[]) : []) {
      const vid = str(obj(obj(ch).value).id);
      if (vid) return `comment:${vid}`;
    }
  }
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

    // ---------- InstantDM documented envelopes: raw Meta payloads under `entry` ----------
    // (dm_received / comment / postback bodies are {object, entry:[...]}; the event name
    // rides in the X-Event-Type header, so detection here is structural.)
    const entries = entriesOf(o);
    if (entries.length) {
      const out: NormalizedEvent[] = [];
      entries.forEach((e, ei) => {
        const entryTime = msDate(e.time);
        // In Meta's envelope, entry[].id is the BUSINESS account that owns the webhook.
        // Anything sent by that id is us, not the lead.
        const entryId = str(e.id);
        // entry[].messaging[] — dm_received (message), postback (button tap), echoes
        for (const m of Array.isArray(e.messaging) ? (e.messaging as Json[]) : []) {
          const mo = obj(m);
          const senderId = str(obj(mo.sender).id);
          const recipientId = str(obj(mo.recipient).id);
          const at = msDate(mo.timestamp) ?? entryTime ?? new Date();
          const msg = obj(mo.message);
          const pb = obj(mo.postback);
          const mid = str(msg.mid) ?? str(msg.message_id) ?? str(pb.mid) ?? `${senderId}:${at.getTime()}`;
          // Own message echoed back WITHOUT the is_echo flag (Instagram relays business sends
          // as ordinary messaging items). Must become an echo: as a plain dm it would create a
          // phantom "self" conversation, pollute transcripts, and make the AI answer itself.
          if (senderId && entryId && senderId === entryId) {
            if (recipientId) out.push({ type: 'echo', eventId: `${mid}`, recipientId, messageId: mid, text: str(msg.text) ?? '', at });
            continue;
          }
          if (msg.is_echo === true) {
            if (recipientId) out.push({ type: 'echo', eventId: `${mid}`, recipientId, messageId: mid, text: str(msg.text) ?? '', at });
            continue;
          }
          if (Object.keys(pb).length) {
            // Button tap. `payload` is a JSON STRING with context (from.username, media.id, original comment text).
            const parsed = parseJsonSafe(str(pb.payload));
            const title = str(pb.title) ?? '';
            if (senderId && (title || str(pb.payload))) {
              out.push({ type: 'postback', eventId: `${mid}`, platformUserId: senderId, messageId: mid, payload: str(pb.payload) ?? title, title,
                username: str(obj(parsed.from).username), at });
            }
            continue;
          }
          if (Object.keys(msg).length) {
            const text = str(msg.text) ?? '';
            const attachments = parseAttachments(msg);
            const storyReply = attachments.some((a) => a.kind === 'story_mention') || obj(msg.reply_to).story !== undefined || obj(msg.reply_to).story_id !== undefined;
            if (!senderId || (!text && !attachments.length)) continue;
            out.push({ type: 'dm', eventId: `${mid}`, platformUserId: senderId, messageId: mid, text, at,
              isStoryReply: storyReply, attachments: attachments.length ? attachments : undefined });
          }
        }
        // entry[].changes[] — comment events: value {from:{id,username}, text, id, media:{id}, sender_id}
        for (const ch of Array.isArray(e.changes) ? (e.changes as Json[]) : []) {
          const cho = obj(ch);
          const val = obj(cho.value);
          const isCommentField = str(cho.field) === 'comments' || Object.keys(val).length > 0;
          const commentId = str(val.id);
          const text = str(val.text) ?? '';
          const authorId = str(val.sender_id) ?? str(obj(val.from).id);
          if (!isCommentField || !commentId || !authorId || !text) continue;
          out.push({
            type: 'comment', eventId: `comment:${commentId}`, commentId, authorId, text, at: entryTime ?? new Date(),
            username: str(obj(val.from).username),
            postId: str(obj(val.media).id) ?? str(val.post_id),
            postCaption: str(val.media_caption) ?? str(val.post_caption),
            isAd: val.is_ad === true || kind.includes('ad'),
            likeCount: typeof val.like_count === 'number' ? val.like_count : 0,
          });
        }
      });
      if (out.length) return out;
      // Recognized envelope but nothing usable inside (e.g. a read receipt): do not flag as unmatched.
      return [{ type: 'ignored', eventId }];
    }

    // ---------- InstantDM flat structured events + legacy flat shapes ----------
    const at = new Date(str(o.timestamp) ?? str(o.created_at) ?? Date.now());
    const validAt = Number.isNaN(at.getTime()) ? new Date() : at;
    const senderId = str(o.sender_id) ?? str(o.from_id) ?? str(o.user_id) ?? str(o.contact_id) ?? str(obj(o.sender).id) ?? str(obj(o.from).id);
    const username = str(o.username) ?? str(o.sender_username) ?? str(obj(o.sender).username) ?? str(obj(o.from).username);
    const messageId = str(o.message_id) ?? str(o.mid) ?? eventId;

    if (kind.includes('flow') || (!kind && o.flow_id !== undefined && o.response_variables !== undefined)) {
      if (!senderId) return [{ type: 'ignored', eventId }];
      const atFlow = flowDate(o.completed_at) ?? validAt;
      return [{ type: 'flow_completed', eventId, platformUserId: senderId, username, flowName: str(o.flow_name) ?? str(o.flow), at: atFlow }];
    }
    if (kind.includes('postback')) {
      const payload = str(o.payload) ?? str(o.postback) ?? str(o.title) ?? str(o.button);
      if (!senderId || !payload) return [{ type: 'ignored', eventId }];
      return [{ type: 'postback', eventId, platformUserId: senderId, username, messageId, payload, title: str(o.title) ?? str(o.button_title), at: validAt }];
    }
    if (kind.includes('question') || (!kind && o.user_response !== undefined && o.question !== undefined)) {
      const answer = str(o.user_response) ?? str(o.answer) ?? str(o.response) ?? str(o.text);
      if (!senderId || !answer || o.skip === true) return [{ type: 'ignored', eventId }];
      return [{ type: 'question_answered', eventId, platformUserId: senderId, username, messageId, question: str(o.question), answer, at: flowDate(o.timestamp) ?? validAt }];
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
    // Primary = configured endpoint. The docs put the actions endpoint at
    // https://api.instantdm.com/api-webhook; deployments configured with the older
    // openapi.../action route get one automatic retry against the documented URL
    // when that route answers 404/405 or says the action/route is unknown.
    const primary = `${config.instantDmBaseUrl}${config.instantDmPath}`;
    const legacy = 'https://api.instantdm.com/api-webhook';
    const candidates = primary === legacy ? [primary] : [primary, legacy];
    let lastText = '';
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const url = candidates[attempt]!;
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new PlatformError(`InstantDM network error: ${(e as Error).message}`, 0, true);
      }
      const text = await res.text();
      lastText = text;
      let json: Json = {};
      try { json = obj(JSON.parse(text)); } catch { /* empty or non-JSON body */ }

      // Wrong endpoint (404/405 or "unknown route/action"): try the documented legacy URL once.
      const wrongRoute = res.status === 404 || res.status === 405
        || (!res.ok && /unknown (route|action)|route not found|not found|invalid (route|action)|cannot post/i.test(text));
      if (wrongRoute && attempt < candidates.length - 1) {
        console.warn(`[instantdm] POST ${url} -> ${res.status} (route not recognized); retrying once against ${legacy}`);
        continue;
      }

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
    throw new PlatformError(`InstantDM ${lastText.slice(0, 200)}`, 502, true);   // unreachable, but keeps the compiler happy
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
