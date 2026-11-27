/* The CRM layer: the lead pipeline (a deliberate, configurable lifecycle that stays distinct from the
   operational conversation `stage`), appointments, opportunities and per-lead tasks.
   `stage` (leads.stage) keeps driving the sending automation exactly as before; `pipeline` is the CRM view on top. */

const { now, DAY, j, str, num, clamp, HttpError } = require("./util");

/* The full pipeline, in order. `from` maps the operational stages onto it automatically for leads that
   never had an explicit pipeline value, so old data reads sensibly without a migration. */
const PIPELINE = [
  ["imported", "Imported", "off"],
  ["enrich_pending", "Enrichment Pending", "off"],
  ["under_review", "Under Review", "off"],
  ["qualified", "Qualified", "info"],
  ["ready", "Ready for Outreach", "info"],
  ["contacted", "Contacted", "info"],
  ["awaiting_reply", "Awaiting Reply", "off"],
  ["replied", "Replied", "warn"],
  ["interested", "Interested", "accent"],
  ["high_intent", "High Intent", "accent"],
  ["qualified_opportunity", "Qualified Opportunity", "accent"],
  ["booking_pending", "Booking Pending", "warn"],
  ["booked", "Booked", "good"],
  ["meeting_completed", "Meeting Completed", "good"],
  ["proposal", "Proposal / Offer", "warn"],
  ["won", "Won", "good"],
  ["lost", "Lost", "bad"],
  ["cold", "Cold", "off"],
  ["disqualified", "Disqualified", "bad"],
  ["do_not_contact", "Do Not Contact", "bad"]
];
const PIPE_IDS = PIPELINE.map(([k]) => k);
const PIPE_LABEL = Object.fromEntries(PIPELINE.map(([k, l]) => [k, l]));

/* The pipeline stage a lead sits in when it has never been set by hand. */
function derivePipeline(l) {
  if (l.pipeline && PIPE_IDS.includes(l.pipeline)) return l.pipeline;
  const s = l.stage;
  if (!l.client_id || l.review === "pending") return l.gate === "passed" ? "under_review" : l.gate === "rejected" ? "disqualified" : "imported";
  if (l.review === "rejected") return "disqualified";
  if (s === "new") return "ready";
  if (s === "contacted") return l.next_follow_at ? "awaiting_reply" : "contacted";
  if (s === "replied") return "replied";
  if (s === "interested") return "interested";
  if (s === "booked") return "booked";
  if (s === "customer") return "won";
  if (s === "cold") return "cold";
  if (s === "do_not_contact") return "do_not_contact";
  return "ready";
}

const APPT_STATUSES = ["booking_pending", "booked", "confirmed", "rescheduled", "completed", "cancelled", "no_show", "follow_up_required", "converted"];
const APPT_LABEL = { booking_pending: "Booking Pending", booked: "Booked", confirmed: "Confirmed", rescheduled: "Rescheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No-Show", follow_up_required: "Follow-Up Required", converted: "Converted" };
const OUTCOMES = ["won", "lost", "proposal_sent", "follow_up_required", "still_negotiating", "not_qualified", "no_decision"];
const OUTCOME_LABEL = { won: "Deal won", lost: "Deal lost", proposal_sent: "Proposal sent", follow_up_required: "Follow-up required", still_negotiating: "Still negotiating", not_qualified: "Not qualified", no_decision: "No decision" };
const OPP_STATUSES = ["open", "won", "lost"];

function createCrm(ctx) {
  const { db, bus, accounts } = ctx;

  const log = (l, level, text, kind = "crm") => {
    if (!l) return;
    db.run("INSERT INTO activity(at, lead_id, level, kind, text) VALUES(?,?,?,?,?)", now(), l.id, level, kind, str(text, 300));
    bus?.publish({ t: "activity", leadId: l.id, level, text });
  };
  const clientName = (id) => (db.get("SELECT name FROM clients WHERE id = ?", id) || {}).name || "";

  /* ---------- opportunities ---------- */
  const oppOut = (o) => ({ id: o.id, clientId: o.client_id, clientName: clientName(o.client_id), leadId: o.lead_id, lead: o.username ? { username: o.username, name: o.name } : null,
    value: o.value, status: o.status, wonReason: o.won_reason, lostReason: o.lost_reason, notes: o.notes, createdAt: o.created_at, updatedAt: o.updated_at, wonAt: o.won_at, lostAt: o.lost_at });
  const oppSql = `SELECT o.*, l.username, l.name FROM opportunities o LEFT JOIN leads l ON l.id = o.lead_id`;

  function createOpportunity({ clientId, leadId, value, notes } = {}) {
    let lead = null;
    if (leadId) {
      lead = db.get("SELECT * FROM leads WHERE id = ?", leadId);
      if (!lead) throw new HttpError(404, "Lead not found.");
      clientId = clientId ?? lead.client_id;
    }
    if (!clientId) throw new HttpError(400, "An opportunity needs a campaign.");
    const open = leadId ? db.get(`SELECT * FROM opportunities WHERE lead_id = ? AND status = 'open'`, leadId) : null;
    if (open) throw new HttpError(409, `This lead already has an open opportunity (#${open.id}).`);
    const t = now();
    const r = db.run("INSERT INTO opportunities(client_id, lead_id, value, notes, status, created_at, updated_at) VALUES(?,?,?,?, 'open', ?, ?)", clientId, leadId || null, Math.max(0, num(value, 0)), str(notes, 1000), t, t);
    if (lead) log(lead, "info", `Opportunity opened${num(value, 0) ? ` (${value.toLocaleString("en-US")} potential)` : ""}.`, "opportunity");
    return db.get(`${oppSql} WHERE o.id = ?`, r.id);
  }
  function updateOpportunity(id, b) {
    const o = db.get("SELECT * FROM opportunities WHERE id = ?", id);
    if (!o) throw new HttpError(404, "Opportunity not found.");
    const f = { updated_at: now() };
    if (b.value !== undefined) f.value = Math.max(0, num(b.value, 0));
    if (b.notes !== undefined) f.notes = str(b.notes, 1000);
    if (b.status !== undefined) {
      if (!OPP_STATUSES.includes(b.status)) throw new HttpError(400, "Opportunity status must be open, won or lost.");
      f.status = b.status;
      if (b.status === "won") { f.won_at = now(); f.lost_at = null; }
      if (b.status === "lost") { f.lost_at = now(); f.won_at = null; }
      if (b.status === "open") { f.won_at = null; f.lost_at = null; }
    }
    if (b.wonReason !== undefined) f.won_reason = str(b.wonReason, 300);
    if (b.lostReason !== undefined) f.lost_reason = str(b.lostReason, 300);
    db.run(`UPDATE opportunities SET ${Object.keys(f).map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...Object.values(f), id);
    const fresh = db.get(`${oppSql} WHERE o.id = ?`, id);
    if (b.status && o.status !== b.status && fresh.lead_id) {
      const l = db.get("SELECT * FROM leads WHERE id = ?", fresh.lead_id);
      if (l) {
        if (b.status === "won") { db.run("UPDATE leads SET stage = 'customer', pipeline = 'won' WHERE id = ?", l.id); log(l, "good", `Marked as won (${value_(o, b)}).`, "won"); }
        if (b.status === "lost") log(l, "info", `Opportunity marked lost${b.lostReason ? ": " + str(b.lostReason, 100) : ""}.`, "lost");
        if (b.status === "open") db.run("UPDATE leads SET pipeline = CASE WHEN stage = 'customer' THEN 'won' ELSE pipeline END WHERE id = ?", l.id);
        bus?.publish({ t: "lead", id: l.id });
      }
    }
    return fresh;
  }
  const value_ = (o, b) => (b?.value !== undefined ? Number(b.value) : o.value).toLocaleString("en-US");

  /* ---------- appointments ---------- */
  const apptOut = (a) => ({ ...a, clientName: clientName(a.client_id), lead: a.username ? { username: a.username, name: a.name } : null, outcomeLabel: OUTCOME_LABEL[a.outcome] || "" });
  const apptSql = `SELECT a.*, l.username, l.name FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id`;

  function createAppointment(b) {
    const lead = b.leadId ? db.get("SELECT * FROM leads WHERE id = ?", b.leadId) : null;
    const clientId = b.clientId ?? lead?.client_id;
    if (!clientId) throw new HttpError(400, "An appointment needs a campaign or a lead.");
    const at = b.scheduledAt ? num(b.scheduledAt, 0) : null;
    const status = APPT_STATUSES.includes(b.status) ? b.status : "booked";
    const t = now();
    const r = db.run(`INSERT INTO appointments(client_id, lead_id, title, scheduled_at, duration_min, tz, type, status, source, notes, value, outcome, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, clientId, lead?.id || null, str(b.title || (lead ? `Call with @${lead.username}` : "Appointment"), 160), at,
      clamp(Math.round(num(b.durationMin, 30)), 5, 480), str(b.tz, 60), ["call", "meeting", "on_site", "video"].includes(b.type) ? b.type : "call", status, str(b.source || "outreach", 40), str(b.notes, 1000), Math.max(0, num(b.value, 0)), OUTCOMES.includes(b.outcome) ? b.outcome : "", t, t);
    if (lead && status !== "cancelled") {
      const f = { pipeline: status === "booking_pending" ? "booking_pending" : "booked" };
      if (status === "booked" || status === "confirmed") { f.stage = "booked"; f.booked_at = t; }
      db.run(`UPDATE leads SET ${Object.keys(f).map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...Object.values(f), lead.id);
      log(lead, "good", `Appointment ${status === "booking_pending" ? "pending" : "booked"}${at ? " for " + new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}.`, "appointment");
      ctx.growth?.notify({ kind: "appointment_booked", priority: "good", title: "Appointment booked", body: `@${lead.username}${clientName(clientId) ? " · " + clientName(clientId) : ""}`, leadId: lead.id, clientId });
      for (const a of db.all("SELECT id FROM accounts WHERE client_id = ?", clientId)) bus?.bump(a.id);
    }
    return db.get(`${apptSql} WHERE a.id = ?`, r.id);
  }
  function updateAppointment(id, b) {
    const a = db.get("SELECT * FROM appointments WHERE id = ?", id);
    if (!a) throw new HttpError(404, "Appointment not found.");
    const f = { updated_at: now() };
    if (b.scheduledAt !== undefined) f.scheduled_at = b.scheduledAt ? num(b.scheduledAt, 0) : null;
    if (b.status !== undefined) { if (!APPT_STATUSES.includes(b.status)) throw new HttpError(400, "Unknown appointment status."); f.status = b.status; }
    if (b.outcome !== undefined) { if (b.outcome && !OUTCOMES.includes(b.outcome)) throw new HttpError(400, "Unknown appointment outcome."); f.outcome = b.outcome || ""; }
    if (b.value !== undefined) f.value = Math.max(0, num(b.value, 0));
    if (b.notes !== undefined) f.notes = str(b.notes, 1000);
    if (b.title !== undefined) f.title = str(b.title, 160);
    if (b.durationMin !== undefined) f.duration_min = clamp(Math.round(num(b.durationMin, 30)), 5, 480);
    if (b.type !== undefined && ["call", "meeting", "on_site", "video"].includes(b.type)) f.type = b.type;
    db.run(`UPDATE appointments SET ${Object.keys(f).map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...Object.values(f), id);
    const fresh = db.get(`${apptSql} WHERE a.id = ?`, id);
    if (fresh.lead_id) {
      const l = db.get("SELECT * FROM leads WHERE id = ?", fresh.lead_id);
      if (l) {
        if (f.status === "completed") db.run("UPDATE leads SET pipeline = 'meeting_completed' WHERE id = ? AND pipeline IN ('booked','booking_pending')", l.id);
        if (f.status === "no_show") log(l, "warn", "Missed the appointment (no-show). A recovery follow-up may be needed.", "appointment");
        if (f.status === "cancelled") log(l, "warn", "Appointment cancelled.", "appointment");
        if (f.outcome === "won") {
          const open = db.get("SELECT id FROM opportunities WHERE lead_id = ? AND status = 'open'", l.id);
          if (!open && !db.get("SELECT id FROM opportunities WHERE lead_id = ? AND status = 'won'", l.id)) createOpportunity({ clientId: fresh.client_id, leadId: l.id, value: fresh.value || undefined });
          if (open) updateOpportunity(open.id, { status: "won", value: fresh.value || undefined });
          db.run("UPDATE leads SET pipeline = 'won', stage = 'customer' WHERE id = ?", l.id);
        }
        if (f.outcome === "lost") log(l, "info", "Appointment outcome recorded: deal lost.", "appointment");
        bus?.publish({ t: "lead", id: l.id });
      }
    }
    bus?.publish({ t: "appointment", id });
    return fresh;
  }
  function listAppointments({ clientId, status, from, to, limit = 300 } = {}) {
    const w = [], p = [];
    if (clientId) { w.push("a.client_id = ?"); p.push(clientId); }
    if (status) { w.push("a.status = ?"); p.push(status); }
    if (from) { w.push("a.scheduled_at IS NOT NULL AND a.scheduled_at >= ?"); p.push(from); }
    if (to) { w.push("a.scheduled_at <= ?"); p.push(to); }
    const sql = `${apptSql} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY COALESCE(a.scheduled_at, a.created_at) DESC LIMIT ?`;
    const rows = db.all(sql, ...p, Math.min(1000, limit));
    const t = now();
    return {
      appointments: rows.map(apptOut),
      counts: {
        total: rows.length, upcoming: rows.filter((a) => a.scheduled_at && a.scheduled_at > t && ["booked", "confirmed", "rescheduled"].includes(a.status)).length,
        booked: rows.filter((a) => ["booked", "confirmed"].includes(a.status)).length, completed: rows.filter((a) => a.status === "completed").length,
        cancelled: rows.filter((a) => a.status === "cancelled").length, noShow: rows.filter((a) => a.status === "no_show").length,
        converted: rows.filter((a) => a.outcome === "won").length, bookingPending: rows.filter((a) => a.status === "booking_pending").length
      }
    };
  }
  function listOpportunities({ clientId, status, limit = 300 } = {}) {
    const w = [], p = [];
    if (clientId) { w.push("o.client_id = ?"); p.push(clientId); }
    if (status) { w.push("o.status = ?"); p.push(status); }
    const rows = db.all(`${oppSql} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY o.updated_at DESC LIMIT ?`, ...p, Math.min(1000, limit));
    const sum = (s) => rows.filter((r) => r.status === s).reduce((a, r) => a + (r.value || 0), 0);
    return { opportunities: rows.map(oppOut), totals: { pipeline: sum("open"), won: sum("won"), lost: sum("lost"), openCount: rows.filter((r) => r.status === "open").length, wonCount: rows.filter((r) => r.status === "won").length } };
  }

  /* ---------- lead tasks ---------- */
  const taskOut = (t) => ({ ...t, done: !!t.done, lead: t.username ? { username: t.username, name: t.name } : null });
  function listLeadTasks({ clientId, leadId, done, limit = 200 } = {}) {
    const w = [], p = [];
    if (leadId) { w.push("t.lead_id = ?"); p.push(leadId); }
    if (clientId) { w.push("t.client_id = ?"); p.push(clientId); }
    if (done !== undefined && done !== null && done !== "") { w.push("t.done = ?"); p.push(done ? 1 : 0); }
    return db.all(`SELECT t.*, l.username, l.name FROM lead_tasks t LEFT JOIN leads l ON l.id = t.lead_id ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY t.done, COALESCE(t.due_at, t.created_at) DESC LIMIT ?`, ...p, Math.min(500, limit)).map(taskOut);
  }
  function createLeadTask(b) {
    const lead = b.leadId ? db.get("SELECT * FROM leads WHERE id = ?", b.leadId) : null;
    if (!lead && !b.clientId) throw new HttpError(400, "A task needs a lead or a campaign.");
    if (!str(b.title, 200).trim()) throw new HttpError(400, "Write what the task is.");
    const t = now();
    const r = db.run("INSERT INTO lead_tasks(client_id, lead_id, title, due_at, priority, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
      b.clientId ?? lead?.client_id ?? null, lead?.id || null, str(b.title, 200), b.dueAt ? num(b.dueAt, 0) : null, ["low", "medium", "high"].includes(b.priority) ? b.priority : "medium", t, t);
    if (lead) log(lead, "info", `Task added: ${str(b.title, 80)}`, "task");
    return db.get(`SELECT t.*, l.username, l.name FROM lead_tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?`, r.id);
  }
  function updateLeadTask(id, b) {
    const t = db.get("SELECT * FROM lead_tasks WHERE id = ?", id);
    if (!t) throw new HttpError(404, "Task not found.");
    const f = { updated_at: now() };
    if (b.done !== undefined) { f.done = b.done ? 1 : 0; f.done_at = b.done ? now() : null; }
    if (b.title !== undefined) f.title = str(b.title, 200);
    if (b.dueAt !== undefined) f.due_at = b.dueAt ? num(b.dueAt, 0) : null;
    if (b.priority !== undefined && ["low", "medium", "high"].includes(b.priority)) f.priority = b.priority;
    db.run(`UPDATE lead_tasks SET ${Object.keys(f).map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...Object.values(f), id);
    return db.get(`SELECT t.*, l.username, l.name FROM lead_tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?`, id);
  }

  /* ---------- pipeline updates with side effects ---------- */
  function setPipeline(id, value, { by = "dashboard" } = {}) {
    const l = db.get("SELECT * FROM leads WHERE id = ?", id);
    if (!l) throw new HttpError(404, "Lead not found.");
    if (!PIPE_IDS.includes(value)) throw new HttpError(400, "Unknown pipeline stage.");
    const f = { pipeline: value };
    const back = { ready: "new", contacted: "contacted", awaiting_reply: "contacted", replied: "replied", interested: "interested", booked: "booked", won: "customer", do_not_contact: "do_not_contact", cold: "cold" };
    if (back[value] && ["ready", "contacted", "awaiting_reply", "replied", "interested", "booked", "won", "cold", "do_not_contact"].includes(value)) f.stage = back[value];
    if (value === "won") f.stage = "customer";
    if (value === "do_not_contact") f.no_followup = 1;
    db.run(`UPDATE leads SET ${Object.keys(f).map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`, ...Object.values(f), now(), id);
    log(l, "info", `Pipeline: ${PIPE_LABEL[derivePipeline(l)]} → ${PIPE_LABEL[value]} (${by}).`, "pipeline");
    if (value === "qualified_opportunity" && !db.get("SELECT id FROM opportunities WHERE lead_id = ? AND status = 'open'", id)) createOpportunity({ clientId: l.client_id, leadId: id });
    if (value === "won") {
      const open = db.get("SELECT id FROM opportunities WHERE lead_id = ? AND status = 'open'", id);
      if (open) updateOpportunity(open.id, { status: "won" });
      else if (!db.get("SELECT id FROM opportunities WHERE lead_id = ? AND status = 'won'", id)) { const o = createOpportunity({ clientId: l.client_id, leadId: id }); updateOpportunity(o.id, { status: "won" }); }
    }
    bus?.publish({ t: "lead", id });
    return db.get("SELECT * FROM leads WHERE id = ?", id);
  }

  return { PIPELINE, PIPE_IDS, PIPE_LABEL, derivePipeline, APPT_STATUSES, APPT_LABEL, OUTCOMES, OUTCOME_LABEL, OPP_STATUSES,
    createOpportunity, updateOpportunity, listOpportunities, createAppointment, updateAppointment, listAppointments, apptOut,
    listLeadTasks, createLeadTask, updateLeadTask, setPipeline };
}
module.exports = { createCrm, PIPELINE, PIPE_IDS, PIPE_LABEL, derivePipeline, APPT_STATUSES, APPT_LABEL, OUTCOMES, OUTCOME_LABEL };
