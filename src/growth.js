/* The growth command center brain: missed-opportunity alerts, notifications, data-grounded insights,
   today's priorities, ROI & revenue attribution, client reports, onboarding and global search.
   Everything here is computed from real rows. Where data is missing the result says so instead of guessing. */

const { now, DAY, j, str, num, clamp, uid } = require("./util");
const { PIPELINE, PIPE_LABEL, derivePipeline, APPT_LABEL } = require("./crm");

function createGrowth(ctx) {
  const { db, bus, leads, accounts, crm, haiku, cfg } = ctx;

  const log = (l, level, text, kind = "growth") => {
    if (!l) return;
    db.run("INSERT INTO activity(at, lead_id, level, kind, text) VALUES(?,?,?,?,?)", now(), l.id, level, kind, str(text, 300));
    bus?.publish({ t: "activity", leadId: l.id, level, text });
  };
  const clientName = (id) => (db.get("SELECT name FROM clients WHERE id = ?", id) || {}).name || "";

  /* ================= notifications ================= */
  const NOTIF_KINDS = ["interested_prospect", "high_intent_reply", "unanswered_dm", "human_review", "ai_draft", "appointment_booked", "appointment_changed", "missed_appointment",
    "high_value_lead", "followup_overdue", "missed_opportunity", "campaign_issue", "sync_issue"];
  function notify({ kind, priority = "info", title, body = "", leadId, clientId }) {
    if (!NOTIF_KINDS.includes(kind)) return;
    db.run("INSERT INTO notifications(kind, priority, title, body, client_id, lead_id, created_at) VALUES(?,?,?,?,?,?,?)",
      kind, priority, str(title, 160), str(body, 300), clientId ?? null, leadId ?? null, now());
    bus?.publish({ t: "notification" });
  }
  function listNotifications({ unreadOnly, limit = 60 } = {}) {
    const rows = db.all(`SELECT * FROM notifications ${unreadOnly ? "WHERE read = 0" : ""} ORDER BY created_at DESC LIMIT ?`, Math.min(200, limit));
    return { notifications: rows.map((n) => ({ ...n, read: !!n.read })), unread: db.get("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").n };
  }
  const markRead = (b) => {
    if (b.all) db.run("UPDATE notifications SET read = 1, read_at = ? WHERE read = 0", now());
    else for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 200)) db.run("UPDATE notifications SET read = 1, read_at = ? WHERE id = ?", now(), id);
    bus?.publish({ t: "notification" });
    return listNotifications({});
  };

  /* ================= missed-opportunity alerts ================= */
  /* Recomputed on every read and every maintenance tick. An alert is inserted once per (kind, lead) while the
     condition holds (a unique partial index keeps duplicates out); resolving or snoozing keeps the operator's choice. */
  const ALERT_KINDS = ["interested_no_followup", "unanswered_dm", "high_value_inactive", "booking_abandoned", "appointment_outcome_overdue", "no_show_recovery",
    "followup_overdue", "opportunity_stalled", "campaign_underperforming", "sync_problem"];
  const P = { critical: 0, high: 1, medium: 2, low: 3 };
  function addAlert({ kind, priority = "medium", title, detail = "", leadId, clientId, appointmentId, meta = {} }) {
    const t = now();
    try {
      const r = db.run(`INSERT INTO alerts(kind, priority, client_id, lead_id, appointment_id, title, detail, meta, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?, 'open', ?, ?)`,
        kind, priority, clientId ?? null, leadId ?? null, appointmentId ?? null, str(title, 160), str(detail, 400), JSON.stringify(meta), t, t);
      const lead = leadId ? db.get("SELECT * FROM leads WHERE id = ?", leadId) : null;
      if (priority === "critical" || priority === "high") notify({ kind: "missed_opportunity", priority: priority === "critical" ? "bad" : "warn", title, body: detail.slice(0, 200), leadId, clientId });
      if (lead) log(lead, priority === "critical" ? "bad" : "warn", `Flagged: ${title}`, "alert");
      return r.id;
    } catch { return null; }   // the unique index: the same alert is already open
  }
  function autoResolve(kind, leadId) { db.run("UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE kind = ? AND lead_id = ? AND status IN ('open','in_progress')", now(), now(), kind, leadId); }

  function recomputeAlerts() {
    const t = now();
    /* interested prospects with no reply from us for over 24h */
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND (pipeline = 'interested' OR pipeline = 'high_intent' OR stage = 'interested') AND no_followup = 0 AND needs_human = 0
        AND id NOT IN (SELECT lead_id FROM tasks WHERE type = 'reply' AND status IN ('pending','draft') AND lead_id IS NOT NULL)
        AND COALESCE(last_inbound_ts, last_activity_at, updated_at) > 0 AND COALESCE(last_inbound_ts, last_activity_at, updated_at) < ?`, t - 24 * 3600_000)) {
      const wait = Math.floor((t - (l.last_inbound_ts || l.last_activity_at || l.updated_at)) / 3600_000);
      addAlert({ kind: "interested_no_followup", priority: wait > 72 ? "critical" : wait > 48 ? "high" : "medium", title: `Interested prospect waiting for a follow-up`,
        detail: `@${l.username} showed interest but has heard nothing for ${wait}h.`, leadId: l.id, clientId: l.client_id, meta: { waitHours: wait } });
    }
    /* inbound DMs waiting for a response (needs_human or a draft) for over 12h */
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND last_inbound_ts > 0 AND last_inbound_ts < ? AND no_followup = 0 AND stage NOT IN ('cold','do_not_contact','customer','booked')
        AND (needs_human = 1 OR id IN (SELECT lead_id FROM tasks WHERE type = 'reply' AND status = 'draft' AND lead_id IS NOT NULL))`, t - 12 * 3600_000)) {
      const wait = Math.floor((t - l.last_inbound_ts) / 3600_000);
      addAlert({ kind: "unanswered_dm", priority: wait > 48 ? "high" : "medium", title: `Inbound DM waiting for a response`,
        detail: `@${l.username} replied ${wait}h ago${l.needs_human ? " and needs a human answer" : "; a draft is waiting for approval"}.`, leadId: l.id, clientId: l.client_id, meta: { waitHours: wait } });
    }
    /* high-scoring leads going quiet */
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND score >= 75 AND no_followup = 0 AND stage NOT IN ('booked','customer','do_not_contact')
        AND COALESCE(last_activity_at, updated_at) < ?`, t - 10 * DAY)) {
      addAlert({ kind: "high_value_inactive", priority: "medium", title: `High-scoring lead going inactive`,
        detail: `@${l.username} scored ${l.score} but has had no activity for over 10 days.`, leadId: l.id, clientId: l.client_id });
    }
    /* booking abandonment: interested/opportunity leads with no next step for 5+ days */
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND pipeline IN ('interested','high_intent','qualified_opportunity','booking_pending') AND no_followup = 0 AND needs_human = 0 AND updated_at < ?`, t - 5 * DAY)) {
      addAlert({ kind: "booking_abandoned", priority: "high", title: `Booking went quiet`, detail: `@${l.username} was moving toward a booking (${PIPE_LABEL[l.pipeline] || l.pipeline}) but nothing has happened for 5+ days.`, leadId: l.id, clientId: l.client_id });
    }
    /* completed appointments with no outcome */
    for (const a of db.all(`SELECT a.*, l.username FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.status = 'completed' AND a.outcome = '' AND a.scheduled_at < ?`, t - 3 * DAY)) {
      addAlert({ kind: "appointment_outcome_overdue", priority: "medium", title: `Appointment outcome not recorded`, detail: `The meeting with @${a.username || "this lead"} completed ${Math.floor((t - a.scheduled_at) / DAY)} days ago; record whether it became a deal.`, leadId: a.lead_id, clientId: a.client_id, appointmentId: a.id });
    }
    /* no-show recovery */
    for (const a of db.all(`SELECT a.*, l.username FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.status = 'no_show' AND a.scheduled_at < ? AND a.outcome = ''`, t - 1 * DAY)) {
      addAlert({ kind: "no_show_recovery", priority: "medium", title: `No-show needs a recovery follow-up`, detail: `@${a.username || "This lead"} missed the appointment; a short follow-up can still recover it.`, leadId: a.lead_id, clientId: a.client_id, appointmentId: a.id });
    }
    /* follow-up overdue */
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND next_follow_at IS NOT NULL AND next_follow_at < ? AND no_followup = 0 AND stage NOT IN ('cold','do_not_contact','customer','booked')`, t - 6 * 3600_000)) {
      const late = Math.floor((t - l.next_follow_at) / DAY);
      addAlert({ kind: "followup_overdue", priority: late >= 3 ? "high" : "medium", title: `Follow-up overdue`, detail: `@${l.username} was due a follow-up ${late} day${late === 1 ? "" : "s"} ago.`, leadId: l.id, clientId: l.client_id, meta: { lateDays: late } });
    }
    /* stalled opportunities */
    for (const o of db.all(`SELECT o.*, l.username FROM opportunities o LEFT JOIN leads l ON l.id = o.lead_id WHERE o.status = 'open' AND o.updated_at < ?`, t - 14 * DAY)) {
      addAlert({ kind: "opportunity_stalled", priority: "low", title: `Opportunity has not moved in two weeks`, detail: `The opportunity with @${o.username || "this lead"} (${(o.value || 0).toLocaleString("en-US")} potential) has been open and untouched for 14+ days.`, leadId: o.lead_id, clientId: o.client_id });
    }
    /* campaign underperformance: 30+ contacted, replies but zero appointments in 14 days */
    for (const c of db.all("SELECT * FROM clients WHERE active = 1")) {
      const sent = db.get(`SELECT COUNT(DISTINCT l.id) AS n FROM leads l WHERE l.client_id = ? AND l.stage IN ('contacted','replied','interested','booked')`, c.id).n;
      const replied = db.get(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND last_inbound_ts > 0`, c.id).n;
      const booked = db.get(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND booked_at > 0`, c.id).n;
      if (sent >= 30 && replied >= 5 && booked === 0) addAlert({ kind: "campaign_underperforming", priority: "medium", title: `${c.name}: replies are not becoming bookings`, detail: `${replied} people replied across ${sent} contacted leads, but no appointment has been booked yet. Check the offer and the booking link.`, clientId: c.id, meta: { sent, replied } });
    }
    /* stale leads blocked on the AI */
    if (!haiku.enabled()) {
      const stuck = db.get(`SELECT COUNT(*) AS n FROM leads WHERE gate = 'passed' AND entity_classification = ''`).n;
      if (stuck) addAlert({ kind: "sync_problem", priority: "high", title: `${stuck} lead${stuck === 1 ? "" : "s"} cannot be checked`, detail: "The AI checker is not connected (no ANTHROPIC_API_KEY), so leads that passed the pre-filter are waiting.", clientId: null });
    }
    /* opportunities recovered automatically when a follow-up finally happens */
    for (const l of db.all(`SELECT id FROM leads WHERE last_activity_at > ? AND stage = 'booked'`, t - DAY)) autoResolve("booking_abandoned", l.id);
    db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE kind = 'unanswered_dm' AND status IN ('open','in_progress') AND lead_id IN (SELECT id FROM leads WHERE last_activity_at > ?)`, t, t, t - 3600_000);
    db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE kind = 'followup_overdue' AND status IN ('open','in_progress') AND lead_id NOT IN (SELECT id FROM leads WHERE next_follow_at IS NOT NULL AND next_follow_at < ? AND no_followup = 0 AND stage NOT IN ('cold','do_not_contact','customer','booked'))`, t, t, t);
    db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE kind IN ('appointment_outcome_overdue','no_show_recovery') AND status IN ('open','in_progress') AND appointment_id IN (SELECT id FROM appointments WHERE outcome != '' OR status IN ('cancelled','converted'))`, t, t);
    if (haiku.enabled()) db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE kind = 'sync_problem' AND status = 'open'`, t, t);
  }

  function listAlerts({ status = "open", clientId } = {}) {
    recomputeAlerts();
    const rows = db.all(`SELECT al.*, l.username, l.score AS lead_score FROM alerts al LEFT JOIN leads l ON l.id = al.lead_id ${status === "all" ? "" : "WHERE al.status = ?"} ORDER BY al.updated_at DESC LIMIT 400`, ...(status === "all" ? [] : [status]));
    const list = rows.filter((r) => !clientId || r.client_id === +clientId || r.client_id == null).map((a) => ({ id: a.id, kind: a.kind, priority: a.priority, title: a.title, detail: a.detail, leadId: a.lead_id, username: a.username, clientId: a.client_id, clientName: clientName(a.client_id), appointmentId: a.appointment_id, leadScore: a.lead_score, status: a.status, snoozeUntil: a.snooze_until, createdAt: a.created_at, updatedAt: a.updated_at, resolvedAt: a.resolved_at, meta: j(a.meta, {}) }));
    const sections = [
      ["critical", list.filter((a) => a.priority === "critical")], ["high", list.filter((a) => a.priority === "high")],
      ["medium", list.filter((a) => a.priority === "medium")], ["low", list.filter((a) => a.priority === "low")]
    ];
    const byKind = {};
    for (const a of list) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
    const resolved = db.all(`SELECT COUNT(*) AS n, kind FROM alerts WHERE status = 'resolved' GROUP BY kind`);
    const totalResolved = db.get("SELECT COUNT(*) AS n FROM alerts WHERE status = 'resolved'").n;
    const avgResolution = db.get("SELECT AVG(resolved_at - created_at) AS a FROM alerts WHERE status = 'resolved' AND resolved_at IS NOT NULL").a;
    return { alerts: list, sections, byKind, resolved: totalResolved, byKindResolved: Object.fromEntries(resolved.map((r) => [r.kind, r.n])), avgResolutionHours: avgResolution ? Math.round(avgResolution / 3600_000) : null };
  }
  function setAlert(id, b) {
    const a = db.get("SELECT * FROM alerts WHERE id = ?", id);
    if (!a) throw new HttpError(404, "Alert not found.");
    const f = { updated_at: now() };
    if (b.status && ["open", "in_progress", "resolved", "snoozed"].includes(b.status)) {
      f.status = b.status;
      if (b.status === "resolved") f.resolved_at = now();
      if (b.status === "snoozed") f.snooze_until = now() + clamp(num(b.hours, 24), 1, 336) * 3600_000;
      if (b.status === "open") { f.snooze_until = null; f.resolved_at = null; }
    }
    db.run(`UPDATE alerts SET ${Object.keys(f).map((k) => k + " = ?").join(", ")} WHERE id = ?`, ...Object.values(f), id);
    return { ok: true };
  }

  /* ================= priorities (what needs attention today) ================= */
  function priorities({ clientId } = {}) {
    const t = now(), cw = clientId ? " AND client_id = ?" : "", cp = clientId ? [clientId] : [], out = [];
    const item = (kind, priority, title, why, leadId, username, to, meta = {}) => out.push({ kind, priority, title, why, leadId, username, to, ...meta });
    for (const l of db.all(`SELECT * FROM leads WHERE needs_human = 1 AND review = 'approved'${cw} ORDER BY updated_at DESC LIMIT 8`, ...cp))
      item("human_review", "critical", `@${l.username} needs a person`, "The conversation hit something the AI should not answer alone.", l.id, l.username, "#/inbox");
    for (const r of db.all(`SELECT t.id, t.lead_id, l.username, l.score FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.type = 'reply' AND t.status = 'draft'${clientId ? " AND t.client_id = ?" : ""} ORDER BY t.created_at LIMIT 8`, ...cp))
      item("ai_draft", "high", `Approve the draft to @${r.username}`, "A reply draft is waiting for approval.", r.lead_id, r.username, "#/inbox", { taskId: r.id });
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND last_inbound_ts > 0 AND no_followup = 0 AND stage IN ('replied','interested','contacted') AND last_inbound_ts < ?${cw} ORDER BY last_inbound_ts LIMIT 8`, t - 24 * 3600_000, ...cp))
      item("unanswered_dm", "high", `@${l.username} replied ${Math.floor((t - l.last_inbound_ts) / 3600_000)}h ago`, "Inbound message waiting for a response.", l.id, l.username, "#/inbox");
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND score >= 75 AND stage = 'ready' AND no_followup = 0${cw} ORDER BY score DESC LIMIT 6`, ...cp))
      item("high_score_uncontacted", "medium", `@${l.username} is a strong lead nobody contacted`, `Scored ${l.score}/100 and still waiting for the first message.`, l.id, l.username, "#/leads");
    for (const l of db.all(`SELECT * FROM leads WHERE review = 'approved' AND next_follow_at IS NOT NULL AND next_follow_at < ? AND no_followup = 0 AND stage NOT IN ('cold','do_not_contact','customer','booked')${cw} ORDER BY next_follow_at LIMIT 8`, t, ...cp))
      item("followup_overdue", "high", `Follow-up overdue to @${l.username}`, `Due ${Math.floor((t - l.next_follow_at) / DAY)} day(s) ago.`, l.id, l.username, "#/pipeline");
    const pending = db.get(`SELECT COUNT(*) AS n FROM leads WHERE review = 'pending' AND gate != ''${cw}`, ...cp).n;
    if (pending) item("review_queue", "medium", `${pending} lead${pending === 1 ? "" : "s"} waiting for review`, "They passed the checks and need a yes or no.", null, "", "#/review", { count: pending });
    const hold = db.get(`SELECT COUNT(*) AS n FROM supervisor_log WHERE status = 'held'`).n;
    if (hold) item("supervisor", "high", `${hold} message${hold === 1 ? "" : "s"} held by the AI supervisor`, "Review and release them.", null, "", "#/supervisor", { count: hold });
    const bp = db.get(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'booking_pending'${cw}`, ...cp).n;
    if (bp) item("booking_pending", "medium", `${bp} booking${bp === 1 ? "" : "s"} not confirmed yet`, "Interested prospects that have not completed scheduling.", null, "", "#/appointments", { count: bp });
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    out.sort((a, b) => order[a.priority] - order[b.priority]);
    return { priorities: out.slice(0, 20), counts: out.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}) };
  }

  /* ================= insights (observations, not commentary) ================= */
  function insights({ clientId, days = 7 } = {}) {
    const from = now() - days * DAY, out = [];
    const cw = clientId ? " AND client_id = ?" : "", cp = clientId ? [clientId] : [];
    for (const c of (clientId ? db.all("SELECT * FROM clients WHERE id = ?", clientId) : db.all("SELECT * FROM clients WHERE active = 1"))) {
      const lid = [c.id];
      const sent = db.get(`SELECT COUNT(*) AS n FROM tasks WHERE client_id = ? AND type = 'dm' AND status = 'done' AND result_code = 'sent' AND done_at >= ?`, ...lid, from).n;
      const replied = db.get(`SELECT COUNT(DISTINCT l.id) AS n FROM leads l WHERE l.client_id = ? AND l.last_inbound_ts * 1000 >= ?`, ...lid, from).n;
      const interested = db.get(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND (stage = 'interested' OR pipeline = 'interested') AND updated_at >= ?`, ...lid, from).n;
      const booked = db.get(`SELECT COUNT(*) AS n FROM appointments WHERE client_id = ? AND created_at >= ? AND status != 'cancelled'`, ...lid, from).n;
      if (sent >= 10) {
        if (replied / sent < 0.05) out.push({ clientId: c.id, severity: "warn", text: `${c.name}: ${replied} of ${sent} first messages got a reply (${Math.round((replied / sent) * 100)}%). That is a low reply rate — the opener or the targeting may need a look.` });
        else if (interested >= 1 && booked === 0 && interested >= Math.max(2, replied * 0.3)) out.push({ clientId: c.id, severity: "warn", text: `${c.name}: ${interested} interested prospects but no appointment booked in this period. The booking link or follow-up step may be the blocker.` });
        else if (booked >= 1 && replied) out.push({ clientId: c.id, severity: "good", text: `${c.name}: ${booked} appointment${booked === 1 ? "" : "s"} booked from ${replied} replies (${Math.round((booked / replied) * 100)}% of repliers).` });
      }
      const bestSource = db.get(`SELECT source_type, COUNT(*) AS n, SUM(CASE WHEN last_inbound_ts > 0 THEN 1.0 ELSE 0 END) AS r FROM leads WHERE client_id = ? AND found_at >= ? GROUP BY source_type ORDER BY (SUM(CASE WHEN last_inbound_ts > 0 THEN 1.0 ELSE 0 END) / COUNT(*)) DESC LIMIT 1`, ...lid, from);
      if (bestSource && bestSource.n >= 5) out.push({ clientId: c.id, severity: "info", text: `${c.name}: ${bestSource.source_type === "meta_ad_library" ? "Ad Library leads" : "Instagram profile leads"} reply most often (${bestSource.r}/${bestSource.n} replied). Consider weighting imports toward that source.` });
      const slow = db.get(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND last_inbound_ts > 0 AND last_inbound_ts < ? AND stage IN ('replied','interested')`, ...lid, now() - 24 * 3600_000).n;
      if (slow >= 2) out.push({ clientId: c.id, severity: "warn", text: `${c.name}: ${slow} conversation${slow === 1 ? "" : "s"} have been waiting more than a day for a response. Reply speed drops booking chances.` });
      const niche = db.get(`SELECT detected_niche AS n2, COUNT(*) AS n, AVG(score) AS s FROM leads WHERE client_id = ? AND score IS NOT NULL AND detected_niche != '' GROUP BY detected_niche HAVING COUNT(*) >= 4 ORDER BY s DESC LIMIT 1`, ...lid);
      if (niche && niche.n >= 4) out.push({ clientId: c.id, severity: "info", text: `${c.name}: the "${niche.n2}" segment scores highest on average (${Math.round(niche.s)}/100 across ${niche.n} leads).` });
    }
    const highValue = db.get(`SELECT COUNT(*) AS n FROM leads WHERE review = 'approved' AND score >= 85 AND stage = 'ready'${cw}`, ...cp).n;
    if (highValue) out.push({ severity: "info", text: `${highValue} lead${highValue === 1 ? " scores" : "s score"} 85+ and has not been contacted yet. These are the strongest opportunities in the queue.` });
    const prev = db.get(`SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ? AND created_at < ?${cw}`, now() - 2 * days * DAY, from, ...cp).n;
    const cur = db.get(`SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ?${cw}`, from, ...cp).n;
    if (prev > 0 && cur !== prev) out.push({ severity: cur > prev ? "good" : "warn", text: `Appointments ${cur > prev ? "increased" : "decreased"} from ${prev} to ${cur} versus the previous period.` });
    return { insights: out, note: "Every observation here is computed from rows in your workspace. Small samples are not turned into percentages." };
  }

  /* ================= ROI & revenue attribution ================= */
  function roi({ clientId, days = 30 } = {}) {
    const from = now() - days * DAY;
    const cw = clientId ? " AND client_id = ?" : "", cp = clientId ? [clientId] : [];
    const funnel = {
      leads: db.get(`SELECT COUNT(*) AS n FROM leads WHERE found_at >= ?${cw}`, from, ...cp).n,
      qualified: db.get(`SELECT COUNT(*) AS n FROM leads WHERE found_at >= ? AND entity_classification IN ('REAL_BUSINESS','AGENCY')${cw}`, from, ...cp).n,
      contacted: db.get(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'dm' AND status = 'done' AND result_code = 'sent' AND done_at >= ?${clientId ? " AND client_id = ?" : ""}`, from, ...cp).n,
      replied: db.get(`SELECT COUNT(DISTINCT l.id) AS n FROM leads l WHERE l.last_inbound_ts * 1000 >= ?${cw}`, from, ...cp).n,
      interested: db.get(`SELECT COUNT(*) AS n FROM leads WHERE updated_at >= ? AND (stage = 'interested' OR pipeline IN ('interested','high_intent'))${cw}`, from, ...cp).n,
      opportunities: db.get(`SELECT COUNT(*) AS n FROM opportunities WHERE created_at >= ?${cw}`, from, ...cp).n,
      appointments: db.get(`SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ? AND status != 'cancelled'${cw}`, from, ...cp).n,
      completed: db.get(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'completed' AND updated_at >= ?${cw}`, from, ...cp).n,
      won: db.get(`SELECT COUNT(*) AS n FROM opportunities WHERE won_at >= ?${cw}`, from, ...cp).n
    };
    const revenue = db.get(`SELECT COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status = 'won' AND won_at >= ?${cw}`, from, ...cp).v;
    const wonTotal = db.get(`SELECT COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status = 'won'${cw}`, ...cp).v;
    const pipeline = db.get(`SELECT COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status = 'open'${cw}`, ...cp).v;
    const bookedValue = db.get(`SELECT COALESCE(SUM(a.value), 0) AS v FROM appointments a WHERE a.value > 0 AND a.status NOT IN ('cancelled','no_show')${cw}`, ...cp).v;
    const investment = clientId ? (db.get("SELECT COALESCE(monthly_cost, 0) AS m FROM clients WHERE id = ?", clientId).m || 0) * (days / 30) : db.get("SELECT COALESCE(SUM(monthly_cost), 0) AS m FROM clients").m * (days / 30);
    const over = (a, b) => (b ? Math.round((a / b) * 100) : null);
    const conversion = { leadToQualified: over(funnel.qualified, funnel.leads), contactedRate: over(funnel.contacted, funnel.qualified), replyRate: over(funnel.replied, funnel.contacted), interestedRate: over(funnel.interested, funnel.replied), bookRate: over(funnel.appointments, funnel.interested), winRate: over(funnel.won, funnel.appointments || 0) };
    const perCampaign = db.all(`SELECT c.id, c.name, c.monthly_cost, (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.found_at >= ?) AS leads, (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.created_at >= ? AND a.status != 'cancelled') AS appointments, (SELECT COALESCE(SUM(o.value), 0) FROM opportunities o WHERE o.client_id = c.id AND o.status = 'won' AND o.won_at >= ?) AS revenue, (SELECT COALESCE(SUM(o.value), 0) FROM opportunities o WHERE o.client_id = c.id AND o.status = 'open') AS pipeline FROM clients c ${clientId ? "WHERE c.id = ?" : "WHERE c.active = 1"} ORDER BY revenue DESC`, from, from, from, ...(clientId ? [clientId] : []));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d0 = now() - (i + 1) * DAY, d1 = now() - i * DAY;
      series.push({ at: d1, leads: db.get(`SELECT COUNT(*) AS n FROM leads WHERE found_at >= ? AND found_at < ?${cw}`, d0, d1, ...cp).n,
        appointments: db.get(`SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'${cw}`, d0, d1, ...cp).n,
        revenue: db.get(`SELECT COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status = 'won' AND won_at >= ? AND won_at < ?${cw}`, d0, d1, ...cp).v });
    }
    return { days, funnel, revenue: { won: revenue, wonTotal, pipeline, bookedValue, note: pipeline || bookedValue ? "Pipeline and booked values are estimates, not money earned." : "" },
      investment: Math.round(investment * 100) / 100, roi: investment > 0 && revenue > 0 ? Math.round(((revenue - investment) / investment) * 100) : null,
      roiAvailable: investment > 0, conversion, perCampaign, series, costPerLead: funnel.leads && investment ? Math.round((investment / funnel.leads) * 100) / 100 : null,
      costPerAppointment: funnel.appointments && investment ? Math.round((investment / funnel.appointments) * 100) / 100 : null,
      revenuePerAppointment: funnel.appointments ? Math.round((revenue / funnel.appointments) * 100) / 100 : null };
  }

  /* ================= reports ================= */
  function report({ clientId, days = 7 }) {
    const c = clientId ? db.get("SELECT * FROM clients WHERE id = ?", clientId) : null;
    const from = now() - days * DAY;
    const cw = c ? " AND client_id = ?" : "", cp = c ? [c.id] : [];
    const g = (sql, ...p) => (db.get(sql, ...p) || { n: 0 }).n || 0;
    const leads = g(`SELECT COUNT(*) AS n FROM leads WHERE found_at >= ?${cw}`, from, ...cp);
    const qualified = g(`SELECT COUNT(*) AS n FROM leads WHERE found_at >= ? AND entity_classification IN ('REAL_BUSINESS','AGENCY')${cw}`, from, ...cp);
    const sent = g(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'dm' AND status = 'done' AND result_code = 'sent' AND done_at >= ?${clientId ? " AND client_id = ?" : ""}`, from, ...cp);
    const followups = g(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'followup' AND status = 'done' AND result_code = 'sent' AND done_at >= ?${clientId ? " AND client_id = ?" : ""}`, from, ...cp);
    const replied = g(`SELECT COUNT(DISTINCT l.id) AS n FROM leads l WHERE l.last_inbound_ts * 1000 >= ?${cw}`, from, ...cp);
    const interested = g(`SELECT COUNT(*) AS n FROM leads WHERE updated_at >= ? AND (stage = 'interested' OR pipeline IN ('interested','high_intent'))${cw}`, from, ...cp);
    const appts = g(`SELECT COUNT(*) AS n FROM appointments WHERE created_at >= ? AND status != 'cancelled'${cw}`, from, ...cp);
    const completed = g(`SELECT COUNT(*) AS n FROM appointments WHERE status = 'completed' AND updated_at >= ?${cw}`, from, ...cp);
    const wonCount = g(`SELECT COUNT(*) AS n FROM opportunities WHERE won_at >= ?${cw}`, from, ...cp);
    const wonRevenue = db.get(`SELECT COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status = 'won' AND won_at >= ?${cw}`, from, ...cp).v;
    const pipeline = db.get(`SELECT COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status = 'open'${cw}`, ...cp).v;
    const alerts = db.get(`SELECT COUNT(*) AS n FROM alerts WHERE created_at >= ? AND status = 'open'${c && c.id ? " AND client_id = ?" : ""}`, from, ...(c ? [c.id] : [])).n;
    const recovered = db.get(`SELECT COUNT(*) AS n FROM alerts WHERE resolved_at >= ?${c && c.id ? " AND client_id = ?" : ""}`, from, ...(c ? [c.id] : [])).n;
    const pct_ = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
    const narrative = [];
    if (leads) narrative.push(`${leads} lead${leads === 1 ? " was" : "s were"} sourced${qualified ? `, ${qualified} passed qualification (${pct_(qualified, leads)})` : ""} in the last ${days} day${days === 1 ? "" : "s"}.`);
    if (sent) narrative.push(`${sent} first message${sent === 1 ? "" : "s"} and ${followups} follow-up${followups === 1 ? "" : "s"} went out.`);
    if (replied) narrative.push(`${replied} ${replied === 1 ? "person replied" : "people replied"} (${pct_(replied, sent)} of messages).`);
    if (interested) narrative.push(`${interested} ${interested === 1 ? "prospect is" : "prospects are"} interested.`);
    if (appts || completed) narrative.push(`${appts} appointment${appts === 1 ? "" : "s"} booked, ${completed} completed.`);
    if (wonCount) narrative.push(`${wonCount} deal${wonCount === 1 ? "" : "s"} won${wonRevenue ? `, ${Number(wonRevenue).toLocaleString("en-US")} attributed` : ""}.`);
    else if (pipeline) narrative.push(`No closed deals yet; ${Number(pipeline).toLocaleString("en-US")} of open pipeline is waiting.`);
    if (alerts) narrative.push(`${alerts} opportunit${alerts === 1 ? "y is" : "ies are"} currently flagged as needing attention (${recovered} were resolved this period).`);
    if (!narrative.length) narrative.push(`Almost nothing happened in this period yet — no leads, messages or bookings recorded.`);
    const json = { period: { days, from, to: now(), client: c ? c.name : "All campaigns" }, numbers: { leads, qualified, messagesSent: sent, followupsSent: followups, replies: replied, interested, appointments: appts, appointmentsCompleted: completed, dealsWon: wonCount, revenueAttributed: wonRevenue, openPipeline: pipeline, openAlerts: alerts, alertsResolved: recovered }, narrative };
    const text = [`# ${c ? c.name + ": " : "Workspace: "}last ${days} days`, "", ...narrative.map((n) => "- " + n), "",
      "## Numbers", `- Leads sourced: ${leads}`, `- Qualified: ${qualified}`, `- Messages sent: ${sent}`, `- Follow-ups sent: ${followups}`, `- Replies: ${replied}`, `- Interested: ${interested}`,
      `- Appointments booked: ${appts}`, `- Appointments completed: ${completed}`, `- Deals won: ${wonCount}`, `- Revenue attributed: ${Number(wonRevenue).toLocaleString("en-US")}`,
      `- Open pipeline: ${Number(pipeline).toLocaleString("en-US")} (estimate, not earned)`, `- Open opportunities flagged: ${alerts}`, `- Flagged and resolved this period: ${recovered}`].join("\n");
    return { ...json, __text: text };
  }

  /* ================= onboarding ================= */
  /* "interview" holds the 8-question AI interview state, "brain" the approved company brain. */
  const SECTIONS = ["business", "offer", "icp", "qualification", "goals", "outreach", "conversation", "appointments", "campaign", "knowledge", "interview", "brain"];
  function onboardingOut(r) {
    const d = j(r.data, {});
    const filled = SECTIONS.filter((s) => d[s] && Object.keys(d[s]).length).length;
    return { clientId: r.client_id, step: r.step, data: d, completed: !!r.completed, completedAt: r.completed_at, updatedAt: r.updated_at,
      sectionsDone: filled, sectionsTotal: SECTIONS.length, percent: Math.round((filled / SECTIONS.length) * 100) };
  }
  const getOnboarding = (clientId) => db.get("SELECT * FROM onboarding WHERE client_id = ?", clientId);
  function saveOnboarding(clientId, b) {
    const c = db.get("SELECT * FROM clients WHERE id = ?", clientId);
    if (!c) throw new HttpError(404, "Campaign not found.");
    const cur = getOnboarding(clientId), t = now();
    const data = cur ? j(cur.data, {}) : {};
    for (const s of SECTIONS) if (b[s] !== undefined) data[s] = b[s] && typeof b[s] === "object" && !Array.isArray(b[s]) ? b[s] : {};
    const step = b.step !== undefined ? clamp(Math.round(num(b.step, 0)), 0, 20) : cur?.step ?? 0;
    if (cur) db.run("UPDATE onboarding SET data = ?, step = ?, updated_at = ? WHERE client_id = ?", JSON.stringify(data), step, t, clientId);
    else db.run("INSERT INTO onboarding(client_id, data, step, created_at, updated_at) VALUES(?,?,?,?,?)", clientId, JSON.stringify(data), step, t, t);
    return onboardingOut(getOnboarding(clientId));
  }
  function completeOnboarding(clientId) {
    const cur = getOnboarding(clientId);
    if (!cur) throw new HttpError(400, "Nothing to complete yet — save at least one section first.");
    db.run("UPDATE onboarding SET completed = 1, completed_at = ?, updated_at = ? WHERE client_id = ?", now(), now(), clientId);
    log(null, "good", `Onboarding completed for ${clientName(clientId)}.`, "onboarding");
    return onboardingOut(getOnboarding(clientId));
  }

  /* ================= global search ================= */
  function search(qs, { limit = 8 } = {}) {
    const q = str(qs, 80).trim().replace(/^@/, "");
    if (!q) return { results: [] };
    const like = `%${q.replace(/[%_]/g, "")}%`, out = [];
    for (const l of db.all(`SELECT id, username, name, stage, pipeline, score, detected_niche FROM leads WHERE username ILIKE ? OR name ILIKE ? OR detected_niche ILIKE ? OR bio ILIKE ? ORDER BY updated_at DESC LIMIT ?`, like, like, like, like, limit))
      out.push({ type: "lead", id: l.id, title: "@" + l.username, sub: [l.name, PIPE_LABEL[derivePipeline(l)], l.score != null ? `${l.score}/100` : ""].filter(Boolean).join(" · "), to: "#/leads", leadId: l.id });
    for (const m of db.all(`SELECT m.lead_id, l.username, l.name, substr(m.text, 1, 80) AS snippet FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.text ILIKE ? GROUP BY m.lead_id, l.username, l.name, substr(m.text, 1, 80) ORDER BY MAX(m.ts) DESC LIMIT ?`, like, limit))
      out.push({ type: "message", id: m.lead_id, title: "@" + m.username, sub: `message: “${m.snippet}”`, to: "#/inbox", leadId: m.lead_id });
    for (const c of db.all(`SELECT id, name, offer FROM clients WHERE name ILIKE ? OR offer ILIKE ? OR target ILIKE ? LIMIT ?`, like, like, like, limit))
      out.push({ type: "campaign", id: c.id, title: c.name, sub: c.offer.slice(0, 70), to: "#/campaigns" });
    for (const a of db.all(`SELECT a.id, a.title, a.status, a.scheduled_at, l.username FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.title ILIKE ? OR l.username ILIKE ? ORDER BY a.scheduled_at DESC LIMIT ?`, like, like, limit))
      out.push({ type: "appointment", id: a.id, title: a.title || (a.username ? "Call with @" + a.username : "Appointment"), sub: `${APPT_LABEL[a.status] || a.status}${a.scheduled_at ? " · " + new Date(a.scheduled_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}`, to: "#/appointments" });
    for (const t of db.all(`SELECT t.id, t.title, t.done, l.username FROM lead_tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.title ILIKE ? OR l.username ILIKE ? ORDER BY t.created_at DESC LIMIT ?`, like, like, limit))
      out.push({ type: "task", id: t.id, title: t.title, sub: `${t.done ? "done" : "open"}${t.username ? " · @" + t.username : ""}`, to: "#/leads" });
    return { results: out.slice(0, 24) };
  }

  /* ================= operational transparency ================= */
  function health() {
    const t = now(), accs = db.all("SELECT * FROM accounts WHERE state != 'killed'").map(accounts.summary);
    const online = accs.filter((a) => a.online).length, quarantined = accs.filter((a) => a.badge === "quarantined").length;
    const lastInbound = db.get("SELECT MAX(ts) AS m FROM messages WHERE direction = 'in'").m;
    const lastSent = db.get("SELECT MAX(done_at) AS m FROM tasks WHERE result_code = 'sent'").m;
    const pending = db.get(`SELECT COUNT(*) AS n FROM leads WHERE gate = ''`).n + db.get(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`).n;
    const freshness = lastInbound ? (t - lastInbound * 1000 < 3600_000 ? "fresh" : t - lastInbound * 1000 < 6 * 3600_000 ? "recent" : "delayed") : "no data yet";
    return { workspace: "Maison Setter", accounts: accs.length, online, quarantined, lastInboundMs: lastInbound ? lastInbound * 1000 : null, lastSentMs: lastSent,
      dataFreshness: freshness, pendingWork: pending, ai: haiku.status(), note: "This system runs through connected browser accounts. Numbers reflect the latest synchronization, not a live Instagram session." };
  }

  /* maintenance tick: refresh alerts + chase nothing else */
  function tick() { try { recomputeAlerts(); } catch (e) { /* never break the loop */ } }

  return { notify, listNotifications, markRead, recomputeAlerts, listAlerts, setAlert, ALERT_KINDS, priorities, insights, roi, report, SECTIONS, onboardingOut, getOnboarding, saveOnboarding, completeOnboarding, search, health, tick };
}
module.exports = { createGrowth };
