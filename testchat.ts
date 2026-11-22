/**
 * Test chat at GET /test: fill in a pretend business, then chat with the bot as if you were a lead.
 * Uses the real AI model and real prompts, but touches nothing else: no Instagram, no InstantDM, no database.
 * The page itself is static; the data call (POST /api/test-chat) needs the ADMIN_TOKEN like the rest of /api.
 */
import type { FastifyInstance } from 'fastify';
import { createLlm, type Llm } from './ai/llm.js';
import { runTurn } from './ai/converse.js';
import { chunkKnowledge, searchChunks } from './knowledge.js';
import type { Client, ConversationState, ToolHost, Turn } from './types.js';

const STATES: ConversationState[] = ['new', 'qualifying', 'qualified', 'objection', 'scheduling', 'booked', 'lost', 'disqualified', 'needs_human', 'do_not_contact'];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20);

interface Business { name: string; summary: string; offer: string; idealCustomer: string; questions: string; tone: string; knowledge: string; forbidden: string; disqualifiers: string; bookingLink: string }

function sandboxClient(b: Business): Client {
  return {
    id: '00000000-0000-0000-0000-0000000000aa', name: b.name || 'Test Business', status: 'pilot', timezone: 'America/Toronto',
    webhookSecret: 'x', platformApiKey: 'x', instagramAccountId: 'test',
    settings: {
      businessSummary: b.summary, offer: b.offer, idealCustomer: b.idealCustomer, disqualifiers: lines(b.disqualifiers),
      qualificationQuestions: lines(b.questions), tone: b.tone, forbiddenClaims: lines(b.forbidden),
      ...(/^https?:\/\//i.test(b.bookingLink) ? { bookingLink: b.bookingLink } : {}),
    },
    knowledge: b.knowledge, commissionRate: 0.2, attributionDays: 45, openerDailyMax: 50, openerWindowStart: 9, openerWindowEnd: 20, hourlySendCap: 600,
    minIntentScore: 60, notifyWebhookUrl: null,
    // With a booking link the bot only shares the link (how a real client runs); without one it books pretend times.
    calendarProvider: /^https?:\/\//i.test(b.bookingLink) ? 'link' : 'mock', calendarConfig: {},
    launchedAt: new Date(), nextOpenerAt: new Date(), promptVersion: 'v1', defaultMode: 'qualify_and_book',
    minCommentDmScore: 0, maxCommentDmsPerDay: null, commentDmMinGapMinutes: 2, lowScoreAction: 'review', humanPauseHours: 24, instantdmWebhookSecret: null,
  };
}

class SandboxHost implements ToolHost {
  actions: string[] = [];
  constructor(private chunks: string[], public state: ConversationState) {}
  async searchKnowledge(q: string) { return searchChunks(this.chunks, q).join('\n---\n'); }
  async checkAvailability() {
    const at = (days: number, hour: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
    return [at(1, 15), at(1, 19), at(2, 15), at(2, 19)];
  }
  async book(a: { startIso: string; name: string }) { this.actions.push(`Booked a call for ${a.name} (pretend: nothing real is booked)`); return { ok: true, message: `Booked for ${a.startIso}. Confirm the time to the person.` }; }
  async updateStatus(s: ConversationState, reason: string) { this.state = s; this.actions.push(`Marked the lead as ${s}: ${reason}`); return `Status set to ${s}.`; }
  async handoff(reason: string, urgency: 'low' | 'high') { this.state = 'needs_human'; this.actions.push(`Handed over to a human (${urgency} urgency): ${reason}`); return 'Handed off.'; }
  async markDoNotContact(reason: string) { this.state = 'do_not_contact'; this.actions.push(`Marked do-not-contact: ${reason}`); return 'Marked.'; }
}

export interface TestChatResult { reply: string | null; handedOff: boolean; dnc: boolean; actions: string[]; state: ConversationState; note?: string; error?: string }

export async function runTestChat(body: unknown, llm: Llm): Promise<TestChatResult> {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const bz = (o.business && typeof o.business === 'object' ? o.business : {}) as Record<string, unknown>;
  const b: Business = {
    name: str(bz.name, 100), summary: str(bz.summary, 1000), offer: str(bz.offer, 500), idealCustomer: str(bz.idealCustomer, 500),
    questions: str(bz.questions, 1000), tone: str(bz.tone, 300), knowledge: str(bz.knowledge, 8000), forbidden: str(bz.forbidden, 500),
    disqualifiers: str(bz.disqualifiers, 500), bookingLink: str(bz.bookingLink, 300),
  };
  const raw = Array.isArray(o.messages) ? o.messages.slice(-30) : [];
  const history: Turn[] = raw.flatMap((m) => {
    const r = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    const text = str(r.text, 1500).trim();
    return text && (r.from === 'lead' || r.from === 'bot') ? [{ direction: r.from === 'lead' ? 'in' as const : 'out' as const, body: text, createdAt: new Date() }] : [];
  });
  const state = STATES.includes(o.state as ConversationState) ? (o.state as ConversationState) : 'new';
  const err = (error: string): TestChatResult => ({ reply: null, handedOff: false, dnc: false, actions: [], state, error });
  if (!history.length || history[history.length - 1]!.direction !== 'in') return err('Type a message as the lead first.');
  if (state === 'do_not_contact') return { reply: null, handedOff: false, dnc: true, actions: [], state, note: 'This lead opted out, so the real bot would stay silent. Press Start over to try again.' };
  if (state === 'needs_human') return { reply: null, handedOff: true, dnc: false, actions: [], state, note: 'This chat was handed to a human, so the real bot would pause here. Press Start over to try again.' };

  const client = sandboxClient(b);
  const host = new SandboxHost(chunkKnowledge(client.knowledge), state);
  try {
    const r = await runTurn({ llm, client, history, host, context: { nowLocal: new Date().toLocaleString('en-CA', { timeZone: client.timezone }), source: 'inbound_dm', state } });
    return { reply: r.text, handedOff: r.handedOff, dnc: r.dnc, actions: host.actions, state: host.state,
      ...(r.text === null ? { note: r.dnc ? 'The lead asked to stop, so the bot sends nothing.' : 'The bot chose not to reply and passed this to a human.' } : {}) };
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    return err(/\b429\b/.test(m) ? "Google's free limit was hit. Wait about a minute and send again." : `The AI returned an error: ${m.slice(0, 200)}`);
  }
}

let sharedLlm: Llm | null = null;

export function registerTestChat(app: FastifyInstance): void {
  app.get('/test', async (_req, reply) =>
    reply.header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
      .send(PAGE));

  // Registered after the /api/ bearer-token hook in server.ts, so it needs ADMIN_TOKEN too.
  app.post('/api/test-chat', async (req) => {
    try { sharedLlm ??= createLlm(); } catch (e) { return { reply: null, handedOff: false, dnc: false, actions: [], state: 'new', error: `The AI is not set up: ${(e as Error).message}` } satisfies TestChatResult; }
    return runTestChat(req.body, sharedLlm);
  });
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>DM Setter test chat</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#14161a; --muted:#4b5058; --card:#ffffff; --line:#c5c9d0; --accent:#0b3fb5; --accent-fg:#ffffff; --lead:#e8ecf3; --bot:#0b3fb5; --bot-fg:#ffffff; --note:#fff2b3; --bad:#9c1111; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e0f12; --fg:#f2f3f5; --muted:#c3c7ce; --card:#17191e; --line:#454a53; --accent:#8fb4ff; --accent-fg:#001a4d; --lead:#252932; --bot:#2f5fd0; --bot-fg:#ffffff; --note:#4a3f00; --bad:#ff9a9a; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); background:var(--card); display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  h1 { font-size:1.25rem; margin:0; } h2 { font-size:1.05rem; margin:0 0 10px; }
  main { max-width:1150px; margin:0 auto; padding:16px; display:grid; gap:16px; grid-template-columns:minmax(0,5fr) minmax(0,6fr); align-items:start; }
  @media (max-width:860px) { main { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  label { display:block; font-weight:600; font-size:.92rem; margin:10px 0 3px; }
  input, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
  textarea { min-height:64px; resize:vertical; }
  .hint { color:var(--muted); font-size:.85rem; margin:2px 0 0; }
  button { padding:9px 16px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); font:inherit; font-weight:700; cursor:pointer; min-height:42px; }
  button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
  :focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
  #log { height:440px; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding:4px; border:1px solid var(--line); border-radius:10px; background:var(--bg); }
  .b { max-width:82%; padding:8px 12px; border-radius:16px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .b.lead { align-self:flex-end; background:var(--lead); border-bottom-right-radius:4px; }
  .b.bot { align-self:flex-start; background:var(--bot); color:var(--bot-fg); border-bottom-left-radius:4px; }
  .n { align-self:center; font-size:.85rem; background:var(--note); padding:4px 10px; border-radius:8px; max-width:92%; }
  .n.err { color:var(--bad); font-weight:700; background:transparent; border:1px solid var(--bad); }
  .row { display:flex; gap:8px; margin-top:10px; align-items:flex-end; } .row textarea { min-height:46px; }
  #login { max-width:420px; margin:40px auto; } [hidden] { display:none !important; }
  .empty { color:var(--muted); align-self:center; margin:auto; text-align:center; padding:0 20px; }
</style>
</head>
<body>
<header><h1>DM Setter test chat</h1><span class="hint">Pretend chats only. Nothing is sent to Instagram.</span></header>

<div id="login" class="card" hidden>
  <h2>Enter your admin token</h2>
  <label for="token">Admin token</label>
  <input id="token" type="password" autocomplete="off">
  <p class="hint">The ADMIN_TOKEN you set in Railway. Kept only in this browser tab.</p>
  <button id="go" type="button">Continue</button>
</div>

<main id="app" hidden>
  <section class="card" aria-labelledby="h-biz">
    <h2 id="h-biz">1. The pretend business</h2>
    <label for="f_name">Business name</label><input id="f_name">
    <label for="f_summary">What the business does</label><textarea id="f_summary"></textarea>
    <label for="f_offer">What you are booking people for</label><input id="f_offer">
    <label for="f_idealCustomer">Ideal customer</label><textarea id="f_idealCustomer"></textarea>
    <label for="f_questions">What the bot should find out (one per line)</label><textarea id="f_questions"></textarea>
    <label for="f_disqualifiers">Who is NOT a fit (one per line)</label><textarea id="f_disqualifiers"></textarea>
    <label for="f_tone">Tone of voice</label><input id="f_tone">
    <label for="f_knowledge">Facts the bot can use (prices, hours, location)</label><textarea id="f_knowledge" style="min-height:110px"></textarea>
    <label for="f_forbidden">Never say (one per line)</label><textarea id="f_forbidden"></textarea>
    <label for="f_bookingLink">Booking link (optional)</label><input id="f_bookingLink" placeholder="https://...">
    <p class="hint">Changes apply to your next message. Your answers are saved in this browser.</p>
  </section>

  <section class="card" aria-labelledby="h-chat">
    <h2 id="h-chat">2. Chat as the lead</h2>
    <div id="log" role="log" aria-live="polite"><p class="empty" id="empty">Type a message below, as if you were someone who just DMed this business.</p></div>
    <div class="row">
      <textarea id="msg" aria-label="Your message as the lead" placeholder="Type as the lead... (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="send" type="button">Send</button>
      <button id="reset" type="button" class="secondary">Start over</button>
    </div>
    <p class="hint" id="status" aria-live="polite"></p>
  </section>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var DEFAULTS = {
    name: 'Example Fitness Studio',
    summary: 'Small-group strength and conditioning studio in Ottawa for busy adults.',
    offer: 'A free 20-minute intro call, then a 4-week starter program',
    idealCustomer: 'Adults 25-55 in the Ottawa area who want to get stronger and are ready to start within a month',
    questions: 'What they want to achieve\nHow soon they want to start\nWhether they are in the Ottawa area',
    disqualifiers: 'Lives outside the Ottawa area and wants in-person only\nOnly wants free workouts',
    tone: 'Friendly, casual, encouraging. Short sentences. Occasional light humour.',
    knowledge: 'Program: 4-week starter program, $400.\n\nSchedule: classes Mon-Sat mornings and evenings.\n\nLocation: Ottawa, Ontario. Small groups of up to 8.\n\nIntro call: free, 20 minutes, with a coach.',
    forbidden: 'guaranteed results\nlose 10 pounds\nmedical',
    bookingLink: ''
  };
  var FIELDS = Object.keys(DEFAULTS);
  var token = ''; var messages = []; var state = 'new'; var busy = false;
  try { token = sessionStorage.getItem('dmsetter_token') || ''; } catch (e) {}

  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('dmsetter_test_biz') || '{}') || {}; } catch (e) {}
  FIELDS.forEach(function (k) { $('f_' + k).value = typeof saved[k] === 'string' ? saved[k] : DEFAULTS[k]; });
  function business() { var b = {}; FIELDS.forEach(function (k) { b[k] = $('f_' + k).value; }); return b; }
  FIELDS.forEach(function (k) { $('f_' + k).addEventListener('input', function () { try { localStorage.setItem('dmsetter_test_biz', JSON.stringify(business())); } catch (e) {} }); });

  function show() { var ok = !!token; $('login').hidden = ok; $('app').hidden = !ok; }
  $('go').addEventListener('click', function () { token = $('token').value.trim(); try { sessionStorage.setItem('dmsetter_token', token); } catch (e) {} show(); });

  function add(kind, text) {
    var empty = $('empty'); if (empty) empty.remove();
    var d = document.createElement('div'); d.className = kind === 'lead' || kind === 'bot' ? 'b ' + kind : 'n' + (kind === 'err' ? ' err' : '');
    d.textContent = text; $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
  }

  function send() {
    var text = $('msg').value.trim(); if (!text || busy) return;
    busy = true; $('msg').value = ''; messages.push({ from: 'lead', text: text }); add('lead', text); $('status').textContent = 'The bot is typing...';
    fetch('/api/test-chat', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ business: business(), messages: messages, state: state }) })
      .then(function (r) {
        if (r.status === 401) { try { sessionStorage.removeItem('dmsetter_token'); } catch (e) {} token = ''; show(); throw new Error('Token not accepted. Enter it again.'); }
        return r.json();
      })
      .then(function (j) {
        if (j.error) { messages.pop(); add('err', j.error); $('msg').value = text; return; }
        state = j.state || state;
        if (j.reply) { messages.push({ from: 'bot', text: j.reply }); add('bot', j.reply); }
        (j.actions || []).forEach(function (a) { add('note', a); });
        if (j.note) add('note', j.note);
      })
      .catch(function (e) { if (messages.length && messages[messages.length - 1].from === 'lead') { messages.pop(); $('msg').value = text; } add('err', e.message || 'Something went wrong.'); })
      .then(function () { busy = false; $('status').textContent = ''; $('msg').focus(); });
  }
  $('send').addEventListener('click', send);
  $('msg').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('reset').addEventListener('click', function () {
    messages = []; state = 'new'; $('log').textContent = '';
    var p = document.createElement('p'); p.className = 'empty'; p.id = 'empty'; p.textContent = 'Type a message below, as if you were someone who just DMed this business.'; $('log').appendChild(p);
  });
  show();
})();
</script>
</body>
</html>`;
