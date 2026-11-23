import { config } from './config.js';
import type { Client } from './types.js';

async function post(url: string, text: string) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `text` works for Slack, `content` for Discord.
      body: JSON.stringify({ text, content: text }),
    });
  } catch (e) {
    console.error('[notify] failed', (e as Error).message);
  }
}

/** Alerts for YOU (the operator): brakes, dead jobs, silent webhooks, bookings. */
export async function alertOperator(text: string) {
  console.warn(`[operator-alert] ${text}`);
  if (config.operatorWebhook) await post(config.operatorWebhook, `[DM Setter] ${text}`);
}

/** Alerts for the CLIENT: handoffs and new bookings. Falls back to the operator channel. */
export async function notifyClient(c: Pick<Client, 'name' | 'notifyWebhookUrl'>, text: string) {
  console.log(`[client-notify:${c.name}] ${text}`);
  await post(c.notifyWebhookUrl || config.operatorWebhook, `[${c.name}] ${text}`).catch(() => undefined);
}
