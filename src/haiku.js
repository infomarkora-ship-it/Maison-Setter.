/* AI provider layer. Two interchangeable models sit behind one interface:
     - Claude Haiku through Anthropic's API (the original brain),
     - Gemini Flash Lite through Google's API (gemini-3.5-flash-lite by default; GEMINI_MODEL overrides).
   Dashboard Settings decide which one reviews messages, drafts openers, replies and screens vision
   images. Everything a model returns is treated as untrusted text. No SDK: plain fetch calls.
   On any provider failure the callers fall back to holding the message for a human, so a dead key can
   never make the system less safe — it only makes it slower. */
const { BOUNCER_SYSTEM } = require("./bouncer-prompt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");

/* Finds the first complete {...} object in a string, even inside prose or ```json fences. */
function extractJson(text) {
  const s = String(text || ""), start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return repairJson(s.slice(start, i + 1)); } }
  }
  return null;
}
/* Small repairs for the usual model slips: trailing commas, smart quotes around keys, single-quoted strings. */
function repairJson(raw) {
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/[\u201C\u201D]/g, '"')); } catch { /* next */ }
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/'([^'\\]*)'/g, '"$1"')); } catch { return null; }
}

const DECISIONS = ["PASS", "REJECT"];
const ENTITIES = ["REAL_SERVICE_BUSINESS", "MARKETING_AGENCY", "COURSE_CREATOR", "PERSONAL_OR_SPAM"];
const clip = (v, n) => { const s = v == null ? "" : String(v).replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : null; };

/* Turns whatever came back into the exact schema, or null if it cannot be trusted. */
function normalizeDecision(o, { allowAgencies = false } = {}) {
  if (!o || typeof o !== "object") return null;
  const decision = String(o.decision || "").toUpperCase().trim(), entity = String(o.entity_type || "").toUpperCase().trim();
  if (!DECISIONS.includes(decision) || !ENTITIES.includes(entity)) return null;
  let conf = Number(o.confidence_score); if (!Number.isFinite(conf)) return null;
  conf = Math.max(1, Math.min(100, Math.round(conf)));
  const out = { decision, confidence_score: conf, entity_type: entity, detected_niche: (clip(o.detected_niche, 60) || "unknown").toLowerCase(),
    service_location: clip(o.service_location, 80), disqualification_reason: clip(o.disqualification_reason, 200), personalization_hook: clip(o.personalization_hook, 140) };
  // Keep the answer consistent with the rules even if the model slipped.
  if (entity === "COURSE_CREATOR" || entity === "PERSONAL_OR_SPAM") out.decision = "REJECT";
  else if (entity === "MARKETING_AGENCY") out.decision = allowAgencies ? "PASS" : "REJECT";
  if (out.decision === "PASS" && conf < 50) out.decision = "REJECT";
  if (out.decision === "REJECT") { out.personalization_hook = null; out.disqualification_reason ||= { MARKETING_AGENCY: "Marketing agency, not an operating business.", COURSE_CREATOR: "Sells courses or coaching.", PERSONAL_OR_SPAM: "Personal or spam account." }[entity] || "Does not look like a real operating business."; }
  else { out.disqualification_reason = null; if (out.personalization_hook) out.personalization_hook = out.personalization_hook.replace(/^["'\s]+|["'.!\s]+$/g, "").replace(/^(Your|The)\b/, (w) => w.toLowerCase()); }
  return out;
}

/* The user content comes either as a plain string or as Anthropic-style blocks
   ([{type:"text"},{type:"image",source:{type:"base64",media_type,data}}]) — the vision path uses blocks.
   Gemini needs its own part shapes, so the blocks are converted there. */
const textOf = (user) => (typeof user === "string" ? user : user.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const imagesOf = (user) => (typeof user === "string" ? [] : user.filter((b) => b.type === "image" && b.source?.type === "base64"));

function createHaiku(cfg, db) {
  const haikuEnabled = () => !!cfg.anthropicKey;
  const geminiKey = () => String(db.setting("gemini_key", "") || cfg.geminiKey || "").trim();
  const geminiEnabled = () => !!geminiKey();
  /* "" = automatic: haiku when its key exists, else gemini. */
  const chosen = () => db.setting("ai_provider", "") || cfg.aiProvider || "";
  const active = () => { const p = chosen(); return p === "haiku" || p === "gemini" ? p : haikuEnabled() ? "haiku" : "gemini"; };
  const enabled = () => (active() === "haiku" ? haikuEnabled() : geminiEnabled());
  const modelOf = (p) => (p === "gemini" ? cfg.geminiModel : cfg.haikuModel);
  const used = () => { const r = db.get("SELECT input_tokens + output_tokens AS t FROM usage WHERE day = ?", today()); return r ? r.t : 0; };
  const record = (u) => db.run(`INSERT INTO usage(day, input_tokens, output_tokens, calls, cache_read_tokens, cache_write_tokens) VALUES(?, ?, ?, 1, ?, ?)
    ON CONFLICT(day) DO UPDATE SET input_tokens = usage.input_tokens + excluded.input_tokens, output_tokens = usage.output_tokens + excluded.output_tokens, calls = usage.calls + 1,
      cache_read_tokens = usage.cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = usage.cache_write_tokens + excluded.cache_write_tokens`,
    today(), Number(u?.input_tokens) || 0, Number(u?.output_tokens) || 0, Number(u?.cache_read_input_tokens) || 0, Number(u?.cache_creation_input_tokens) || 0);

  /* ---- Claude Haiku (Anthropic) ---- */
  async function askAnthropic({ system, user, maxTokens = 400, cache = false, temperature, signal }) {
    const body = { model: cfg.haikuModel, max_tokens: maxTokens, messages: [{ role: "user", content: user }],
      system: cache && typeof system === "string" ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system };
    if (temperature !== undefined) body.temperature = temperature;
    const res = await fetch(`${cfg.anthropicBase}/v1/messages`, {
      method: "POST", signal,
      headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body)
    });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error("ai_http_" + res.status), { retry: true });
    if (!res.ok) throw new Error("ai_http_" + res.status);
    const data = await res.json();
    return { text: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
      usage: { input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens, cache_read_input_tokens: data.usage?.cache_read_input_tokens, cache_creation_input_tokens: data.usage?.cache_creation_input_tokens } };
  }

  /* ---- Gemini Flash Lite (Google) ---- */
  async function askGemini({ system, user, maxTokens = 400, temperature, signal }) {
    const parts = [{ text: textOf(user) }];
    for (const img of imagesOf(user)) parts.push({ inline_data: { mime_type: img.source.media_type === "image/png" ? "image/png" : "image/jpeg", data: img.source.data } });
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) }
    };
    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, {
      method: "POST", signal, headers: { "x-goog-api-key": geminiKey(), "content-type": "application/json" }, body: JSON.stringify(body)
    });
    if (res.status === 429 || res.status >= 500) throw Object.assign(new Error("ai_http_" + res.status), { retry: true });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ai_http_${res.status}${/API key not valid/i.test(detail) ? " (the Gemini API key was rejected)" : ""}`);
    }
    const data = await res.json();
    const cand = (data.candidates || [])[0];
    if (!cand) throw new Error(data.promptFeedback?.blockReason ? `gemini_blocked_${String(data.promptFeedback.blockReason).toLowerCase()}` : "ai_empty_reply");
    const text = (cand.content?.parts || []).filter((p) => typeof p.text === "string").map((p) => p.text).join("");
    const u = data.usageMetadata || {};
    return { text, usage: { input_tokens: u.promptTokenCount, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
  }

  async function once(args) {
    const t0 = Date.now();
    const out = active() === "gemini" ? await askGemini(args) : await askAnthropic(args);
    return { ...out, ms: Date.now() - t0 };
  }

  /* The one entry point every module uses. Retries provider hiccups (429/5xx/timeout) three times. */
  async function ask({ system, user, maxTokens = 400, cache = false, temperature }) {
    if (!enabled()) throw new Error(active() === "gemini" ? "gemini_disabled" : "haiku_disabled");
    if (used() >= cfg.dailyTokenCap) throw new Error("ai_budget");
    let lastErr = new Error("ai_failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const out = await once({ system, user, maxTokens, cache, temperature, signal: ctrl.signal });
        record(out.usage);
        return out.text;
      } catch (e) {
        lastErr = e.name === "AbortError" ? new Error("ai_timeout") : e;
        if (!lastErr.retry && lastErr.message !== "ai_timeout") throw lastErr;
        await sleep(600 * 2 ** attempt);
      } finally { clearTimeout(timer); }
    }
    throw lastErr.retry ? new Error("ai_http_429_or_5xx") : lastErr;
  }

  /* Same call, but reports latency and token use — the AI Lab shows it next to each run. */
  async function askDetailed(args) {
    if (!enabled()) throw new Error(active() === "gemini" ? "gemini_disabled" : "haiku_disabled");
    if (used() >= cfg.dailyTokenCap) throw new Error("ai_budget");
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 45_000);
    try { const out = await once({ ...args, signal: ctrl.signal }); record(out.usage); return out; }
    catch (e) { throw e.name === "AbortError" ? new Error("ai_timeout") : e; }
    finally { clearTimeout(timer); }
  }

  async function askJson(args) {
    const obj = extractJson(await ask(args));
    if (!obj) throw new Error("ai_bad_json");
    return obj;
  }

  /* The bouncer. Strict JSON at temperature 0, with one repair retry. Never throws on a malformed answer:
     it returns { ok: false, error } so the worker can park the lead for a person instead of crashing.
     The campaign's lead brief (the operator's plain-words description of who they want) rides in the
     user message, so the static system prompt stays cacheable. */
  async function classify({ campaign, lead }) {
    const allowAgencies = !!campaign.allowAgencies;
    const brief = String(campaign.leadBrief || "").trim().slice(0, 3500);
    const user = `<campaign>\nallow_agencies: ${allowAgencies}\ntarget: ${campaign.target || "any real operating business that sells services"}\noffer: ${campaign.offer || ""}\n${brief ? `<lead_brief>\nThe operator of this campaign wrote this brief in their own words about exactly which leads they want and which they never want messaged. It decides. Follow it on top of the rules above; when the brief and the target line disagree, the brief wins.\n${brief}\n</lead_brief>\n` : ""}</campaign>\n<lead>\n${lead}\n</lead>`;
    let prior = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let text;
      try {
        text = await ask({ system: BOUNCER_SYSTEM, cache: true, temperature: 0, maxTokens: 350,
          user: attempt === 0 ? user : `${user}\n\nYour previous reply was not valid JSON in the required schema:\n${prior.slice(0, 1200)}\nReply again with ONLY the JSON object, exactly those seven keys.` });
      } catch (e) { return { ok: false, error: e.message }; }
      const parsed = normalizeDecision(extractJson(text), { allowAgencies });
      if (parsed) return { ok: true, decision: parsed, retried: attempt > 0 };
      prior = text;
    }
    return { ok: false, error: "ai_bad_json" };
  }

  /* A tiny ping for the Settings page. Reports the model it reached and how long it took. */
  async function testProvider(p) {
    const t0 = Date.now();
    const save = chosen();
    try {
      db.setSetting("ai_provider", p);                          // route the ping through the chosen provider
      const text = await ask({ system: "You are a connection test. Reply with exactly one word: pong", user: "pong?", maxTokens: 200, temperature: 0 });
      return { ok: /pong/i.test(text), ms: Date.now() - t0, model: modelOf(p), reply: String(text).slice(0, 40) };
    } catch (e) { return { ok: false, ms: Date.now() - t0, model: modelOf(p), error: e.message }; }
    finally { db.setSetting("ai_provider", save); }
  }

  const status = () => {
    const u = db.get("SELECT calls, input_tokens AS i, cache_read_tokens AS r, cache_write_tokens AS w FROM usage WHERE day = ?", today()) || { calls: 0, i: 0, r: 0, w: 0 };
    const allIn = u.i + u.r + u.w;
    return { configured: enabled(), provider: active(), model: modelOf(active()), usedToday: used(), dailyCap: cfg.dailyTokenCap, calls: u.calls,
      cacheReadTokens: u.r, cacheWriteTokens: u.w, cacheHitRate: allIn ? Math.round((u.r / allIn) * 100) : 0,
      haiku: { configured: haikuEnabled(), model: cfg.haikuModel },
      gemini: { configured: geminiEnabled(), model: cfg.geminiModel, keyFromDashboard: !cfg.geminiKey && !!geminiKey() } };
  };

  return { enabled, ask, askDetailed, askJson, classify, status, testProvider, active,
    setProvider: (p) => db.setSetting("ai_provider", ["haiku", "gemini"].includes(p) ? p : ""),
    setGeminiKey: (k) => db.setSetting("gemini_key", String(k || "").trim().slice(0, 200)),
    providers: () => ({ chosen: chosen(), active: active(), haiku: haikuEnabled(), gemini: geminiEnabled() }) };
}
module.exports = { createHaiku, extractJson, normalizeDecision, ENTITIES, DECISIONS };
