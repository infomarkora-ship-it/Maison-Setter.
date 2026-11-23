import { q } from './db.js';

export type JobType = 'process_event' | 'classify_comment' | 'converse' | 'followup' | 'plan_followup' | 'calendar_event';
export interface Job { id: number; type: JobType; clientId: string | null; payload: Record<string, unknown>; attempts: number; maxAttempts: number }

export async function enqueue(type: JobType, payload: Record<string, unknown>, o: { clientId?: string; delayMs?: number; dedupeKey?: string } = {}) {
  await q(
    `INSERT INTO jobs (type, client_id, payload, run_at, dedupe_key)
     VALUES ($1, $2, $3, now() + ($4::text || ' milliseconds')::interval, $5)
     ON CONFLICT (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING`,
    [type, o.clientId ?? null, JSON.stringify(payload), String(o.delayMs ?? 0), o.dedupeKey ?? null],
  );
}

export async function claimJobs(limit: number): Promise<Job[]> {
  return q<Job>(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, type, client_id, payload, attempts, max_attempts`,
    [limit],
  );
}

export async function completeJob(id: number) {
  await q(`UPDATE jobs SET status = 'done' WHERE id = $1`, [id]);
}

/** Exponential backoff: 10s, 20s, 40s... then dead after max_attempts. */
export async function failJob(id: number, err: string) {
  await q(
    `UPDATE jobs SET last_error = $2,
       status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
       run_at = now() + (power(2, attempts) * interval '5 seconds')
     WHERE id = $1`,
    [id, err.slice(0, 1000)],
  );
}

export async function recoverStuckJobs() {
  await q(`UPDATE jobs SET status = 'pending' WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`);
}

export async function deadJobCount(): Promise<number> {
  const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'dead' AND created_at > now() - interval '24 hours'`);
  return r[0]?.n ?? 0;
}

/**
 * Debounce: every call pushes the pending job's run_at to now + windowMs (the burst keeps extending the wait),
 * but never past the burst's first message + maxWaitMs. If no job is pending a new one is created. A job that is
 * already running is not touched, so a message arriving mid-run gets its own follow-up job (converseJob cancels
 * the stale queued reply and regenerates with the whole burst).
 */
export async function enqueueDebounced(type: JobType, payload: Record<string, unknown>, o: { clientId?: string; dedupeKey: string; windowMs: number; maxWaitMs?: number }) {
  const maxWait = String(o.maxWaitMs ?? 20_000);
  const win = String(o.windowMs);
  const updated = await q<{ id: number }>(
    `UPDATE jobs SET run_at = LEAST(now() + ($2::text || ' milliseconds')::interval, created_at + ($3::text || ' milliseconds')::interval)
     WHERE dedupe_key = $1 AND status = 'pending' RETURNING id`, [o.dedupeKey, win, maxWait]);
  if (updated.length) return;
  await enqueue(type, payload, { clientId: o.clientId, delayMs: o.windowMs, dedupeKey: o.dedupeKey });
}

/** Replace any pending job with this dedupe key by one that runs at `runAt` (used for planned follow-ups). */
export async function scheduleJobAt(type: JobType, payload: Record<string, unknown>, o: { clientId?: string; runAt: Date; dedupeKey: string }) {
  await q(`UPDATE jobs SET status = 'done', last_error = 'replaced' WHERE dedupe_key = $1 AND status = 'pending'`, [o.dedupeKey]);
  await q(`INSERT INTO jobs (type, client_id, payload, run_at, dedupe_key) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL DO NOTHING`,
    [type, o.clientId ?? null, JSON.stringify(payload), o.runAt, o.dedupeKey]);
}

export const hasPendingJob = async (type: JobType, conversationId: string) =>
  (await q(`SELECT 1 AS x FROM jobs WHERE status = 'pending' AND type = $1 AND payload->>'conversationId' = $2 LIMIT 1`, [type, conversationId])).length > 0;
