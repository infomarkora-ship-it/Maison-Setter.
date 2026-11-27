/* The AI Lab: a sandbox where you test the bot without touching a single real lead, task or inbox.
   Two testers, both running the exact production code paths:
     - Draft test: the same prompts the server uses to write openers and replies (leads.openerPrompt /
       leads.replyPrompt), pointed at a made-up or pasted profile and conversation.
     - Supervisor drill: supervisor.preview() — the same hard rules, the same model prompt, the same
       autonomy thresholds (watch / supervised / autopilot) as a real send.
   Drafts are never saved, never queued, never sent. Every drill is recorded in the supervisor log
   with kind "lab:<type>" so you can look back at what you tested. */
const { str, num, HttpError } = require("./util");

const KINDS = { dm: "dm", first: "dm", reply: "reply", followup: "followup" };

function createLab(ctx) {
  const { db, haiku, leads, accounts, supervisor } = ctx;

  const clientOf = (clientId) => {
    const c = clientId ? db.get("SELECT * FROM clients WHERE id = ?", num(clientId)) : null;
    if (!c) throw new HttpError(400, "Pick the campaign this test should use.");
    return c;
  };
  /* A profile for the model to look at. Everything is optional; the lab fills friendly blanks. */
  const profileOf = (b) => ({
    name: str(b.name, 80) || "Sam Rivera",
    bio: str(b.bio, 800) || "Owner at a small local service business. Loves talking shop.",
    category: str(b.category, 80) || "Local service",
    captions: (Array.isArray(b.captions) ? b.captions : []).slice(0, 5).map((x) => str(x, 300))
  });
  const historyOf = (b) => (Array.isArray(b.conversation) ? b.conversation.slice(-12) : [])
    .map((m) => ({ direction: m.dir === "out" ? "out" : "in", text: str(m.text, 600) }));

  /* POST /api/lab/draft { clientId, kind: "dm"|"reply"|"followup", name, bio, category, captions, conversation } */
  async function draft(body) {
    const client = clientOf(body.clientId), kind = KINDS[body.kind || "dm"] || "dm";
    const profile = profileOf(body), history = historyOf(body);
    if (!haiku.enabled()) throw new HttpError(409, "No AI model is connected yet. Connect one in Settings, then come back.");
    const t0 = Date.now();
    let raw, text = "";
    if (kind === "dm") {
      const r = await haiku.askJson(leads.openerPrompt(client, { ...profile, captions: profile.captions }));
      raw = r; text = leads.cleanText(r.opener, client, false);
    } else {
      if (!history.length) throw new HttpError(400, "Add at least one message the lead sent, so the reply has something to answer.");
      const r = await haiku.askJson(leads.replyPrompt(client, profile, history.map((m) => ({ direction: m.direction === "in" ? "in" : "out", text: m.text }))));
      raw = r; text = leads.cleanText(r.reply, client, true);
    }
    return {
      kind, text, ms: Date.now() - t0,
      intent: raw.intent || null, handoff: !!raw.handoff,
      clean: text !== String(kind === "dm" ? raw.opener : raw.reply || "").replace(/\s+/g, " ").trim(),
      model: haiku.status().model, provider: haiku.status().provider
    };
  }

  /* POST /api/lab/verdict { clientId, accountId?, kind, text, username, name, conversation, mode } */
  function verdict(body) {
    const client = clientOf(body.clientId);
    const account = body.accountId ? accounts.byId(num(body.accountId)) : null;
    const kind = KINDS[body.kind || "dm"] || "dm";
    const text = str(body.text, 700);
    if (!text.trim()) throw new HttpError(400, "Write the message to review.");
    return supervisor.preview({ account, client, type: kind, text, username: str(body.username, 40) || "lead", name: str(body.name, 80), conversation: (body.conversation || []).slice(-8).map((m) => ({ dir: m.dir, text: m.text })), mode: body.mode });
  }

  const history = ({ limit } = {}) => ({ runs: supervisor.labList({ limit: num(limit, 30) }) });
  return { draft, verdict, history };
}
module.exports = { createLab };
