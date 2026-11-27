// Pure pacing + safety rules. No DB, no network, so every rule is unit-testable.

export type Rng = () => number;

/** Ramp: new accounts start slow. [week1, week2, week3] then the client's max. */
export const RAMP = [15, 30, 50];

export function rampCap(daysSinceLaunch: number, clientMax: number): number {
  const week = Math.floor(Math.max(0, daysSinceLaunch) / 7);
  const base = week < RAMP.length ? (RAMP[week] as number) : clientMax;
  return Math.max(0, Math.min(base, clientMax));
}

export function localHour(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(now);
  return Number(h);
}

/** start inclusive, end exclusive, in the client's local hours. */
export function isWithinWindow(now: Date, tz: string, startHour: number, endHour: number): boolean {
  const h = localHour(now, tz);
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/** Random gap between openers: minMinutes (>= 2) plus 0-8 minutes. Default 2 to 10 minutes. */
export function openerGapMs(rng: Rng = Math.random, minMinutes = 2): number {
  return Math.round((Math.max(2, minMinutes) + rng() * 8) * 60_000);
}

/** Human-feeling delay before a reply goes out: 15s base + ~0.4s per char, jittered, capped 2 min. */
export function replyDelayMs(text: string, rng: Rng = Math.random): number {
  const base = 15_000 + text.length * 400;
  const jitter = 0.7 + rng() * 0.6;
  return Math.min(120_000, Math.round(base * jitter));
}

/** True while an automated message may still be sent. marginMinutes stops sends shortly before the window closes. */
export function withinDmWindow(lastInboundAt: Date | null, now: Date, windowHours = 24, marginMinutes = 0): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < windowHours * 3_600_000 - marginMinutes * 60_000;
}

// ---------- multi-message chunking ----------

/**
 * Split a reply into 1-3 short chat bubbles. Blank lines the model wrote are respected first;
 * otherwise a long single paragraph is split at sentence boundaries. A booking link stays
 * attached to the sentence it appears in. Short replies stay as one bubble.
 */
export function chunkMessage(text: string, maxChunks = 3, targetChars = 150): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const cap = Math.max(1, maxChunks);
  let parts = clean.split(/\n\s*\n/).map((p) => p.trim().replace(/\s*\n\s*/g, ' ')).filter(Boolean);

  if (parts.length === 1) {
    const sentences = (parts[0] as string).split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((x) => x.trim()).filter(Boolean);
    if (clean.length <= targetChars * 1.3 || sentences.length < 2) return [clean.replace(/\s*\n\s*/g, ' ')];
    const groups = Math.min(cap, sentences.length, Math.max(2, Math.ceil(clean.length / targetChars)));
    const per = clean.length / groups;
    parts = [];
    let cur = '';
    for (const s of sentences) {
      if (cur && cur.length + s.length > per && parts.length < groups - 1) { parts.push(cur); cur = s; }
      else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) parts.push(cur);
  }

  // Too many paragraphs: merge the shortest adjacent pair until we are at the cap.
  while (parts.length > cap) {
    let best = 0, bestLen = Infinity;
    for (let i = 0; i < parts.length - 1; i++) {
      const l = (parts[i] as string).length + (parts[i + 1] as string).length;
      if (l < bestLen) { bestLen = l; best = i; }
    }
    parts.splice(best, 2, `${parts[best]} ${parts[best + 1]}`);
  }
  // A tiny trailing bubble ("Sound good?") reads fine; a tiny leading fragment does not.
  if (parts.length > 1 && (parts[0] as string).length < 8) parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
  return parts;
}

/** Typing-style pause before the next bubble: ~1.2s base + ~35ms/char, jittered, capped at 6s. */
export function chunkGapMs(nextChunk: string, rng: Rng = Math.random): number {
  return Math.min(6_000, Math.round((1_200 + nextChunk.length * 35) * (0.8 + rng() * 0.4)));
}

// ---------- rapid-fire debounce ----------

/** Quiet period after the latest message before the AI reads the burst: 4 to 6 seconds. */
export function debounceWindowMs(rng: Rng = Math.random): number {
  return Math.round(4_000 + rng() * 2_000);
}

/**
 * When the debounced job should run: `window` after the newest message, but never later than
 * `maxWait` after the first message of the burst (so a chatty lead cannot starve the reply forever).
 */
export function debounceRunAt(now: Date, burstStartedAt: Date, windowMs: number, maxWaitMs = 20_000): Date {
  return new Date(Math.min(now.getTime() + windowMs, burstStartedAt.getTime() + maxWaitMs));
}

/** Keep a safety margin under the 7 day private-reply window. */
export function commentStillReplyable(commentedAt: Date, now: Date, windowDays = 7, marginHours = 12): boolean {
  return now.getTime() - commentedAt.getTime() < windowDays * 86_400_000 - marginHours * 3_600_000;
}

// ---------- send selection ----------

export interface Candidate {
  id: number;
  kind: 'reply' | 'followup' | 'reminder' | 'opener' | 'public_reply';
  priority: number;
  scheduledFor: Date;
}

export interface SendState {
  now: Date;
  braked: boolean;
  openerWindowOpen: boolean;
  openersSentToday: number;
  openerCapToday: number;
  nextOpenerAt: Date;
  sentLastHour: number;
  hourlyCap: number;
}

const KIND_RANK: Record<Candidate['kind'], number> = { reply: 0, reminder: 1, followup: 2, opener: 3, public_reply: 4 };

export function openerAllowed(s: SendState): { ok: boolean; reason?: string } {
  if (s.braked) return { ok: false, reason: 'brake_active' };
  if (!s.openerWindowOpen) return { ok: false, reason: 'outside_window' };
  if (s.openersSentToday >= s.openerCapToday) return { ok: false, reason: 'daily_cap' };
  if (s.now < s.nextOpenerAt) return { ok: false, reason: 'spacing' };
  return { ok: true };
}

/**
 * Strict priority: replies to people who messaged first, then reminders, follow-ups,
 * and only then new comment openers (which also obey brake / window / daily cap / spacing).
 * Returns null if nothing may be sent right now.
 */
export function pickNext(candidates: Candidate[], s: SendState): Candidate | null {
  if (s.sentLastHour >= s.hourlyCap) return null;
  const due = candidates
    .filter((c) => c.scheduledFor <= s.now)
    .sort((a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.priority - a.priority ||
      a.scheduledFor.getTime() - b.scheduledFor.getTime());
  for (const c of due) {
    if (c.kind === 'opener' && !openerAllowed(s).ok) continue;
    // Public replies are not DMs (no daily DM cap), but they still obey the brake and the sending hours.
    if (c.kind === 'public_reply' && (s.braked || !s.openerWindowOpen)) continue;
    return c;
  }
  return null;
}

// ---------- automatic brakes ----------

export interface BrakeStats {
  openersSent: number;       // last 50 openers
  openersReplied: number;    // of those, how many got any reply
  recentAttempts: number;    // last 20 send attempts (any kind)
  recentErrors: number;
  negativeSignals24h: number; // blocks / reports / hostile opt-outs
}

export interface BrakeConfig {
  minSample: number;
  minReplyRate: number;
  errorThreshold: number;
  negativeThreshold: number;
}

export const DEFAULT_BRAKES: BrakeConfig = { minSample: 30, minReplyRate: 0.12, errorThreshold: 5, negativeThreshold: 2 };

export function evaluateBrakes(s: BrakeStats, cfg: BrakeConfig = DEFAULT_BRAKES): { brake: boolean; hours: number; reason?: string } {
  if (s.negativeSignals24h >= cfg.negativeThreshold) return { brake: true, hours: 48, reason: `negative_signals:${s.negativeSignals24h}` };
  if (s.recentAttempts >= 10 && s.recentErrors >= cfg.errorThreshold) return { brake: true, hours: 6, reason: `send_errors:${s.recentErrors}/${s.recentAttempts}` };
  if (s.openersSent >= cfg.minSample) {
    const rate = s.openersReplied / s.openersSent;
    if (rate < cfg.minReplyRate) return { brake: true, hours: 24, reason: `low_reply_rate:${(rate * 100).toFixed(0)}%` };
  }
  return { brake: false, hours: 0 };
}
