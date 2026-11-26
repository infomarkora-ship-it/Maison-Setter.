/* The company brain and the layered knowledge base.
   Three layers feed every prompt that talks to a lead:
     1. the built-in playbook (src/playbook.js): always on, ships with the app
     2. the global company knowledge (one per workspace, edited on the "Knowledge & script" page)
     3. per-campaign knowledge + script (onboarding slide "Business context & knowledge")
   On top sits the company brain: the structured profile the 8-question AI interview produces
   and the operator approves. Everything here is plain text in, plain text out; nothing in this
   file calls the model. */
const { j, str, noEmDash } = require("./util");

const KB_FIELDS = ["overview", "faqs", "pricing", "objections", "policies", "proof", "script", "extra"];
const BRAIN_FIELDS = ["company", "market", "offer", "pricingApproach", "differentiators", "proof", "tone", "doNotSay", "bookingProcess"];
const ICP_FIELDS = ["industries", "businessTypes", "size", "geography", "decisionMakers", "needs", "painPoints", "positiveSignals", "excludedIndustries", "excludedTypes"];
const KB_MAX = { overview: 2000, faqs: 4000, pricing: 2000, objections: 4000, policies: 2000, proof: 3000, script: 6000, extra: 3000 };
const BRAIN_MAX = 900;

function createBrain(ctx) {
  const { db } = ctx;
  const KEY = "company_kb";
  const empty = () => Object.fromEntries(KB_FIELDS.map((f) => [f, ""]));

  const getGlobal = () => {
    const out = empty(), v = db.setting(KEY, null);
    if (v && typeof v === "object" && !Array.isArray(v)) for (const f of KB_FIELDS) out[f] = str(v[f] || "", KB_MAX[f]);
    return out;
  };
  const saveGlobal = (k) => {
    const out = empty();
    if (k && typeof k === "object" && !Array.isArray(k)) for (const f of KB_FIELDS) out[f] = noEmDash(str(k[f] || "", KB_MAX[f]));
    db.setSetting(KEY, out);
    return out;
  };
  const hasGlobal = () => KB_FIELDS.some((f) => getGlobal()[f]);

  const onboardingData = (clientId) => {
    if (!clientId) return {};
    const r = db.get("SELECT data FROM onboarding WHERE client_id = ?", clientId);
    return j(r?.data, {});
  };
  /* The campaign's own layer: the onboarding "knowledge" section plus the script field. */
  const campaignKB = (clientId) => {
    const k = onboardingData(clientId).knowledge || {};
    const o = k && typeof k === "object" && !Array.isArray(k) ? k : {};
    return { faqs: str(o.faqs || "", KB_MAX.faqs), objections: str(o.objections || "", KB_MAX.objections), caseStudies: str(o.caseStudies || "", KB_MAX.proof),
      policies: str(o.policies || "", KB_MAX.policies), reference: str(o.reference || "", KB_MAX.extra), script: str(o.script || "", KB_MAX.script) };
  };
  /* The approved company brain (interview output). */
  const brainOf = (clientId) => {
    const b = onboardingData(clientId).brain;
    return b && typeof b === "object" && !Array.isArray(b) ? b : {};
  };
  const brainBlock = (clientId) => {
    const b = brainOf(clientId);
    const rows = BRAIN_FIELDS.map((f) => (b[f] ? `${f}: ${noEmDash(str(b[f], BRAIN_MAX))}` : "")).filter(Boolean);
    return rows.join("\n");
  };
  const kbBlock = (clientId) => {
    const g = getGlobal(), c = clientId ? campaignKB(clientId) : null;
    const sec = (label, v) => (v && String(v).trim() ? `## ${label}\n${noEmDash(str(v, 8000).trim())}` : "");
    const gRows = [sec("Company overview (global)", g.overview), sec("FAQs (global)", g.faqs), sec("Pricing guidance (global)", g.pricing),
      sec("Objection notes (global)", g.objections), sec("Policies (global)", g.policies), sec("Proof and results (global)", g.proof),
      sec("Script (global)", g.script), sec("Extra notes (global)", g.extra)].filter(Boolean);
    const cRows = c ? [sec("Campaign FAQs", c.faqs), sec("Campaign objection notes", c.objections), sec("Campaign proof and case studies", c.caseStudies),
      sec("Campaign policies", c.policies), sec("Campaign reference", c.reference), sec("Campaign script", c.script)].filter(Boolean) : [];
    const body = [...gRows, ...cRows].join("\n\n");
    return body || "(none provided yet: never invent facts, pivot to the call instead)";
  };
  /* The two prompt blocks every drafting and review call gets. Pass a client row or a client id. */
  const contextBlocks = (client) => {
    const id = client && typeof client === "object" ? client.id : client;
    return { brainBlock: brainBlock(id), kbBlock: kbBlock(id) };
  };
  return { KB_FIELDS, BRAIN_FIELDS, ICP_FIELDS, empty, getGlobal, saveGlobal, hasGlobal, campaignKB, brainOf, brainBlock, kbBlock, contextBlocks };
}
module.exports = { createBrain, KB_FIELDS, BRAIN_FIELDS, ICP_FIELDS };
