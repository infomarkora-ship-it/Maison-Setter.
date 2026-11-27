/* Scheduler: hands the extension its next task, spreads warm-up sessions through the day,
   books follow-ups, and applies the result the extension reports. */
const { now, DAY, HOUR, MIN, j, fill, str, num, rand, HttpError } = require("./util");
const tzlib = require("./tz");

const OUTBOUND = ["dm", "followup"];
const TOUCH_MIN = 10, TOUCH_MAX = 30;     // minutes between the warm-touch and the cold opener
const TERMINAL_CODES = ["existing_thread", "private_cant_message", "cant_message", "invalid_profile", "lead_replied", "unconfirmed"];

function createScheduler(ctx) {
  const { db, accounts, leads, bus, warmup } = ctx;
  const clientOf = (id) => (id ? db.get("SELECT * FROM clients WHERE id = ?", id) : null);

  function variantFor(account) {
    const w = accounts.warm(account);
    if (accounts.health(account).level !== "healthy") return "careful";
    if (w.stage === "active") return "settled";
    return w.day <= 3 ? "gentle" : "steady";
  }

  /* Warm-up sessions are booked lazily, a few per day at random times inside the sending hours.
     How many depends on what today's program phase asks for. */
  function ensureDailyWarm(account) {
    const rules = accounts.rulesFor(account), t = now(), start = tzlib.startOfDay(t, rules.tz), end = start + DAY;
    const have = db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type = 'warm' AND not_before >= ? AND not_before < ?", account.id, start, end).n;
    const w = accounts.warm(account);
    const plan = warmup ? warmup.dayPlan(w.stage === "active" ? 12 : w.day) : null;
    const target = w.stage === "warming" ? (plan ? plan.sessions : w.day <= 2 ? 2 : w.day <= 5 ? 3 : 4) : 2;
    if (have >= target) return;
    const winStart = start + (rules.send_start + 0.4) * HOUR, winEnd = start + (rules.send_end - 0.5) * HOUR;
    const from = Math.max(t + 2 * MIN, winStart);
    if (from >= winEnd) return;
    const n = target - have, slot = (winEnd - from) / n;
    for (let i = 0; i < n; i++) {
      const nb = Math.floor(from + slot * i + Math.random() * slot * 0.7);
      db.run("INSERT INTO tasks(account_id, client_id, type, status, not_before, created_at) VALUES(?,?,?,?,?,?)", account.id, account.client_id, "warm", "pending", nb, t);
    }
  }

  /* Who this account may follow in this warm-up session: a few from the campaign's follow pool plus the
     accounts the AI discovered while browsing (stored per campaign in follow_discovered), never the same
     one twice, and never above the daily cap (lower while the account is still warming up).
     Discovered accounts come first, so the following list keeps growing with fresh, real-looking accounts
     even when the hand-picked pool is small. */
  const FOLLOW_CAP = () => Math.max(0, Math.min(8, Math.round(Number(db.setting("follow_cap", 3)))));
  function followsFor(account) {
    const client = accounts.clientFor(account), pool = j(client?.follow_pool, []), found = j(client?.follow_discovered, []);
    if (!pool.length && !found.length) return [];
    const w = accounts.warm(account);
    const plan = warmup ? warmup.dayPlan(w.stage === "active" ? 12 : w.day) : null;
    const cap = Math.min(FOLLOW_CAP(), plan ? plan.follows : w.stage === "warming" ? 1 : FOLLOW_CAP());
    const today = db.get("SELECT COUNT(*) AS n FROM follows WHERE account_id = ? AND at >= ?", account.id, now() - DAY).n, left = Math.min(3, cap - today);
    if (left <= 0) return [];
    const done = new Set(db.all("SELECT username FROM follows WHERE account_id = ?", account.id).map((r) => r.username)), mine = new Set(db.all("SELECT ig_username FROM accounts").map((r) => r.ig_username));
    const freshFound = found.filter((u) => !pool.includes(u)).sort(() => Math.random() - 0.5);
    return [...freshFound, ...pool].filter((u) => !done.has(u) && !mine.has(u)).slice(0, left);
  }

  /* The extension collected candidate accounts while browsing explore / the feed. Validate each one and
     keep them on the campaign's discovered list (deduped against the pool, leads, sender accounts and
     anything already followed), so tomorrow's warm sessions have fresh follow targets. */
  function noteDiscovered(account, names) {
    const client = accounts.clientFor(account);
    if (!client || !Array.isArray(names) || !names.length) return 0;
    const bad = /\.(php|html?|js|css|json)$/i, re = /^[a-z0-9._]{1,30}$/;
    const skip = new Set([...j(client.follow_pool, []), ...j(client.follow_discovered, [])]);
    for (const r of db.all("SELECT username FROM leads WHERE client_id = ?", client.id)) skip.add(r.username);
    for (const r of db.all("SELECT ig_username FROM accounts")) skip.add(r.ig_username);
    for (const r of db.all("SELECT username FROM follows WHERE account_id = ?", account.id)) skip.add(r.username);
    const out = [];
    for (const raw of names.slice(0, 24)) {
      const u = String(raw || "").toLowerCase().replace(/^@/, "").replace(/\/.*/, "");
      if (!re.test(u) || bad.test(u) || u === account.ig_username || skip.has(u) || ["p", "reel", "explore", "direct", "accounts", "stories", "tv"].includes(u)) continue;
      skip.add(u); out.push(u);
      if (out.length >= 16) break;
    }
    if (out.length) {
      const list = [...j(client.follow_discovered, []), ...out].slice(-300);
      db.run("UPDATE clients SET follow_discovered = ? WHERE id = ?", JSON.stringify(list), client.id);
      accounts.note(account, "info", `${account.label} spotted ${out.length} new account${out.length === 1 ? "" : "s"} to follow later (${out.slice(0, 4).map((u) => "@" + u).join(", ")}${out.length > 4 ? ", ..." : ""}).`, "discover");
    }
    return out.length;
  }

  /* ---------- the test bench: make one sender do one real thing, right now ----------
     A test task (type 'test', payload {kind: follow|like|dm, ...}) is written by POST /api/test/run.
     It jumps the whole queue: no sending window, no daily cap, no warm-up gating, no human-gap hold.
     The only thing a test still respects is a hard stop: quarantine, cooldown, restriction or killed.
     Nothing is retried either - a test reports pass or fail, once. */
  const TEST_HARD_STOP = ["quarantined", "cooldown", "restricted", "killed"];
  function serveTest(row, account) {
    const p = j(row.payload, {});
    return { task: { id: row.id, type: "test", username: p.username || undefined, text: row.text || undefined, payload: p } };
  }
  function nextTest(account) {
    const st = accounts.effectiveState(account);
    if (TEST_HARD_STOP.includes(st.state)) return { task: null, reason: st.reason || st.state };
    const row = db.get("SELECT * FROM tasks WHERE type = 'test' AND status = 'pending' AND not_before <= ? AND account_id = ? ORDER BY not_before, id LIMIT 1", now(), account.id);
    return row ? serveTest(row, account) : { task: null };
  }

  function nextTask(account, exclude = [], via = "ext", opts = {}) {
    // Role separation: only a sender is ever given work. (Finding leads no longer runs through an account at all.)
    if (account.kind !== "sender") return { task: null, reason: "not a sender account" };
    // One driver per account: either the Chrome extension or the runner, never both.
    if ((account.driver === "runner" ? "runner" : "ext") !== via) return { task: null, reason: "this account is driven by the other driver" };
    // A queued test jumps every line, even before the pause and sending-window checks.
    const tst = nextTest(account);
    if (tst.task) return tst;
    if (opts.testOnly) return tst;                            // paused / outside hours: tests only, never the regular work
    const st = accounts.effectiveState(account);
    if (st.state !== "active") return { task: null };
    const rules = accounts.rulesFor(account), t = now(), hr = tzlib.localHour(t, rules.tz);
    if (hr < rules.send_start || hr >= rules.send_end) return { task: null, reason: "outside sending window" };
    ensureDailyWarm(account);
    const w = accounts.warm(account), ex = new Set(exclude.map(Number));
    const rows = db.all(`SELECT * FROM tasks WHERE status = 'pending' AND not_before <= ? AND (account_id = ? OR (account_id IS NULL AND client_id IS ?))
      ORDER BY CASE type WHEN 'reply' THEN 0 WHEN 'followup' THEN 1 WHEN 'dm' THEN 2 ELSE 3 END, not_before, id LIMIT 60`, t, account.id, account.client_id);
    let paced = false, sent = null, lastOut = null;
    for (const task of rows) {
      if (ex.has(task.id)) continue;
      // While the warm-up program is still running, only what today's phase allows goes out.
      // Replies are always fine: answering someone who wrote first is the most human thing there is.
      if (task.type !== "warm" && task.type !== "reply" && w.stage !== "active") {
        const plan = warmup ? warmup.dayPlan(w.day) : null;
        if (!plan || plan.dms <= 0) continue;
      }
      let lead = null;
      if (task.lead_id) {
        lead = leads.get(task.lead_id);
        if (!lead || lead.review !== "approved" || ["do_not_contact", "cold", "customer", "booked"].includes(lead.stage) && task.type !== "reply") { db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", t, task.id); continue; }
        if (["do_not_contact"].includes(lead.stage)) { db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", t, task.id); continue; }
      }
      if (OUTBOUND.includes(task.type)) {
        if (sent === null) sent = accounts.sentToday(account);
        if (sent >= accounts.capToday(account)) { paced = true; continue; }
        if (lastOut === null) lastOut = db.get("SELECT MAX(done_at) AS t FROM tasks WHERE account_id = ? AND type IN ('dm','followup') AND status = 'done'", account.id).t || 0;
        if (t - lastOut < 3 * MIN) { paced = true; continue; }
        // Pre-DM micro-engagement: before a cold opener goes out, the same account views the story or likes a post,
        // then the opener waits 10 to 30 minutes. The opener is pinned to this account so no other sender can message the lead.
        if (task.type === "dm" && clientOf(task.client_id)?.pre_dm_touch) {
          const tch = db.get("SELECT id, status FROM tasks WHERE lead_id = ? AND type = 'touch' ORDER BY id DESC LIMIT 1", task.lead_id);
          if (!tch) {
            const inflight = db.get(`SELECT COUNT(*) AS n FROM tasks d WHERE d.account_id = ? AND d.type = 'dm' AND d.status = 'pending' AND EXISTS (SELECT 1 FROM tasks x WHERE x.lead_id = d.lead_id AND x.type = 'touch')`, account.id).n;
            if (sent + inflight >= accounts.capToday(account)) { paced = true; continue; }
            const id = db.tx(() => {
              db.run("UPDATE tasks SET account_id = ?, not_before = ? WHERE id = ?", account.id, t + rand(TOUCH_MIN, TOUCH_MAX + 1) * MIN, task.id);
              return db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, status, not_before, created_at) VALUES(?,?,?,?,?,?,?)", account.id, task.client_id, task.lead_id, "touch", "pending", t, t).id;
            });
            const row = db.get("SELECT * FROM tasks WHERE id = ?", id);
            // follow_leads: the touch also follows the lead, so the DM lands on a familiar face
            return { task: { id: row.id, type: "touch", username: lead.username, text: "", threadIg: "", payload: { followLead: !!clientOf(task.client_id)?.follow_leads } } };
          }
          if (tch.status === "pending") continue;                       // the touch comes first
        }
      }
      if (task.type === "reply" && !task.text) continue;
      if (!task.account_id) db.run("UPDATE tasks SET account_id = ? WHERE id = ? AND account_id IS NULL", account.id, task.id);
      // Warm sessions now carry follow targets for BOTH drivers: the extension and the runner follow alike.
      return { task: { id: task.id, type: task.type, username: lead ? lead.username : undefined, text: task.text, threadIg: lead ? lead.thread_ig : "",
        inboundAt: task.inbound_at || undefined, payload: task.type === "warm" ? { variant: variantFor(account), follows: followsFor(account) } : {} }, threadIg: lead ? lead.thread_ig : undefined };
    }
    return { task: null, ...(paced ? { reason: "pacing" } : {}) };
  }

  /* After a warm-touch (whatever came of it), the opener goes out 10 to 30 minutes later. */
  function touchFinished(task, t) {
    db.run("UPDATE tasks SET not_before = ? WHERE lead_id = ? AND type = 'dm' AND status = 'pending'", t + rand(TOUCH_MIN, TOUCH_MAX + 1) * MIN, task.lead_id);
  }
  /* Plain-English verdicts for the test bench, shown in the dashboard and the Day diary. */
  const TEST_OK = {
    follow: { followed: "followed them, confirmed on the page", sent: "followed them" },
    like: { liked: "liked it", sent: "liked it" },
    dm: { sent: "sent, and visible in the thread" }
  };
  const TEST_FAIL = {
    invalid_profile: "Instagram says that page does not exist",
    private_cant_message: "that account is private, so it cannot be messaged",
    cant_message: "Instagram does not allow messaging that account",
    no_message_button: "no Message button found on the profile (it may not accept messages)",
    no_textbox: "the message box never opened",
    unconfirmed: "the message box emptied but the message was never seen in the thread - check by hand",
    existing_thread: "there is already a conversation with them",
    no_follow_button: "no Follow button found (already following, or the page did not load right)",
    follow_unconfirmed: "the Follow click did not confirm on the page",
    no_post_to_like: "no post found on that profile to like",
    no_like_button: "no Like button found on that page",
    like_unconfirmed: "the Like click did not confirm on the page",
    aborted: "stopped before anything happened (Stop pressed, or the server said no)",
    login_required: "Instagram is logged out in that browser",
    blocked: "Instagram showed a rate-limit or warning",
    checkpoint: "Instagram asked for a security check",
    cancelled: "cancelled from the dashboard before it ran"
  };
  function testResult(account, task, b) {
    const p = j(task.payload, {}), t = now(), code = str(b.code, 40);
    const ok = !!b.ok && code !== "unconfirmed";
    db.run("UPDATE tasks SET status = ?, result_code = ?, done_at = ?, account_id = ? WHERE id = ?", ok ? "done" : "failed", ok ? code || "sent" : code || "error", t, account.id, task.id);
    const what = p.kind === "follow" ? `follow @${p.username || "?"}`
      : p.kind === "like" ? (p.postUrl ? `like ${String(p.postUrl).replace(/^https?:\/\/(www\.)?instagram\.com\//, "")}` : `like @${p.username || "?"}'s latest post`)
      : `message @${p.username || "?"}`;
    const verdict = ok ? (TEST_OK[p.kind]?.[code] || str(b.detail, 60) || "done") : (TEST_FAIL[code] || `${code || "failed"}${b.error ? " (" + str(b.error, 80) + ")" : ""}`);
    accounts.note(account, ok ? "good" : "warn", `Test on ${account.label}: tried to ${what} - ${verdict}.${ok ? "" : " Nothing was retried."}`, "test");
    db.run("UPDATE accounts SET last_action = 'test', last_action_at = ? WHERE id = ?", t, account.id);
    bus?.publish({ t: "task", accountId: account.id }); bus?.publish({ t: "account", id: account.id });
    return { ok: true };
  }
  function result(account, b) {
    if (account.kind !== "sender") throw new HttpError(403, "Only sender accounts report results.");
    const task = db.get("SELECT * FROM tasks WHERE id = ?", num(b.id));
    if (!task) throw new HttpError(404, "Unknown task.");
    if (task.account_id && task.account_id !== account.id) throw new HttpError(403, "That task belongs to another account.");
    if (["done", "skipped", "failed"].includes(task.status)) return { ok: true, ignored: true };
    if (task.type === "test") return testResult(account, task, b);   // a test is pass/fail once: never retried, no lead side-effects
    const code = str(b.code, 40), t = now();
    if (task.type === "warm" && Array.isArray(b.followed)) for (const u of b.followed.slice(0, 5)) { const name = String(u || "").toLowerCase().replace(/^@/, ""); if (/^[a-z0-9._]{1,30}$/.test(name)) db.run("INSERT OR IGNORE INTO follows(account_id, username, at) VALUES(?,?,?)", account.id, name, t); }
    if (task.type === "warm" && Array.isArray(b.discovered) && b.discovered.length) { try { noteDiscovered(account, b.discovered); } catch { /* discovery is a bonus, never a failure */ } }
    if (task.type === "warm" && Number(b.followedCount) > 0) accounts.note(account, "info", `${account.label} followed ${b.followedCount} account${b.followedCount === 1 ? "" : "s"} during its warm-up session.`, "follow");
    if (task.type === "touch" && !["blocked", "checkpoint", "login_required"].includes(code)) {
      db.run("UPDATE tasks SET status = ?, result_code = ?, done_at = ?, account_id = ? WHERE id = ?", b.ok ? "done" : "failed", b.ok ? "sent" : code || "skipped", t, account.id, task.id);
      touchFinished(task, t);
      const l = leads.get(task.lead_id);
      if (l) accounts.note(account, b.ok ? "info" : "info", b.ok ? `${account.label} warmed up @${l.username} (${str(b.detail, 40) || "touch"}).` : `${account.label} could not warm up @${l.username} (${code || "skipped"}). The opener still goes out later.`, "touch");
      bus?.publish({ t: "task", accountId: account.id });
      return { ok: true };
    }
    if (b.ok) {
      db.run("UPDATE tasks SET status = 'done', result_code = 'sent', done_at = ?, account_id = ? WHERE id = ?", t, account.id, task.id);
      if (task.lead_id && ["dm", "followup", "reply"].includes(task.type)) {
        leads.afterSent({ ...task, text: task.text }, account);
        const l = leads.get(task.lead_id);
        accounts.note(account, "good", `${account.label} sent ${{ dm: "a first message", followup: "a follow-up", reply: "a reply" }[task.type]} to @${l ? l.username : "someone"}.`, "sent");
      }
      db.run("UPDATE accounts SET last_action = ?, last_action_at = ? WHERE id = ?", task.type, t, account.id);
      bus?.publish({ t: "task", accountId: account.id }); bus?.publish({ t: "account", id: account.id });
      return { ok: true };
    }
    if (TERMINAL_CODES.includes(code)) {
      db.run("UPDATE tasks SET status = 'failed', result_code = ?, done_at = ? WHERE id = ?", code, t, task.id);
      if (task.lead_id) leads.afterFailed(task, code);
    } else if (code === "blocked" || code === "checkpoint") {
      db.run("UPDATE tasks SET not_before = ? WHERE id = ?", t + 12 * HOUR, task.id);
    } else if (code === "login_required") {
      db.run("UPDATE tasks SET not_before = ? WHERE id = ?", t + 30 * MIN, task.id);
    } else if (b.safeToRetry && task.tries < 3) {
      db.run("UPDATE tasks SET tries = tries + 1, not_before = ? WHERE id = ?", t + 15 * MIN * (task.tries + 1), task.id);
    } else {
      db.run("UPDATE tasks SET status = 'failed', result_code = ?, done_at = ? WHERE id = ?", code || "error", t, task.id);
      if (task.lead_id && task.type !== "warm" && task.type !== "touch") { const l = leads.get(task.lead_id); if (l) leads.touch(l.id, { needs_human: 1, notes: (l.notes ? l.notes + "\n" : "") + `Sending failed (${code || "error"}). Check by hand.` }); }
    }
    bus?.publish({ t: "task", accountId: account.id });
    return { ok: true };
  }

  /* Runs every minute: follow-ups that are due, stale tasks, optional auto-pause of weak sources. */
  function maintain() {
    const t = now();
    const due = db.all(`SELECT l.*, c.followups AS seq_json FROM leads l JOIN clients c ON c.id = l.client_id
      WHERE l.review = 'approved' AND l.stage = 'contacted' AND l.no_followup = 0 AND l.next_follow_at IS NOT NULL AND l.next_follow_at <= ? LIMIT 200`, t);
    for (const l of due) {
      const seq = j(l.seq_json, []);
      if (l.follow_step >= seq.length) { leads.touch(l.id, { stage: "cold", next_follow_at: null }); continue; }
      if (!l.thread_ig) continue;                       // wait until the inbox sync has seen the conversation
      if (db.get("SELECT 1 AS x FROM tasks WHERE lead_id = ? AND type = 'followup' AND status IN ('pending','draft')", l.id)) continue;
      const client = db.get("SELECT * FROM clients WHERE id = ?", l.client_id);
      const text = leads.cleanText(fill(seq[l.follow_step].text || "Hey {first_name}, just checking in!", leads.vars(l, client)), client, true);
      db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, text, status, not_before, created_at) VALUES(?,?,?,?,?,?,?,?)",
        l.sender_account_id, l.client_id, l.id, "followup", text, "pending", l.next_follow_at, t);
    }
    db.run(`UPDATE tasks SET status = 'skipped', done_at = ? WHERE type = 'dm' AND status = 'pending' AND lead_id IN (SELECT id FROM leads WHERE review != 'approved' OR stage != 'new')`, t);
    db.run("DELETE FROM tasks WHERE type = 'warm' AND status IN ('done','skipped') AND done_at < ?", t - 14 * DAY);
    db.run("DELETE FROM events WHERE at < ?", t - 90 * DAY);
    db.run("DELETE FROM activity WHERE at < ?", t - 14 * DAY);
    // a warm-touch that never ran (browser closed) must not hold its opener back for ever
    db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE type = 'touch' AND status = 'pending' AND created_at < ?", t, t - 60 * MIN);
  }
  return { nextTask, nextTest, result, maintain, ensureDailyWarm, variantFor, followsFor, noteDiscovered, TOUCH_MIN, TOUCH_MAX };
}
module.exports = { createScheduler };
