/* Accounts: pairing, health, warm-up stage, daily caps, quarantine. Only sender accounts exist now:
   finding leads happens outside the app (Apify imports), so no account ever needs to browse for leads. */
const { now, DAY, HOUR, MIN, j, lc, clamp, HttpError } = require("./util");
const tzlib = require("./tz");

const WARM_DAYS = { new: 10, young: 6, established: 3 };
const EVENT_WEIGHT = { action_blocked: 40, checkpoint: 55, quarantine: 0, login_required: 3, selector_error: 1 };
const HARD_MAX_CAP = 40;
const QUARANTINE_HOURS = 48;
const ONLINE_MS = 90_000;

function createAccounts(ctx) {
  const { db, cfg, auth, bus } = ctx;
  let warmup = null;                      // attached right after both modules exist (see server.js)
  const attachWarmup = (w) => { warmup = w; };

  const byId = (id) => db.get("SELECT * FROM accounts WHERE id = ?", id);
  const byToken = (token) => (token ? db.get("SELECT * FROM accounts WHERE token_hash = ?", auth.hashToken(token)) : null);
  const clientFor = (a) => (a && a.client_id ? db.get("SELECT * FROM clients WHERE id = ?", a.client_id) : null);
  const defaults = () => { const w = db.setting("default_window", {}); return { tz: w.tz || cfg.defaultTz, send_start: w.start ?? 9, send_end: w.end ?? 20, daily_cap: 20 }; };
  const rulesFor = (a) => ({ ...defaults(), ...(clientFor(a) || {}) });
  const note = (a, level, text, kind = "") => { db.run("INSERT INTO activity(at, account_id, level, kind, text) VALUES(?,?,?,?,?)", now(), a ? a.id : null, level, kind, String(text).slice(0, 300)); bus?.publish({ t: "activity", accountId: a ? a.id : null, level, text }); };

  function create({ kind, label, igUsername, clientId, igAge }) {
    if (kind && kind !== "sender") throw new HttpError(400, "Only sender accounts are used now. Leads come in through imports.");
    const user = lc(igUsername).replace(/^@/, "");
    if (!/^[a-z0-9._]{1,30}$/.test(user)) throw new HttpError(400, "Enter the Instagram username without spaces.");
    if (!clientId || !db.get("SELECT id FROM clients WHERE id = ?", clientId)) throw new HttpError(400, "A sender account needs a campaign.");
    if (db.get("SELECT 1 AS x FROM accounts WHERE ig_username = ? AND state != 'killed'", user)) throw new HttpError(409, "That Instagram account is already added.");
    if (!WARM_DAYS[igAge || "young"]) throw new HttpError(400, "Account age must be new, young or established.");
    const token = auth.newToken();
    const r = db.run(`INSERT INTO accounts(kind, label, client_id, ig_username, token_hash, ig_age, warm_started_at, created_at) VALUES(?,?,?,?,?,?,?,?)`,
      "sender", String(label || user).slice(0, 80), clientId, user, auth.hashToken(token), igAge || "young", now(), now());
    bus?.publish({ t: "account", id: r.id });
    return { account: byId(r.id), token };
  }
  function rotateToken(id) {
    const token = auth.newToken();
    db.run("UPDATE accounts SET token_hash = ? WHERE id = ?", auth.hashToken(token), id);
    return { account: byId(id), token };
  }
  function pairingCode(account, token, baseUrl) {
    const s = cfg.publicUrl || baseUrl;
    return "me1." + Buffer.from(JSON.stringify({ s, t: token, m: "sender" })).toString("base64url");
  }

  function health(a) {
    let score = 100; const t = now();
    for (const e of db.all("SELECT kind, at FROM events WHERE account_id = ? AND at > ?", a.id, t - 30 * DAY)) {
      const decay = Math.max(0, 1 - (t - e.at) / (14 * DAY));
      score -= (EVENT_WEIGHT[e.kind] || 0) * decay;
    }
    score = clamp(Math.round(score), 0, 100);
    return { score, level: score >= 70 ? "healthy" : score >= 40 ? "caution" : "risky" };
  }
  function warm(a, ts = now()) {
    if (warmup && ts === now()) {        // the real program: a day counts only when it was clean and the browser ran
      const p = warmup.program(a);
      return { stage: p.active ? "active" : "warming", day: p.day, totalDays: p.total };
    }
    const total = WARM_DAYS[a.ig_age] || 6, day = Math.floor((ts - a.warm_started_at) / DAY) + 1;
    return { stage: day > total ? "active" : "warming", day: Math.min(day, total), totalDays: total };
  }
  const STATE_TEXT = { paused: "Paused in the dashboard.", killed: "Switched off in the dashboard.", restricted: "Instagram restricted this account. Reset it in the dashboard once it is sorted out.",
    cooldown: "Resting after a warning.", quarantined: "Quarantined after Instagram showed a warning." };
  function effectiveState(a) {
    if ((a.state === "cooldown" || a.state === "quarantined") && a.cooldown_until <= now()) {
      if (a.needs_reset) return { state: "quarantined", reason: "The 48 hours are over. Finish Instagram's security check by hand, then press Release." };
      db.run("UPDATE accounts SET state = 'active', reason = '', cooldown_until = 0, quarantined_at = NULL WHERE id = ?", a.id);
      a.state = "active"; a.reason = ""; a.cooldown_until = 0;
      note(a, "good", `${a.label} finished its quarantine and is back.`, "release");
      bus?.publish({ t: "account", id: a.id }); bus?.bump(a.id);
    }
    if (a.state !== "active") return { state: a.state, reason: a.reason || STATE_TEXT[a.state] || "" };
    if (a.last_mode && a.last_mode !== a.kind && a.last_seen_at && now() - a.last_seen_at < 10 * 60_000)
      return { state: "paused", reason: `This is a ${a.kind} account but the extension reports ${a.last_mode} mode. Update the extension.` };
    return { state: "active", reason: "" };
  }
  const sentToday = (a) => {
    const r = rulesFor(a), start = tzlib.startOfDay(now(), r.tz);
    return db.get(`SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type IN ('dm','followup') AND status = 'done' AND result_code = 'sent' AND done_at >= ?`, a.id, start).n;
  };
  function capToday(a) {
    if (effectiveState(a).state !== "active") return 0;
    const factor = { healthy: 1, caution: 0.5, risky: 0 }[health(a).level];
    if (warmup) {
      const p = warmup.program(a);
      if (!p.active) return p.dmsAllowed;                 // inside the program: the phase sets the quota
      const base = Math.min(a.daily_cap_override ?? rulesFor(a).daily_cap, HARD_MAX_CAP);
      return Math.floor(Math.min(base, p.rampCapToday || HARD_MAX_CAP) * factor);   // ramp cap comes from the plan (preset or custom)
    }
    const w = warm(a); if (w.stage !== "active") return 0;
    const base = Math.min(a.daily_cap_override ?? rulesFor(a).daily_cap, HARD_MAX_CAP);
    const activeDays = Math.max(0, Math.floor((now() - (a.warm_started_at + w.totalDays * DAY)) / DAY));
    const ramp = activeDays < 3 ? 5 : activeDays < 7 ? 10 : activeDays < 14 ? 15 : HARD_MAX_CAP;
    return Math.floor(Math.min(base, ramp) * factor);
  }

  /* ---------- quarantine ---------- */
  const healthySenders = (clientId, exceptId) => db.all("SELECT * FROM accounts WHERE kind = 'sender' AND client_id = ? AND id != ? ORDER BY id", clientId, exceptId)
    .filter((x) => effectiveState(x).state === "active" && health(x).level !== "risky");
  const queued = (a) => db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND status = 'pending' AND type IN ('dm','touch')", a.id).n;

  /* Moves a quarantined account's unsent first messages (and their warm-touches) to healthy sender accounts of the same campaign.
     Follow-ups and replies stay put: they belong to a conversation that lives in this account's inbox. */
  function reassignQueue(a) {
    const rows = db.all("SELECT * FROM tasks WHERE account_id = ? AND status = 'pending' AND type IN ('dm','touch') ORDER BY not_before, id", a.id);
    const pool = healthySenders(a.client_id, a.id).filter((x) => warm(x).stage === "active");
    let moved = 0, released = 0, i = 0; const byLead = new Map();
    for (const t of rows) {
      if (t.lead_id && byLead.has(t.lead_id)) { const to = byLead.get(t.lead_id); db.run("UPDATE tasks SET account_id = ? WHERE id = ?", to, t.id); continue; }
      const target = pool.length ? pool[i++ % pool.length] : null;
      if (t.type === "touch") { db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", now(), t.id); continue; }   // the new sender does its own touch
      db.run("UPDATE tasks SET account_id = ? WHERE id = ?", target ? target.id : null, t.id);
      if (t.lead_id) { db.run("UPDATE leads SET sender_account_id = ? WHERE id = ? AND stage = 'new'", target ? target.id : null, t.lead_id); if (target) byLead.set(t.lead_id, target.id); }
      if (target) { moved++; bus?.bump(target.id); } else released++;
    }
    return { moved, released, pool: pool.length };
  }

  function quarantine(a, { reason, trigger = "manual", needsReset = false, hours = QUARANTINE_HOURS } = {}) {
    const cur = byId(a.id);
    if (cur.state === "quarantined" && cur.cooldown_until > now()) return { account: cur, moved: 0, released: 0, already: true };   // reported twice: do nothing twice
    const why = reason || "Instagram showed a warning.";
    db.run("UPDATE accounts SET state = 'quarantined', cooldown_until = ?, quarantined_at = ?, needs_reset = ?, reason = ? WHERE id = ?",
      now() + hours * HOUR, now(), needsReset ? 1 : 0, `${why.replace(/[.!\s]+$/, "")}. Paused for ${hours} hours.${needsReset ? " Complete the security check by hand, then press Release." : ""}`, a.id);
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", a.id, "quarantine", `${trigger}: ${why}`.slice(0, 300), now());
    const r = reassignQueue(byId(a.id));
    note(a, "bad", `${a.label} quarantined for ${hours}h (${why.replace(/[.!\s]+$/, "")}). ${r.moved} queued first message${r.moved === 1 ? "" : "s"} moved to other senders${r.released ? `, ${r.released} waiting for any sender` : ""}.`, "quarantine");
    bus?.publish({ t: "account", id: a.id }); bus?.bump(a.id);
    return { account: byId(a.id), ...r };
  }
  function release(id) {
    const a = byId(id); if (!a) throw new HttpError(404, "Account not found.");
    db.run("UPDATE accounts SET state = 'active', reason = '', cooldown_until = 0, quarantined_at = NULL, needs_reset = 0 WHERE id = ?", id);
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", id, "dashboard_release", "", now());
    note(a, "good", `${a.label} was released from quarantine.`, "release");
    bus?.publish({ t: "account", id }); bus?.bump(id);
    return byId(id);
  }

  /* Events the extension reports. An action block or a security check quarantines the account straight away. */
  function recordEvent(a, kind, detail = "") {
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", a.id, kind, String(detail).slice(0, 300), now());
    if (kind === "action_blocked") quarantine(a, { reason: detail || "Instagram showed an action block.", trigger: "action_blocked" });
    else if (kind === "checkpoint") quarantine(a, { reason: detail || "Instagram asked for a security check.", trigger: "checkpoint", needsReset: true });
    else { bus?.publish({ t: "account", id: a.id }); if (kind === "login_required") note(a, "warn", `${a.label}: Instagram is logged out in that browser.`, kind); }
  }
  function act(id, action) {
    const a = byId(id); if (!a) throw new HttpError(404, "Account not found.");
    const set = (state, reason, cd = 0) => db.run("UPDATE accounts SET state = ?, reason = ?, cooldown_until = ?, needs_reset = 0 WHERE id = ?", state, reason, cd, id);
    if (action === "pause") set("paused", "Paused in the dashboard.");
    else if (action === "resume" || action === "reset") return release(id);
    else if (action === "kill") set("killed", "Switched off in the dashboard.");
    else if (action === "quarantine") return quarantine(a, { reason: "Quarantined from the dashboard.", trigger: "dashboard" }).account;
    else throw new HttpError(400, "Unknown action.");
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", id, "dashboard_" + action, "", now());
    if (action !== "pause") reassignQueue(byId(id));
    bus?.publish({ t: "account", id }); bus?.bump(id);
    return byId(id);
  }

  function config(a) {
    const st = effectiveState(a), w = warm(a), h = health(a), c = clientFor(a);
    return {
      role: "sender", state: st.state, reason: st.reason, expectedUsername: a.ig_username, warm: { stage: w.stage, day: w.day },
      program: warmup ? warmup.program(a) : undefined,
      sentToday: sentToday(a), capToday: capToday(a), health: h, quarantineUntil: st.state === "quarantined" ? a.cooldown_until : 0,
      campaign: c ? c.name : "", selectors: db.setting("selectors", undefined), blockPhrases: db.setting("block_phrases", undefined), serverTime: now()
    };
  }
  function badgeOf(a, st, w) {
    if (["quarantined", "cooldown", "restricted"].includes(st.state)) return "quarantined";
    if (st.state === "killed") return "off";
    if (st.state === "paused") return "paused";
    return w.stage === "warming" ? "warming" : "active";
  }
  const summary = (a) => {
    const w = warm(a), h = health(a), st = effectiveState(a), c = clientFor(a), seen = a.last_seen_at || 0;
    const p = warmup ? warmup.program(a) : null;
    return { id: a.id, role: a.kind, kind: a.kind, label: a.label, igUsername: a.ig_username, clientId: a.client_id, clientName: c ? c.name : "", igAge: a.ig_age,
      state: st.state, badge: badgeOf(a, st, w), reason: st.reason, warm: w, health: h, lastSeenAt: a.last_seen_at, lastVersion: a.last_version, lastMode: a.last_mode,
      program: p ? { day: p.day, total: p.total, done: p.done, active: p.active, phaseLabel: p.phaseLabel, warnings: p.warnings, missedDays: p.missedDays, sessionsDone: p.sessionsDone, sessionsRequired: p.sessionsRequired, dmsSent: p.dmsSent, dmsAllowed: p.dmsAllowed, planId: p.planId, planName: p.planName, planCustom: p.planCustom } : undefined,
      online: !!seen && now() - seen < ONLINE_MS, loggedInAs: a.logged_in_as, sentToday: sentToday(a), capToday: capToday(a), dailyCapOverride: a.daily_cap_override,
      quarantinedUntil: st.state === "quarantined" ? a.cooldown_until : null, needsReset: !!a.needs_reset, queued: queued(a),
      driver: a.driver || "extension", dolphinProfileId: a.dolphin_profile_id || "", proxyIp: a.proxy_ip || "",
      lastAction: a.last_action || "", lastActionAt: a.last_action_at || null, replacedBy: a.replaced_by, createdAt: a.created_at };
  };
  return { WARM_DAYS, QUARANTINE_HOURS, byId, byToken, clientFor, rulesFor, create, rotateToken, pairingCode, health, warm, effectiveState, sentToday, capToday, queued,
    reassignQueue, quarantine, release, recordEvent, act, config, summary, note, attachWarmup };
}
module.exports = { createAccounts, WARM_DAYS, QUARANTINE_HOURS };
