// Friendly error mapping for dashboard AI features. The model itself is never touched:
// this only decides what the person at the dashboard sees when the free-tier LLM says "slow down".

const SLOW_DOWN_RE = /(^|\b)(429|RESOURCE_EXHAUSTED|rate.?limit|quota|too many requests|slowdown|slow down)\b/i;

export function isSlowDown(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return SLOW_DOWN_RE.test(msg);
}

/** Plain-words message for the dashboard when the AI provider throttles us (common on free tiers). */
export function slowDownMessage(): string {
  return 'The AI is taking a short breather — the free tier limits how fast we can ask it things. Wait a few seconds and try again; everything else keeps running in the meantime.';
}

export function aiErrorMessage(e: unknown): { error: string; message: string } {
  if (isSlowDown(e)) return { error: 'slow_down', message: slowDownMessage() };
  const msg = e instanceof Error ? e.message : String(e);
  return { error: 'ai_failed', message: `The AI could not answer right now (${msg.slice(0, 160)}). Your data is unaffected — try again in a moment.` };
}
