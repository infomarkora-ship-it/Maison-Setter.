/* The AI builder: "describe what you want" for every section of the operation. Four doors,
   all riding the same model layer (haiku.js):
     - build()       fills the REAL form fields from a plain-words description:
                     campaign basics, opener scripts, follow-up sequence, warm-up plan, ICP
     - interview()   the onboarding interview: a fixed set of 8 questions, one at a time,
                     then it synthesizes the company brain and a draft ICP for approval
     - approveBrain() saves the approved brain + ICP and syncs the campaign row
     - chat()        the free-form builder panel: talk it out, get a proposed patch back,
                     apply what you like with one button
   Every string that leaves this module goes through noEmDash(): the rule is absolute. */
const { str, num, clamp, j, HttpError, noEmDash } = require("./util");
const { validatePlan, DEFAULT_RAMP } = require("./warmup");
const { BRAIN_FIELDS, ICP_FIELDS } = require("./brain");

const BUILD_WHATS = ["campaign", "opener", "followups", "warmup", "icp"];
const BRAIN_MAX_LENGTH = 900;

const BUILDER_SYSTEM = `You are the strategy brain of an Instagram outreach operation that books appointments for small businesses. You turn plain-words descriptions into concrete campaign pieces.
Rules:
- Output ONE JSON object and nothing else: no markdown fences, no commentary.
- Every string you write is text real people will read, or a field the operation will run on. Plain, human, concrete. Never use an em dash or an en dash: use commas, periods or parentheses instead.
- Use only facts from the knowledge and context you are given. If something is unknown, write around it or leave it out; never invent prices, guarantees, results, names or claims.
- Match the tone the user asks for. Default tone: friendly, short, casual, confident.
- Respect the exact keys and limits in the spec.`;

const SPECS = {
  campaign: `Fill the campaign basics. Return:
{"offer": "what the business offers, one or two lines a lead instantly understands, max 600 chars", "target": "who to reach, concrete: business types, roles, geography, max 450 chars", "tone": "how messages should sound, 3 to 8 words, max 120 chars", "explanation": "2 to 4 sentences on why this fits the niche"}`,
  opener: `Build the first-message scripts. Return:
{"openerTemplate": "script for business leads, max 300 chars, may use {first_name}, {hook}, {niche}, {city}", "agencyOpenerTemplate": "the same idea for marketing agencies, max 300 chars", "explanation": "2 to 4 sentences: the personalization strategy, what varies per lead, why it gets replies"}
The script must end with an easy question, name no links, and leave {hook} for the per-lead detail the AI writes later.`,
  followups: `Build the follow-up sequence. Return:
{"followups": [{"afterDays": number between 1 and 14, "text": "the message, max 420 chars, may use {first_name}"}], "explanation": "2 to 4 sentences on the rhythm and why it fits this niche and sales cycle"}
Decide the number of touches yourself: 3 to 6 based on the niche and how long a sale takes. Each touch adds something NEW (a proof point, a different angle, urgency, then a clean breakup last). afterDays should rise across the sequence. Never use an em dash.`,
  warmup: `Design the warm-up program. Return:
{"name": "short plan name, max 50 chars", "ranges": [{"until": "last day of the phase, integer", "label": "phase name", "sessions": "browsing sessions per day, 1 to 6", "dms": "DMs per day, 0 to 10", "follows": "follows per day, 0 to 4", "plan": "what this phase does, one line"}], "explanation": "3 to 5 sentences: why this rhythm fits this niche, this account age and this risk level"}
Hard rules: the first 3 days are 0 DMs; every phase's until is later than the one before; DMs max 10 a day, follows max 4, sessions max 6; total program 14 to 30 days unless the user explicitly asks otherwise; shape: browse only, then browsing plus touches, then first DMs at low volume, then a gradual ramp.`,
  icp: `Draft the ideal customer profile. Return:
{"icp": {"industries": "target industries, one per line (newlines inside the string)", "businessTypes": "target business types, one per line", "size": "ideal size, e.g. follower range or team size", "geography": "where they are", "decisionMakers": "who decides", "needs": "what they need that connects to the offer, one per line", "painPoints": "their pains, one per line", "positiveSignals": "profile signals that say contact them, one per line", "excludedIndustries": "never contact, one per line", "excludedTypes": "never contact, one per line"}, "explanation": "2 to 4 sentences on who to focus on and why"}`
};

/* The 8 interview questions: a fixed set, always the same count, asked one at a time. */
const QUESTIONS = [
  { id: "company", text: "Tell me about the company. What do you do, and who do you do it for?" },
  { id: "offer", text: "What's the main thing you sell, and what does it usually cost (or what range)?" },
  { id: "differentiator", text: "Why do customers pick you over the alternatives? What actually makes you different?" },
  { id: "proof", text: "What proof or results can we point to? Numbers, case studies, reviews, known clients, anything real." },
  { id: "icp", text: "Describe your ideal customer. If you already have a written ICP, paste it here. If not, just describe them and I'll draft one for you." },
  { id: "tone", text: "How should the outreach sound? Tone, words you would never use, anything that would embarrass you." },
  { id: "pricing", text: "How should price questions be handled? What can we say about pricing, and what stays for the call?" },
  { id: "booking", text: "What happens after someone books? Booking link, who takes the call, how long it runs, what we can promise." }
];

const PHRASE_SYSTEM = `You are the onboarding interviewer for an Instagram outreach operation. Friendly, quick, human, one question at a time. Reply with ONE JSON object and nothing else: {"question":"..."}. Never use an em dash.`;

function createBuilder(ctx) {
  const { db, haiku, growth, brain } = ctx;

  const needAi = () => { if (!haiku.enabled()) throw new HttpError(409, "No AI model is connected yet. Connect one in Settings, then come back."); };
  const clientFor = (id) => { const c = id ? db.get("SELECT * FROM clients WHERE id = ?", num(id)) : null; if (!c) throw new HttpError(400, "Pick the campaign this is for."); return c; };
  const clean = (v, max) => noEmDash(str(v, max)).trim();

  /* ---------------- build: describe it, AI fills the fields ---------------- */
  function shapeCampaign(o) {
    return { fields: { offer: clean(o.offer, 700), target: clean(o.target, 500), tone: clean(o.tone, 150) || "friendly, short, casual" }, explanation: clean(o.explanation, 700) };
  }
  function shapeOpener(o) {
    const openerTemplate = clean(o.openerTemplate, 400), agencyOpenerTemplate = clean(o.agencyOpenerTemplate, 400);
    if (!openerTemplate) throw new HttpError(502, "The AI did not return an opener script. Try again.");
    return { fields: { openerTemplate, agencyOpenerTemplate }, explanation: clean(o.explanation, 700) };
  }
  function shapeFollowups(o) {
    const list = Array.isArray(o.followups) ? o.followups.slice(0, 6) : [];
    const followups = list.map((f) => ({ afterDays: clamp(Math.round(num(f.afterDays, 2) * 4) / 4, 0.25, 30), text: clean(f.text, 500) })).filter((f) => f.text);
    if (followups.length < 2) throw new HttpError(502, "The AI returned too few usable follow-ups. Try again.");
    return { fields: { followups }, explanation: clean(o.explanation, 700) };
  }
  function shapeWarmup(o, { allowUnsafe }) {
    const plan = { name: clean(o.name, 60) || "AI warm-up plan", ranges: Array.isArray(o.ranges) ? o.ranges : [], ramp: Array.isArray(o.ramp) ? o.ramp : DEFAULT_RAMP };
    let validated;
    try { validated = validatePlan(plan, { allowUnsafe: !!allowUnsafe }); }
    catch (e) { const err = new Error(e.message); err.retry = true; throw err; }
    return { fields: { plan: validated }, explanation: clean(o.explanation, 900) };
  }
  function shapeIcp(o) {
    const icp = {};
    for (const f of ICP_FIELDS) icp[f] = clean(o.icp?.[f], 400);
    return { fields: { icp }, explanation: clean(o.explanation, 700) };
  }

  async function build(body) {
    const what = String(body.what || "");
    if (!BUILD_WHATS.includes(what)) throw new HttpError(400, "Unknown build target.");
    needAi();
    const description = noEmDash(str(body.description, 4000)).trim();
    if (!description) throw new HttpError(400, "Describe what you want in plain words first.");
    const needsCampaign = what !== "warmup";
    const client = needsCampaign ? clientFor(body.clientId) : (body.clientId ? db.get("SELECT * FROM clients WHERE id = ?", num(body.clientId)) : null);
    const blocks = brain.contextBlocks(client);
    const campaignTxt = client ? `name: ${str(client.name, 80)}\noffer: ${str(client.offer, 700) || "(none)"}\ntarget: ${str(client.target, 500) || "(none)"}\ntone: ${str(client.tone, 150)}\nbooking link: ${client.booking_link || "none"}` : "(new campaign, nothing set yet)";
    const user = `<task>\nwhat to build: ${what}\nhow the user describes it:\n${description}\n</task>\n<campaign>\n${campaignTxt}\n</campaign>\n<company_brain>\n${blocks.brainBlock || "(none yet)"}\n</company_brain>\n<knowledge>\n${blocks.kbBlock}\n</knowledge>\n<spec>\n${SPECS[what]}\n</spec>`;
    const shaper = { campaign: shapeCampaign, opener: shapeOpener, followups: shapeFollowups, icp: shapeIcp, warmup: (o) => shapeWarmup(o, { allowUnsafe: !!body.allowUnsafe }) }[what];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let o;
      try {
        o = await haiku.askJson({ system: BUILDER_SYSTEM, maxTokens: 2400, temperature: 0.4,
          user: attempt ? `${user}\n\nYour previous answer failed validation: ${lastErr}\nFix exactly that and reply again with ONLY the JSON object.` : user });
      } catch (e) { throw new HttpError(502, `The AI could not build this (${e.message}). Try again.`); }
      try { return { what, ...shaper(o) }; }
      catch (e) { lastErr = e.message; if (!e.retry) throw new HttpError(502, `The AI gave something unusable (${e.message}). Try again.`); }
    }
    throw new HttpError(502, `The AI could not produce a valid warm-up plan (${lastErr}). Try again, or describe a more cautious rhythm.`);
  }

  /* ---------------- the interview: 8 questions, one at a time ---------------- */
  const answeredText = (iv) => QUESTIONS.filter((q) => iv.answers[q.id]).map((q) => `Q (${q.id}): ${q.text}\nA: ${iv.answers[q.id]}`).join("\n\n") || "(nothing yet)";

  async function synthesize(client, answers) {
    const qa = QUESTIONS.map((q, i) => `Q${i + 1} (${q.id}): ${q.text}\nA: ${answers[q.id] || "(no answer)"}`).join("\n\n");
    const system = `${BUILDER_SYSTEM}\n\nYou are now synthesizing an interview into the company brain and a draft ICP. Leave a field out (empty string) rather than inventing anything. The summary reads like a setter briefing a teammate.`;
    const user = `<campaign>\nname: ${str(client.name, 80)}\noffer: ${str(client.offer, 700) || "(none)"}\ntarget: ${str(client.target, 500) || "(none)"}\ntone: ${str(client.tone, 150)}\n</campaign>\n<interview>\n${qa}\n</interview>\n<spec>\nReturn {"brain": {"company": "...", "market": "...", "offer": "...", "pricingApproach": "...", "differentiators": "...", "proof": "...", "tone": "...", "doNotSay": "...", "bookingProcess": "..."} each max 2 sentences, "icp": {"industries": "one per line", "businessTypes": "one per line", "size": "...", "geography": "...", "decisionMakers": "...", "needs": "one per line", "painPoints": "one per line", "positiveSignals": "one per line", "excludedIndustries": "one per line", "excludedTypes": "one per line"}, "summary": "5 to 8 sentences describing this business the way a setter would brief a teammate"}</spec>`;
    const o = await haiku.askJson({ system, user, maxTokens: 2600, temperature: 0.3 });
    const brainOut = {}, icp = {};
    for (const f of BRAIN_FIELDS) brainOut[f] = clean(o.brain?.[f], BRAIN_MAX_LENGTH);
    for (const f of ICP_FIELDS) icp[f] = clean(o.icp?.[f], 400);
    return { brain: brainOut, icp, summary: clean(o.summary, 1600) };
  }

  async function interview(body) {
    needAi();
    const clientId = num(body.clientId);
    const client = clientFor(clientId);
    const ob = growth.getOnboarding(clientId), data = ob ? j(ob.data, {}) : {};
    const iv = data.interview && typeof data.interview === "object" && !Array.isArray(data.interview)
      ? data.interview : { step: 0, answers: {}, asked: {}, draft: null };
    iv.answers = iv.answers && typeof iv.answers === "object" ? iv.answers : {};
    iv.asked = iv.asked && typeof iv.asked === "object" ? iv.asked : {};
    const answer = body.answer !== undefined ? noEmDash(str(body.answer, 4000)).trim() : "";
    if (answer && iv.step < QUESTIONS.length) {
      const q = QUESTIONS[Math.min(iv.step, QUESTIONS.length - 1)];
      iv.answers[q.id] = answer;
      iv.step = Math.min(QUESTIONS.length, iv.step + 1);
    } else if (answer && iv.step >= QUESTIONS.length) {
      const q = QUESTIONS[QUESTIONS.length - 1];
      iv.answers[q.id] = answer;               // refining the last answer: rebuild the draft
      iv.draft = null;
    }
    if (iv.step >= QUESTIONS.length) {
      if (!iv.draft) iv.draft = await synthesize(client, iv.answers);
      growth.saveOnboarding(clientId, { interview: iv });
      return { done: true, total: QUESTIONS.length, brain: iv.draft.brain, icp: iv.draft.icp, summary: iv.draft.summary };
    }
    /* ask the next fixed question, phrased with the context of what was already answered */
    const q = QUESTIONS[iv.step];
    let text = q.text;
    try {
      const o = await haiku.askJson({ system: PHRASE_SYSTEM, maxTokens: 300, temperature: 0.5,
        user: `<question topic>\n${q.text}\n</question topic>\n<answers so far>\n${answeredText(iv)}\n</answers so far>\n<spec>\nRewrite the question as ONE short conversational text (max 220 characters) that references what they already told you when it is useful. Ask about exactly this topic and nothing else. Keep it plain and warm.</spec>` });
      if (o.question) text = clean(o.question, 300);
    } catch { /* fall back to the base text: the interview must never stall */ }
    iv.asked[iv.step] = text;
    growth.saveOnboarding(clientId, { interview: iv });
    return { index: iv.step + 1, total: QUESTIONS.length, topic: q.id, question: text };
  }

  /* ---------------- approve: brain + ICP land, the campaign row syncs ---------------- */
  function approveBrain(body) {
    const clientId = num(body.clientId);
    const client = clientFor(clientId);
    const ob = growth.getOnboarding(clientId), data = ob ? j(ob.data, {}) : {};
    const draft = data.interview && data.interview.draft ? data.interview.draft : {};
    const given = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
    const brainIn = { ...given(draft.brain), ...given(body.brain) };
    const icpIn = { ...given(draft.icp), ...given(body.icp) };
    const brainOut = {}, icpOut = {};
    for (const f of BRAIN_FIELDS) brainOut[f] = clean(brainIn[f], BRAIN_MAX_LENGTH);
    for (const f of ICP_FIELDS) icpOut[f] = clean(icpIn[f], 400);
    growth.saveOnboarding(clientId, { brain: brainOut, icp: icpOut });
    const applied = [];
    if (body.apply !== false) {
      const patch = {};
      if (brainOut.offer) patch.offer = brainOut.offer;
      if (brainOut.tone) patch.tone = brainOut.tone;
      const target = [icpOut.businessTypes || icpOut.industries, icpOut.geography].filter(Boolean).join(", ").slice(0, 500);
      if (target) patch.target = target;
      const keys = Object.keys(patch);
      if (keys.length) {
        db.run(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => patch[k]), clientId);
        applied.push(...keys);
      }
    }
    return { ok: true, brain: brainOut, icp: icpOut, applied };
  }

  /* ---------------- the chat builder ---------------- */
  const CHAT_SECTIONS = ["business", "offer", "icp", "qualification", "goals", "outreach", "conversation", "appointments", "campaign", "knowledge"];
  function sanitizeUpdates(u) {
    if (!u || typeof u !== "object" || Array.isArray(u)) return null;
    const out = {};
    for (const k of ["offer", "target", "tone"]) if (u[k] !== undefined && clean(u[k], 800)) out[k] = clean(u[k], 800);
    for (const k of ["openerTemplate", "agencyOpenerTemplate"]) if (u[k] !== undefined && clean(u[k], 400)) out[k] = clean(u[k], 400);
    if (Array.isArray(u.followups)) {
      const fu = u.followups.slice(0, 6).map((f) => ({ afterDays: clamp(Math.round(num(f.afterDays, 2) * 4) / 4, 0.25, 30), text: clean(f.text, 500) })).filter((f) => f.text);
      if (fu.length >= 2) out.followups = fu;
    }
    if (u.warmupPlan && typeof u.warmupPlan === "object" && !Array.isArray(u.warmupPlan) && Array.isArray(u.warmupPlan.ranges) && u.warmupPlan.ranges.length)
      out.warmupPlan = { name: clean(u.warmupPlan.name, 60) || "Chat warm-up plan", ranges: u.warmupPlan.ranges, ramp: Array.isArray(u.warmupPlan.ramp) ? u.warmupPlan.ramp : DEFAULT_RAMP };
    if (u.onboarding && typeof u.onboarding === "object" && !Array.isArray(u.onboarding)) {
      const ob = {};
      for (const s of CHAT_SECTIONS) if (u.onboarding[s] && typeof u.onboarding[s] === "object" && !Array.isArray(u.onboarding[s])) {
        const fields = {};
        for (const [k, v] of Object.entries(u.onboarding[s])) if (clean(v, 2000)) fields[k] = clean(v, 2000);
        if (Object.keys(fields).length) ob[s] = fields;
      }
      if (Object.keys(ob).length) out.onboarding = ob;
    }
    return Object.keys(out).length ? out : null;
  }

  async function chat(body) {
    needAi();
    const clientId = num(body.clientId);
    const client = clientFor(clientId);
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-16)
      .map((m) => ({ role: m && m.role === "user" ? "user" : "assistant", text: clean(m?.text, 4000) })).filter((m) => m.text);
    if (!msgs.length) throw new HttpError(400, "Say something first.");
    const blocks = brain.contextBlocks(client);
    const system = `${BUILDER_SYSTEM}

You are now in a chat with the operator who runs this campaign. Talk like a sharp setter-strategist: short, direct, concrete, no fluff.
Reply with ONE JSON object: {"reply": "what you say next", "updates": {...} or null, "note": "one line on what applying it would change"}
"updates" is OPTIONAL and only when the conversation has settled on concrete changes. Allowed keys:
  "offer", "target", "tone": strings that replace the campaign basics,
  "openerTemplate", "agencyOpenerTemplate": first-message scripts, may use {first_name} {hook} {niche} {city},
  "followups": [{"afterDays": number, "text": "..."}] with 3 to 6 touches,
  "warmupPlan": {"name": "...", "ranges": [{"until": 3, "label": "...", "sessions": 2, "dms": 0, "follows": 0, "plan": "..."}]},
  "onboarding": {"business"|"offer"|"icp"|"qualification"|"goals"|"outreach"|"conversation"|"appointments"|"campaign"|"knowledge": {"field": "value"}}
Never put anything in "updates" you have not agreed on in the chat. Never use an em dash.`;
    const user = `<campaign>\nname: ${str(client.name, 80)}\noffer: ${str(client.offer, 700) || "(none)"}\ntarget: ${str(client.target, 500) || "(none)"}\ntone: ${str(client.tone, 150)}\nbooking link: ${client.booking_link || "none"}\n</campaign>\n<company_brain>\n${blocks.brainBlock || "(none yet)"}\n</company_brain>\n<knowledge>\n${blocks.kbBlock}\n</knowledge>\n<chat, newest last>\n${msgs.map((m) => `${m.role === "user" ? "OPERATOR" : "YOU"}: ${m.text}`).join("\n")}\n</chat>\nReply with the JSON object now.`;
    const o = await haiku.askJson({ system, user, maxTokens: 2400, temperature: 0.6 });
    return { reply: clean(o.reply, 2000) || "(empty reply)", note: clean(o.note, 400), updates: sanitizeUpdates(o.updates) };
  }

  /* ---------------- brief rules: the lead brief, translated into concrete pre-filter settings ----------------
     The operator writes WHO THEY WANT in plain words; the AI proposes what the free pre-filter should
     reject (follower bounds, activity window, contact requirement, exclude words). It only proposes:
     the dashboard fills the rule fields as a recommendation and nothing saves until Save changes. */
  const BRIEF_SPEC = `Translate the operator's lead brief into the pre-filter's concrete settings. Return:
{"minFollowers": integer 0 to 1000000 (fewest followers a lead may have; 150 when the brief says nothing about size),
 "maxFollowers": integer 0 to 5000000 (0 means no cap; most followers a lead may have),
 "activeWithinDays": integer 0 to 365 (must have posted within this many days; 30 when the brief is silent; 0 means do not check),
 "requireContact": true or false (true when the brief wants reachable, established businesses),
 "allowCreatorLabels": true or false (true ONLY when the brief explicitly wants creators, coaches or personal brands),
 "excludeWords": ["word or phrase per entry, max 20 entries"] (bios containing any of these are rejected; pull niches, words and patterns the brief says to never message; [] when the brief lists none),
 "explanation": "3 to 6 sentences: what you changed and which line of the brief caused it"}
Only propose what the brief actually implies. Do not invent industries or words that are not in the brief. Never use an em dash.`;

  async function briefRules(body) {
    needAi();
    const client = clientFor(body.clientId);
    const brief = noEmDash(str(body.brief, 6000)).trim();
    if (!brief) throw new HttpError(400, "Write the lead brief first.");
    const blocks = brain.contextBlocks(client);
    const user = `<campaign>\nname: ${str(client.name, 80)}\noffer: ${str(client.offer, 700) || "(none)"}\ntarget: ${str(client.target, 500) || "(none)"}\ncurrent rules: minFollowers=${client.min_followers}, maxFollowers=${client.max_followers}, activeWithinDays=${client.active_within_days}, requireContact=${!!client.require_contact}, allowCreatorLabels=${!!client.allow_creator_labels}, excludeWords=${str(client.exclude_words, 400) || "none"}\n</campaign>\n<company_brain>\n${blocks.brainBlock || "(none yet)"}\n</company_brain>\n<lead_brief>\n${brief}\n</lead_brief>\n<spec>\n${BRIEF_SPEC}\n</spec>`;
    let o;
    try { o = await haiku.askJson({ system: BUILDER_SYSTEM, user, maxTokens: 1200, temperature: 0.3 }); }
    catch (e) { throw new HttpError(502, `The AI could not read the brief (${e.message}). Try again.`); }
    const clampI = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? clamp(n, lo, hi) : def; };
    const minFollowers = clampI(o.minFollowers, 0, 1_000_000, client.min_followers), maxFollowers = clampI(o.maxFollowers, 0, 5_000_000, client.max_followers);
    const excludeWords = (Array.isArray(o.excludeWords) ? o.excludeWords : []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 20);
    return { fields: {
      minFollowers, maxFollowers: Math.max(maxFollowers, minFollowers),
      activeWithinDays: clampI(o.activeWithinDays, 0, 365, client.active_within_days),
      requireContact: o.requireContact === undefined ? !!client.require_contact : !!o.requireContact,
      allowCreatorLabels: !!o.allowCreatorLabels,
      excludeWords
    }, explanation: clean(o.explanation, 900) };
  }

  return { build, interview, approveBrain, chat, briefRules, QUESTIONS, BUILD_WHATS };
}
module.exports = { createBuilder, QUESTIONS };
