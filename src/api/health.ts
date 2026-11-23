import { config } from '../config.js';
import { q, q1 } from '../db.js';
import * as repo from '../repo.js';

// =====================================================================================
// Health: is the worker running, what went wrong recently, how much of the free
// AI limit we have used today, and the automatic "brakes". Read-only.
// =====================================================================================

export interface ErrorItem { where: string; at: string; message: string; /** Raw webhook payload (clipped) so unknown shapes are diagnosable without SQL. */ payload?: string }
export interface HealthReport {
  db: boolean;
  worker: { alive: boolean | null; lastHeartbeatAt: string | null; note: string };
  queues: { jobsPending: number; jobsRunning: number; deadJobs24h: number; sendsPending: number };
  usage: { today: number; limit: number; limitIsEstimate: boolean; byKind: Array<{ kind: string; calls: number }>; note: string };
  brakes: Array<{ reason: string; until: string }>;
  errors: ErrorItem[];
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const clip = (s: string | null | undefined, n = 300) => (s ? s.slice(0, n) : '');

export async function buildHealth(clientId: string | null): Promise<HealthReport> {
  await q('SELECT 1');

  const hb = await q1<{ at: Date }>(`SELECT at FROM worker_status WHERE name = 'worker'`);
  const alive = hb ? (Date.now() - new Date(hb.at).getTime()) < 3 * 60_000 : null;
  const workerNote = alive === null
    ? 'No heartbeat recorded yet. The worker writes one every 30 seconds once it runs.'
    : alive ? 'The worker checked in within the last 3 minutes.' : 'The worker has NOT checked in recently. Is the worker service running on Railway?';

  const counts = await q1<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE status = 'pending') AS jobs_pending,
       (SELECT count(*)::int FROM jobs WHERE status = 'running') AS jobs_running,
       (SELECT count(*)::int FROM jobs WHERE status = 'dead' AND created_at > now() - interval '24 hours') AS dead_24h,
       (SELECT count(*)::int FROM send_queue WHERE status = 'pending') AS sends_pending`) ?? {};

  // Free-tier estimate: count the model calls logged today. The limit is an env var because
  // Google moves it around; the default matches the common Gemini free tier (requests per day).
  const limit = config.aiFreeDailyRequestLimit;
  const usageRows = await q<{ kind: string; calls: number }>(
    `SELECT kind, count(*)::int AS calls FROM usage_log
     WHERE created_at >= date_trunc('day', now()) GROUP BY kind ORDER BY calls DESC`, []);
  const today = usageRows.reduce((a, r) => a + Number(r.calls), 0);

  const brakes = await (clientId
    ? repo.activeBrake(clientId).then((b) => (b ? [{ reason: b.reason, until: iso(b.until) as string }] : []))
    : q<{ reason: string; until: Date }>(`SELECT reason, until FROM brakes WHERE until > now() ORDER BY until DESC LIMIT 5`).then((rows) => rows.map((r) => ({ reason: r.reason, until: iso(r.until) as string }))));

  const errors: ErrorItem[] = [];
  const jobErrs = await q<{ type: string; lastError: string; createdAt: Date }>(
    `SELECT type, last_error, created_at FROM jobs WHERE last_error IS NOT NULL AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 8`);
  for (const e of jobErrs) errors.push({ where: `job ${e.type}`, at: iso(e.createdAt) as string, message: clip(e.lastError) });
  const sendErrs = await q<{ kind: string; error: string; lastAttemptAt: Date }>(
    `SELECT kind, error, last_attempt_at FROM send_queue WHERE status = 'failed' AND last_attempt_at > now() - interval '24 hours' ORDER BY last_attempt_at DESC LIMIT 8`);
  for (const e of sendErrs) errors.push({ where: `send (${e.kind})`, at: iso(e.lastAttemptAt) as string, message: clip(e.error) });
  const rawErrs = await q<{ error: string; received_at: Date; payload: unknown }>(
    `SELECT error, received_at, payload FROM raw_events WHERE error IS NOT NULL AND received_at > now() - interval '24 hours' ORDER BY received_at DESC LIMIT 8`);
  for (const e of rawErrs) {
    let payloadText = '';
    try { payloadText = JSON.stringify(typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload); } catch { payloadText = String(e.payload); }
    errors.push({ where: 'incoming event', at: iso(e.received_at) as string, message: clip(e.error), payload: clip(payloadText, 1200) });
  }
  errors.sort((a, b) => b.at.localeCompare(a.at));

  return {
    db: true,
    worker: { alive, lastHeartbeatAt: iso(hb?.at), note: workerNote },
    queues: { jobsPending: Number(counts.jobs_pending ?? 0), jobsRunning: Number(counts.jobs_running ?? 0), deadJobs24h: Number(counts.dead_24h ?? 0), sendsPending: Number(counts.sends_pending ?? 0) },
    usage: {
      today, limit, limitIsEstimate: true,
      byKind: usageRows.map((r) => ({ kind: r.kind, calls: Number(r.calls) })),
      note: 'Counts every AI request logged today (conversations, comment classification, follow-up planning, Ask AI, test chat). The limit is an estimate of the free tier — set AI_FREE_DAILY_REQUEST_LIMIT in your environment to match your plan.',
    },
    brakes,
    errors: errors.slice(0, 15),
  };
}
