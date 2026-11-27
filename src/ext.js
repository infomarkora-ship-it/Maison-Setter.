/* Endpoints the Chrome extension calls. Auth: "Authorization: Bearer <account token>". */
const { now, str, num, HttpError, j } = require("./util");

const EVENT_KINDS = ["action_blocked", "checkpoint", "login_required", "selector_error"];
const PULSE_MAX_MS = 25_000;

/* The handlers are shared: the Chrome extension reaches them at /ext/* with the account's own token, and the runner
   reaches the same ones at /runner/a/:id/* with the runner token (see runner.js). */
function touchSeen(ctx, account) {
  const wasOnline = account.last_seen_at && now() - account.last_seen_at < 90_000;
  ctx.db.run("UPDATE accounts SET last_seen_at = ? WHERE id = ?", now(), account.id);
  if (!wasOnline) ctx.bus.publish({ t: "account", id: account.id });
}
function registerExt(router, ctx) {
  const { db, accounts, bus } = ctx;
  const authed = (handler) => async (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(c.req.headers.authorization || ""));
    const account = m ? accounts.byToken(m[1]) : null;
    if (!account) throw new HttpError(401, "Unknown or expired token. Pair the extension again.");
    touchSeen(ctx, account);
    return handler({ ...c, account });
  };
  const H = makeHandlers(ctx, "ext");
  for (const [method, path, name] of ROUTES) router[method]("/ext" + path, authed(H[name]));
}
const ROUTES = [["get", "/config", "config"], ["get", "/pulse", "pulse"], ["post", "/heartbeat", "heartbeat"], ["post", "/event", "event"], ["post", "/quarantine", "quarantine"], ["post", "/log", "log"],
  ["post", "/status", "status"], ["get", "/tasks/next", "tasksNext"], ["post", "/tasks/result", "tasksResult"], ["post", "/inbox/sync", "inboxSync"], ["get", "/leads", "leads"]];
function makeHandlers(ctx, via) {
  const { db, accounts, scheduler, leads, bus } = ctx;
  const H = {};
  /* Role separation, enforced on the server: this API only serves sender accounts. */
  const senderOnly = (a) => { if (a.kind !== "sender") throw new HttpError(403, "Only sender accounts can use this."); };

  H.config = ({ account, query }) => {
    const cfg = accounts.config(account), taskId = num(query.get("task"));
    if (taskId) {            // last check before a message goes out: is this task still this account's to send?
      const t = db.get("SELECT status, account_id FROM tasks WHERE id = ?", taskId);
      cfg.taskOk = !!t && t.status === "pending" && (t.account_id === null || t.account_id === account.id);
    }
    return cfg;
  };

  /* Long poll. The extension sends the revision it last saw; this answers when something changed for it
     (a lead approved, a pause, a setting) or after 25 seconds, so commands from the dashboard land within a second. */
  H.pulse = async ({ account, query, req }) => {
    const since = num(query.get("rev"), -1), wait = Math.max(0, Math.min(PULSE_MAX_MS, num(query.get("wait"), PULSE_MAX_MS)));
    const ac = new AbortController(); req.on("close", () => ac.abort());
    const rev = await bus.waitForChange(account.id, since, wait, ac.signal);
    const st = accounts.effectiveState(accounts.byId(account.id));
    return { rev, state: st.state, changed: rev !== since, serverTime: now() };
  };

  H.heartbeat = ({ account, body }) => {
    db.run("UPDATE accounts SET last_version = ?, logged_in_as = ?, last_mode = ?, proxy_ip = COALESCE(NULLIF(?, ''), proxy_ip) WHERE id = ?", str(body.version, 20), str(body.loggedInAs, 40), body.mode === "sender" ? "sender" : null, str(body.proxyIp, 60), account.id);
    bus.publish({ t: "account", id: account.id });
    return { ok: true };
  };

  H.event = ({ account, body }) => {
    if (!EVENT_KINDS.includes(body.kind)) throw new HttpError(400, "Unknown event.");
    accounts.recordEvent(account, body.kind, body.detail);
    return { ok: true };
  };

  /* Checkpoint auto-kill switch. The extension calls this the moment it sees a rate-limit or warning screen. */
  H.quarantine = ({ account, body }) => {
    senderOnly(account);
    const trigger = ["rate_limit", "automation_warning", "checkpoint", "suspended"].includes(body.trigger) ? body.trigger : "rate_limit";
    const hard = trigger === "checkpoint" || trigger === "suspended";
    const label = { rate_limit: "Instagram said to try again later", automation_warning: "Instagram suspects automated behavior", checkpoint: "Instagram asked for a security check", suspended: "Instagram suspended or disabled the account" }[trigger];
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", account.id, hard ? "checkpoint" : "action_blocked", str(body.url, 120), now());
    const r = accounts.quarantine(account, { reason: label, trigger, needsReset: hard });
    return { ok: true, quarantined: true, already: !!r.already, moved: r.moved, released: r.released, until: accounts.byId(account.id).cooldown_until };
  };

  /* The extension's own log lines, so the dashboard can show what each browser is doing right now. */
  H.log = ({ account, body }) => {
    const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 20);
    for (const l of lines) accounts.note(account, ["good", "warn", "bad"].includes(l?.level) ? l.level : "info", `${account.label}: ${str(l?.text, 200)}`, "extension");
    return { ok: true, n: lines.length };
  };

  /* Senders Live: the extension posts what it is doing right now (task, step, screen, counts) whenever
     something changes and at least every ~20s. The runner's heartbeats already cover runner accounts.
     v3.4: the blob can also carry a small batch of NEW narrated diary lines (plain-English micro-steps:
     "opened @x's profile", "watched their story", "typing the opener"). They go into the in-memory
     diary ring for the Day diary page AND into the activity table, so they survive a restart and
     show up in the dashboard's live feed too. */
  H.status = ({ account, body }) => {
    if (ctx.live && Array.isArray(body.diary) && body.diary.length) {
      const added = ctx.live.diaryAdd(account.id, body.diary);
      if (added) for (const raw of body.diary.slice(0, 20)) {
        const text = String(raw || "").trim(); if (!text) continue;
        db.run("INSERT INTO activity(at, account_id, level, kind, text) VALUES(?,?,?,?,?)", now(), account.id, "info", "narration", `${account.label}: ${str(text, 200)}`);
        ctx.bus?.publish({ t: "activity", accountId: account.id, level: "info", text: `${account.label}: ${str(text, 200)}` });
      }
    }
    if (!ctx.live) return { ok: true };
    const blob = ctx.live.update(account.id, {
      phase: ["idle", "waiting", "working", "browsing", "inbox", "identity", "paused", "quarantined", "offline"].includes(body.phase) ? body.phase : "idle",
      taskType: str(body.taskType, 20), taskId: num(body.taskId) || null, username: str(body.username, 40),
      taskLabel: str(body.taskLabel, 40), stepIndex: Math.max(0, Math.min(40, num(body.stepIndex, 0))), stepTotal: Math.max(0, Math.min(40, num(body.stepTotal, 0))),
      next: str(body.next, 160), why: str(body.why, 200),
      step: str(body.step, 160), screen: str(body.screen, 40), note: str(body.note, 160),
      sentToday: Math.max(0, Math.min(999, num(body.sentToday, 0))), capToday: Math.max(0, Math.min(999, num(body.capToday, 0))),
      lastError: str(body.lastError, 200), driver: str(body.driver, 10) || account.driver || "extension",
      logLine: str(body.logLine, 200), version: str(body.version, 20)
    });
    ctx.bus.publish({ t: "live", id: account.id, status: blob });
    return { ok: true };
  };

  H.tasksNext = ({ account, query }) => {
    const exclude = String(query.get("exclude") || "").split(",").map(Number).filter(Number.isFinite);
    // test=1: the browser is paused or outside the sending hours and asks ONLY for queued test-bench work.
    return scheduler.nextTask(account, exclude, via, { testOnly: query.get("test") === "1" });
  };
  H.tasksResult = ({ account, body }) => scheduler.result(account, body);

  H.inboxSync = ({ account, body }) => { senderOnly(account); return { newInbound: leads.processInbox(account, body.threads) }; };

  H.leads = ({ account, query }) => {
    senderOnly(account);
    const limit = Math.min(500, num(query.get("limit"), 300));
    const client = accounts.clientFor(account), seqLen = client ? j(client.followups, []).length : 0;
    const rows = db.all("SELECT * FROM leads WHERE client_id = ? AND review = 'approved' ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ?", account.client_id, limit);
    return { leads: rows.map((l) => ({ username: l.username, name: l.name, customerType: l.detected_niche || l.lead_type_name, stage: l.stage,
      nextFollowUpAt: l.next_follow_at || null, lastActivityAt: l.last_activity_at || null, followUpStep: l.follow_step, followUpTotal: l.no_followup ? 0 : seqLen })) };
  };
  return H;
}
module.exports = { registerExt, makeHandlers, touchSeen, ROUTES };
