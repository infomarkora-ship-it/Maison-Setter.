import { createLlm } from './ai/llm.js';
import { InstantDmAdapter } from './platform/instantdm.js';
import { claimJobs, completeJob, deadJobCount, failJob, recoverStuckJobs, type Job } from './jobs.js';
import { classifyCommentJob } from './handlers/comments.js';
import { converseJob } from './handlers/converse.js';
import { processEvent, type Deps } from './handlers/events.js';
import { brakeScan, followupJob, followupScan, pauseExpiryScan, planJob, reminderScan, silenceCheck } from './handlers/schedulers.js';
import { processCalendarEvent } from './booking.js';
import { sendTick } from './sender.js';
import { logUsage } from './repo.js';
import { alertOperator } from './notify.js';

const deps: Deps = {
  llm: createLlm((u) => { logUsage(u).catch(() => undefined); }),
  adapter: new InstantDmAdapter(),     // swap here to change platforms
};

async function run(job: Job) {
  try {
    const p = job.payload as Record<string, string | number>;
    switch (job.type) {
      case 'process_event': await processEvent(deps, Number(p.rawEventId)); break;
      case 'classify_comment': await classifyCommentJob(deps, String(p.commentId)); break;
      case 'converse': await converseJob(deps, String(p.conversationId)); break;
      case 'followup': await followupJob(deps, String(p.conversationId), Number(p.n ?? 1)); break;
      case 'plan_followup': await planJob(deps, String(p.conversationId)); break;
      case 'calendar_event': await processCalendarEvent(Number(p.rawEventId)); break;
    }
    await completeJob(job.id);
  } catch (e) {
    console.error(`[job ${job.id} ${job.type}]`, (e as Error).message);
    await failJob(job.id, (e as Error).message);
  }
}

let running = true;
async function jobLoop() {
  while (running) {
    const jobs = await claimJobs(5).catch((e) => { console.error('[claim]', e.message); return [] as Job[]; });
    if (!jobs.length) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    await Promise.all(jobs.map(run));
  }
}

const every = (ms: number, name: string, fn: () => Promise<unknown>) =>
  setInterval(() => { fn().catch((e) => console.error(`[${name}]`, (e as Error).message)); }, ms);

every(10_000, 'sender', () => sendTick(deps));
every(60_000, 'brakes', brakeScan);
every(60_000, 'recover', recoverStuckJobs);
every(10 * 60_000, 'followups', () => followupScan());
every(10 * 60_000, 'reminders', reminderScan);
every(60_000, 'pause-expiry', () => pauseExpiryScan());
every(60 * 60_000, 'silence', silenceCheck);
let lastDeadAlert = 0;
every(10 * 60_000, 'dead-jobs', async () => {
  const n = await deadJobCount();
  if (n > 0 && Date.now() - lastDeadAlert > 3_600_000) { lastDeadAlert = Date.now(); await alertOperator(`${n} job(s) failed permanently in the last 24h. Check the jobs table (status = 'dead').`); }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { running = false; setTimeout(() => process.exit(0), 3000); });
console.log('[worker] started');
void jobLoop();
