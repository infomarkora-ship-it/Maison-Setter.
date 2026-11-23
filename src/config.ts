import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
const num = (name: string, d: number) => (process.env[name] ? Number(process.env[name]) : d);

export const config = {
  get databaseUrl() { return req('DATABASE_URL'); },
  get anthropicKey() { return req('ANTHROPIC_API_KEY'); },
  /** 'anthropic' (production, Claude Haiku) or 'gemini' (free-tier testing). */
  llmProvider: (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase(),
  get geminiKey() { return req('GEMINI_API_KEY'); },
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  get adminToken() { return req('ADMIN_TOKEN'); },
  model: process.env.CLAUDE_MODEL ?? 'claude-haiku-5-5',
  port: num('PORT', 3000),
  instantDmBaseUrl: process.env.INSTANTDM_BASE_URL ?? 'https://openapi.instantdm.com',
  /** Single outbound endpoint: POST {base}{path} with a Bearer key (InstantDM docs: /action). */
  instantDmPath: process.env.INSTANTDM_API_PATH ?? '/action',
  /** Fallbacks used when a client row has no key / secret of its own. */
  instantDmApiKey: process.env.INSTANTDM_API_KEY ?? '',
  instantDmWebhookSecret: process.env.INSTANTDM_WEBHOOK_SECRET ?? '',
  /** Run the job worker inside the web server process (default). Set WORKER_INLINE=0 to run `start:worker` as a separate service. */
  workerInline: process.env.WORKER_INLINE !== '0',
  operatorWebhook: process.env.OPERATOR_NOTIFY_WEBHOOK_URL ?? '',
  prices: {
    input: num('PRICE_INPUT_PER_MTOK', 0.10),
    output: num('PRICE_OUTPUT_PER_MTOK', 0.50),
    cacheRead: num('PRICE_CACHE_READ_PER_MTOK', 0.01),
    cacheWrite: num('PRICE_CACHE_WRITE_PER_MTOK', 0.125),
  },
  // Messaging-window rules (verify against current Meta/InstantDM docs).
  dmWindowHours: 24,
  /** Stop automated sends this many minutes before the 24h window closes (clock skew / in-flight sends). */
  dmWindowSafetyMinutes: num('DM_WINDOW_SAFETY_MINUTES', 10),
  privateReplyWindowDays: 7,
  /** Dashboard "free-limit" warning line: estimated daily AI request cap (Gemini free tier moves this around). */
  aiFreeDailyRequestLimit: num('AI_FREE_DAILY_REQUEST_LIMIT', 250),
  /** Public origin of this deployment; used to print webhook URLs in the dashboard. */
  get publicBaseUrl() { return (process.env.PUBLIC_BASE_URL ?? 'https://your-app.up.railway.app').replace(/\/+$/, ''); },
};
