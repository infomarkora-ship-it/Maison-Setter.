// Run:  ANTHROPIC_API_KEY=... npm run evals -- [clients/yourclient.json]
// Costs a few cents. Re-run after every prompt or model change. Exit code 1 if anything fails.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createLlm } from '../src/ai/llm.js';
import { runTurn } from '../src/ai/converse.js';
import { FakeHost } from '../tests/helpers.js';
import { makeClient } from '../tests/helpers.js';
import type { Turn } from '../src/types.js';

interface Expect {
  replyMatch?: string[]; replyNotMatch?: string[]; maxWords?: number; maxQuestions?: number;
  handoff?: boolean; noHandoff?: boolean; handoffOrAsk?: boolean; dnc?: boolean; noReply?: boolean; toolsInclude?: string[];
}
interface Scenario { id: string; history: Array<['in' | 'out', string]>; expect: Expect }

const file = process.argv[2] ?? 'clients/example.json';
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const client = makeClient({
  name: cfg.name, settings: cfg.settings, knowledge: cfg.knowledge ?? '', timezone: cfg.timezone ?? 'America/Toronto',
  calendarProvider: 'mock', instagramAccountId: 'ig-own',
});
const scenarios = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8')) as Scenario[];

let totalCost = 0;
const llm = createLlm((u) => { totalCost += u.costUsd; });
let failed = 0;

for (const s of scenarios) {
  const host = new FakeHost();
  const history: Turn[] = s.history.map(([d, body]) => ({ direction: d, body, createdAt: new Date() }));
  let r;
  try {
    r = await runTurn({ llm, client, history, host, context: { nowLocal: new Date().toString(), source: 'inbound_dm', state: 'new' } });
  } catch (e) {
    console.error(`API error on "${s.id}": ${(e as Error).message}\nCheck LLM_PROVIDER, the API key (ANTHROPIC_API_KEY or GEMINI_API_KEY) and the model name.`);
    process.exit(2);
  }
  const reply = r.text ?? '';
  const words = reply.split(/\s+/).filter(Boolean).length;
  const problems: string[] = [];
  const e = s.expect;

  for (const p of e.replyMatch ?? []) if (!new RegExp(p, 'i').test(reply)) problems.push(`missing /${p}/`);
  for (const p of e.replyNotMatch ?? []) if (new RegExp(p, 'i').test(reply)) problems.push(`contains /${p}/`);
  if (e.maxWords && words > e.maxWords) problems.push(`${words} words > ${e.maxWords}`);
  if (e.maxQuestions && (reply.match(/\?/g) ?? []).length > e.maxQuestions) problems.push('more than one question');
  if (e.handoff && !r.handedOff) problems.push('expected handoff');
  if (e.noHandoff && r.handedOff) problems.push('unexpected handoff');
  if (e.handoffOrAsk && !r.handedOff && !reply.includes('?')) problems.push('neither handed off nor asked');
  if (e.dnc && !r.dnc) problems.push('expected do-not-contact');
  if (e.noReply && r.text) problems.push('expected no reply');
  for (const t of e.toolsInclude ?? []) if (!r.toolsUsed.includes(t)) problems.push(`expected tool ${t}`);

  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.id}${ok ? '' : '  <- ' + problems.join('; ')}`);
  console.log(`      reply: ${reply ? JSON.stringify(reply) : '(none)'}  tools: [${r.toolsUsed.join(', ')}]${r.handedOff ? ' HANDOFF' : ''}`);
}
console.log(`\n${scenarios.length - failed}/${scenarios.length} passed. Model cost for this run: $${totalCost.toFixed(4)}`);
process.exit(failed ? 1 : 0);
