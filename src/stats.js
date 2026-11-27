/* Numbers for the dashboard: the overview digest, the qualification breakdown and the plain-text client report. */
const { now, DAY, j, clamp, num } = require("./util");

const ENTITY_TEXT = { COURSE_CREATOR: "Course or coaching seller", PERSONAL_OR_SPAM: "Personal or spam account", MARKETING_AGENCY: "Marketing agency", REAL_SERVICE_BUSINESS: "Real business outside the target" };

function createStats(ctx) {
  const { db } = ctx;
  const range = (days) => { const to = now(); return { from: to - clamp(Math.round(num(days, 7)), 1, 365) * DAY, to }; };
  const n = (sql, ...p) => (db.get(sql, ...p) || { n: 0 }).n || 0;

  function quality({ clientId, days = 7 } = {}) {
    const { from, to } = range(days), cw = clientId ? " AND client_id = ?" : "", cp = clientId ? [clientId] : [];
    const base = `FROM leads WHERE found_at >= ? AND found_at <= ?${cw}`, B = [from, to, ...cp];
    const imported = n(`SELECT COUNT(*) AS n ${base}`, ...B);
    const real = n(`SELECT COUNT(*) AS n ${base} AND entity_classification = 'REAL_BUSINESS'`, ...B);
    const agency = n(`SELECT COUNT(*) AS n ${base} AND entity_classification = 'AGENCY'`, ...B);
    const spam = n(`SELECT COUNT(*) AS n ${base} AND entity_classification = 'REJECT'`, ...B);
    const agencyRejected = n(`SELECT COUNT(*) AS n ${base} AND entity_classification = 'REJECT' AND entity_type = 'MARKETING_AGENCY'`, ...B);
    const gateRejected = n(`SELECT COUNT(*) AS n ${base} AND gate = 'rejected'`, ...B);
    const processing = n(`SELECT COUNT(*) AS n ${base} AND gate = ''`, ...B);
    const waiting = n(`SELECT COUNT(*) AS n ${base} AND gate = 'passed' AND entity_classification = ''`, ...B);
    const reasons = new Map();
    for (const r of db.all(`SELECT gate, entity_type, disqualification_reason AS why ${base} AND entity_classification = 'REJECT'`, ...B)) {
      const key = r.gate === "rejected" ? String(r.why || "No reason").split(";")[0].split(":")[0].slice(0, 60) : (ENTITY_TEXT[r.entity_type] || String(r.why || "Rejected by Haiku").slice(0, 60));
      const o = reasons.get(key) || { reason: key, count: 0, by: r.gate === "rejected" ? "pre-filter" : "haiku" }; o.count++; reasons.set(key, o);
    }
    const recent = db.all(`SELECT id, username, entity_classification AS cls, entity_type, confidence, detected_niche AS niche, service_location AS place, disqualification_reason AS why, gate, review, updated_at AS at ${base} AND gate != '' ORDER BY updated_at DESC LIMIT 40`, ...B);
    return { days: Math.round((to - from) / DAY), imported, real, agency, agencyRejected, spam, spamOnly: spam - agencyRejected, gateRejected, haikuRejected: Math.max(0, spam - gateRejected), processing, waiting,
      humanRejected: n(`SELECT COUNT(*) AS n ${base} AND review = 'rejected' AND entity_classification != 'REJECT'`, ...B),
      reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 10), recent,
      avgConfidence: Math.round((db.get(`SELECT AVG(confidence) AS a ${base} AND confidence IS NOT NULL`, ...B) || {}).a || 0) };
  }

  function digest({ clientId, days = 7 } = {}) {
    const { from, to } = range(days), cw = clientId ? " AND client_id = ?" : "", cp = clientId ? [clientId] : [], q = quality({ clientId, days });
    const base = `FROM leads WHERE found_at >= ? AND found_at <= ?${cw}`;
    const T = (type, extra = "") => n(`SELECT COUNT(*) AS n FROM tasks WHERE type = '${type}' AND status = 'done' AND result_code = 'sent' AND done_at >= ? AND done_at <= ?${clientId ? " AND client_id = ?" : ""}${extra}`, from, to, ...cp);
    /* the previous period of the same length, so the dashboard can show real deltas instead of guesses */
    const span = to - from, pf = from - span;
    const prev = {
      imported: n(`SELECT COUNT(*) AS n ${base}`, pf, from, ...cp),
      messagesSent: n(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'dm' AND status = 'done' AND result_code = 'sent' AND done_at >= ? AND done_at < ?${clientId ? " AND client_id = ?" : ""}`, pf, from, ...cp),
      replies: n(`SELECT COUNT(DISTINCT m.lead_id) AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.direction = 'in' AND m.ts * 1000 >= ? AND m.ts * 1000 < ?${clientId ? " AND l.client_id = ?" : ""}`, pf, from, ...cp),
      booked: n(`SELECT COUNT(*) AS n FROM leads WHERE booked_at >= ? AND booked_at < ?${cw}`, pf, from, ...cp)
    };
    const funnel = Object.fromEntries(db.all(`SELECT stage, COUNT(*) AS c FROM leads WHERE review = 'approved'${cw} GROUP BY stage`, ...cp).map((r) => [r.stage, r.c]));
    return { days: q.days, from, to, imported: q.imported, passed: q.real, agencies: q.agency, rejected: q.spam, processing: q.processing, prev,
      approved: n(`SELECT COUNT(*) AS n FROM leads WHERE review = 'approved' AND reviewed_at >= ? AND reviewed_at <= ?${cw}`, from, to, ...cp),
      pendingReview: n(`SELECT COUNT(*) AS n FROM leads WHERE review = 'pending' AND gate != ''${cw}`, ...cp),
      messagesSent: T("dm"), followupsSent: T("followup"), touches: T("touch"),
      sentToday: n(`SELECT COUNT(*) AS n FROM tasks WHERE type IN ('dm','followup') AND status = 'done' AND result_code = 'sent' AND done_at >= ?${clientId ? " AND client_id = ?" : ""}`, now() - 86400000, ...cp),
      replies: n(`SELECT COUNT(DISTINCT m.lead_id) AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.direction = 'in' AND m.ts * 1000 >= ? AND m.ts * 1000 <= ?${clientId ? " AND l.client_id = ?" : ""}`, from, to, ...cp),
      booked: n(`SELECT COUNT(*) AS n FROM leads WHERE booked_at >= ? AND booked_at <= ?${cw}`, from, to, ...cp),
      repliesWaiting: n(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'reply' AND status = 'draft'${clientId ? " AND client_id = ?" : ""}`, ...cp),
      funnel, topRejectReasons: q.reasons.slice(0, 6).map((r) => ({ reason: r.reason, count: r.count })) };
  }

  function report({ clientId, days = 7 }) {
    const client = clientId ? db.get("SELECT * FROM clients WHERE id = ?", clientId) : null, d = digest({ clientId, days });
    const line = (k, v) => `- ${k}: ${v}`;
    return [`# ${client ? client.name + ": " : ""}Last ${d.days} days`, "",
      "## Leads", line("Imported", d.imported), line("Real businesses", d.passed), line("Agencies kept separate", d.agencies), line("Filtered out", d.rejected), line("Approved to contact", d.approved), "",
      "## Conversations", line("First messages sent", d.messagesSent), line("Follow-ups sent", d.followupsSent), line("People who replied", d.replies), line("Calls booked", d.booked), "",
      "## Where things stand", ...Object.entries(d.funnel).map(([k, v]) => line(k.replace(/_/g, " "), v))].join("\n");
  }
  return { quality, digest, report };
}
module.exports = { createStats };
