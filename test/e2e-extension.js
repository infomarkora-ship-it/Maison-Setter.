/* The real extension background code talking to the real server over HTTP, with a fake Chrome and fake Instagram pages.
   Proves the two halves agree on every request and response, including the live link and the safety switch. */
const vm = require("node:vm"), fs = require("node:fs");
const { createApp } = require("../src/server");
const EXT = process.env.EXT_DIR || "../maison-setter-extension/";
if (!fs.existsSync(EXT + "background.js")) { console.log("Skipped: set EXT_DIR to the folder of the unzipped extension, with a trailing slash."); process.exit(0); }
let bad = 0, total = 0;
const eq = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `\n   got  ${JSON.stringify(g)}\n   want ${JSON.stringify(w)}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(40); } return false; };

(async () => {
  const app = createApp({ dbPath: process.env.TEST_DB_PATH || ":memory:", adminPassword: "x", anthropicKey: "", logger: { error() {} } });
  const port = await app.listen(0), BASE = `http://127.0.0.1:${port}`, { db } = app;
  db.setSetting("default_window", { start: 0, end: 24 });
  const lr = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) });
  const cookie = lr.headers.get("set-cookie").split(";")[0];
  const J = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
  const c = await J("POST", "/api/clients", { name: "Acme", sendStart: 0, sendEnd: 24 });
  const a1 = await J("POST", "/api/accounts", { igUsername: "acme_one", clientId: c.id, igAge: "established" });
  const a2 = await J("POST", "/api/accounts", { igUsername: "acme_two", clientId: c.id, igAge: "established" });
  const code1 = JSON.parse(Buffer.from(a1.pairingCode.slice(4), "base64url")), code2 = JSON.parse(Buffer.from(a2.pairingCode.slice(4), "base64url"));
  db.run("UPDATE accounts SET warm_started_at = ?", Date.now() - 30 * 86400e3);

  /* a lead imported through the API and approved */
  const imp = await J("POST", "/api/leads/import", { clientId: c.id, records: [{ username: "joes_roofing", fullName: "Joe", biography: "Roofing in Austin, TX (512) 555-0134", followersCount: 900, postsCount: 30, private: false, businessCategoryName: "Roofing Service", latestPosts: [{ caption: "New roof", timestamp: new Date().toISOString() }] }] });
  await app.jobs.drain();
  const leadId = db.get("SELECT id FROM leads WHERE username = 'joes_roofing'").id;
  eq("import reached the pre-filter (Haiku off: waits for a person)", [imp.queued, db.get("SELECT gate, haiku_status FROM leads WHERE id = ?", leadId)], [1, { gate: "passed", haiku_status: "unavailable" }]);
  await J("POST", `/api/leads/${leadId}/approve`, {});

  /* fake Chrome around the real extension files */
  const store = { server: code1.s, token: code1.t, prefs: { startHour: 0, endHour: 24 }, lastIdentityAt: Date.now() };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let winId = 0; const ran = [], listeners = []; let alertOnNext = false;
  const pages = (msg) => {
    if (msg.type === "RUN_TASK") { ran.push(msg.task.type + ":" + (msg.task.username || "")); if (alertOnNext) return { ok: false, code: "blocked", trigger: "automation_warning" };
      return msg.task.type === "touch" ? { ok: true, code: "sent", detail: "liked a recent post" } : { ok: true, code: "sent" }; }
    return { ok: true };
  };
  const chrome = {
    storage: { local: { get: async (d) => { const keys = typeof d === "string" ? [d] : Array.isArray(d) ? d : Object.keys(d); const out = Array.isArray(d) || typeof d === "string" ? {} : { ...d }; for (const k of keys) if (k in store) out[k] = clone(store[k]); return out; }, set: async (o) => Object.assign(store, clone(o)) }, onChanged: { addListener() {} } },
    alarms: { get: async () => ({}), create() {}, onAlarm: { addListener() {} } },
    runtime: { getManifest: () => ({ version: "5.0.0" }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener: (fn) => listeners.push(fn) } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    windows: { create: async ({ url }) => ({ id: ++winId, tabs: [{ id: winId, url }] }), remove: async () => {} },
    tabs: { query: async () => [], update: async () => {}, onUpdated: { addListener(fn) { setTimeout(() => fn(winId, { status: "complete" }), 0); }, removeListener() {} }, sendMessage: async (id, msg) => pages(msg) }
  };
  const ctx = { chrome, fetch, console, setTimeout, clearTimeout, Date, Math, JSON, atob, btoa, URL, Promise, AbortController, Error, Object, Number, String, Array, parseInt, importScripts: (...f) => { for (const x of f) vm.runInContext(fs.readFileSync(EXT + x, "utf8"), ctx, { filename: x }); } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(EXT + "background.js", "utf8").replace("const sleep = (ms) => new Promise((r) => setTimeout(r, ms));", "const sleep = () => Promise.resolve();"), ctx, { filename: "background.js" });
  const run = (code) => vm.runInContext(code, ctx);
  const message = (msg) => new Promise((res) => { for (const l of listeners) { const r = l(msg, {}, res); if (r === true) return; } });
  const release = () => { for (const k of Object.keys(store.deferUntil || {})) store.deferUntil[k] = Date.now() - 5000; store.nextSendAt = 0; };

  /* 1. the connection */
  await run("tick()");
  eq("heartbeat reports version and sender mode", db.get("SELECT last_mode, last_version FROM accounts WHERE id = ?", a1.account.id), { last_mode: "sender", last_version: "5.0.0" });
  eq("the extension recorded a healthy connection for the popup", [store.conn.ok, store.conn.code, typeof store.conn.ms], [true, "ok", "number"]);
  eq("sender config has every field the extension reads", ["state", "reason", "expectedUsername", "warm", "sentToday", "capToday", "health", "quarantineUntil"].every((k) => k in store.status), true);

  const skipWarm = () => db.run("UPDATE tasks SET status = 'skipped' WHERE type = 'warm' AND status = 'pending'");   // daily warm-up sessions are covered elsewhere; keep them out of the way here
  skipWarm();

  /* 2. warm-touch first, then the opener, one sender only */
  release(); await run("tick()");
  eq("first task from the server is the warm-touch", ran, ["touch:joes_roofing"]);
  eq("touch result reached the server and held the opener 10-30 min", [db.get("SELECT status, result_code FROM tasks WHERE type = 'touch'").status, (db.get("SELECT not_before FROM tasks WHERE type = 'dm'").not_before - Date.now()) / 60000 > 9.5], ["done", true]);
  db.run("UPDATE tasks SET not_before = 0 WHERE type = 'dm'"); release(); await run("tick()");
  release(); await run("tick()");
  eq("then the opener is sent", [ran, db.get("SELECT status, result_code FROM tasks WHERE type = 'dm'"), db.get("SELECT stage FROM leads WHERE id = ?", leadId).stage], [["touch:joes_roofing", "dm:joes_roofing"], { status: "done", result_code: "sent" }, "contacted"]);
  eq("local counters updated", store.sentLocal.count, 1);

  /* 3. the extension's activity log shows up on the server's live feed */
  await wait(1800);
  const feed = db.all("SELECT text FROM activity WHERE kind = 'extension'").map((r) => r.text);
  eq("log lines are pushed to the dashboard", feed.some((t) => /Warm-touch @joes_roofing/.test(t)) && feed.some((t) => /dm @joes_roofing: sent/.test(t)), true);

  /* 4. the live link: a dashboard action reaches the extension without waiting for the minute alarm */
  const before = store.log.length; run("pulseLoop()");
  await until(() => store.pulseRev >= 0 && store.pulseAt > 0);
  await J("POST", "/api/leads/import", { clientId: c.id, records: [{ username: "second_roofer", biography: "Roofing Austin, TX (512) 555-0199", followersCount: 500, postsCount: 20, private: false, businessCategoryName: "Contractor", latestPosts: [{ caption: "x", timestamp: new Date().toISOString() }] }] });
  await app.jobs.drain();
  const l2 = db.get("SELECT id FROM leads WHERE username = 'second_roofer'").id;
  db.run("UPDATE tasks SET done_at = done_at - 600000 WHERE type = 'dm' AND status = 'done'");   // the server paces first messages 3 minutes apart
  const t0 = Date.now(); await J("POST", `/api/leads/${l2}/approve`, {});
  const woke = await until(() => store.log.some((l) => /Update from the dashboard/.test(l)), 3000);
  eq("approving a lead wakes the extension within seconds", [woke, Date.now() - t0 < 3000], [true, true]);
  const handed = await until(() => db.get("SELECT 1 AS x FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.type = 'touch' AND l.username = 'second_roofer'"), 3000);
  eq("and it asks the server for the new work straight away (warm-touch issued, opener pinned to this sender)", [handed, db.get("SELECT account_id FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.type = 'dm' AND l.username = 'second_roofer'").account_id], [true, a1.account.id]);

  /* 5. the safety switch: an Instagram warning quarantines the account and moves its queue */
  skipWarm(); release(); db.run("UPDATE tasks SET not_before = 0 WHERE type = 'dm' AND status = 'pending'");
  const dmPending = db.get("SELECT id FROM tasks WHERE type = 'dm' AND status = 'pending' AND account_id = ?", a1.account.id);
  const warn = await message({ type: "IG_WARNING", trigger: "automation_warning", url: "https://www.instagram.com/direct/inbox/" });
  await until(() => db.get("SELECT state FROM accounts WHERE id = ?", a1.account.id).state === "quarantined");
  const acc = db.get("SELECT state, cooldown_until, needs_reset FROM accounts WHERE id = ?", a1.account.id);
  eq("the warning is reported and the account is quarantined for 48 hours", [warn.ok, acc.state, acc.cooldown_until > Date.now() + 47 * 3600e3, acc.needs_reset], [true, "quarantined", true, 0]);
  eq("the extension stopped itself locally too", [store.lockUntil > Date.now() + 47 * 3600e3, /quarantined/.test(store.lockReason)], [true, true]);
  eq("the unsent opener now belongs to the other sender", db.get("SELECT account_id FROM tasks WHERE id = ?", dmPending.id).account_id, a2.account.id);
  ran.length = 0; await run("tick()");
  eq("a quarantined extension does no work", ran, []);
  const check = await message({ type: "PRE_SEND_CHECK", taskId: dmPending.id });
  eq("and refuses the pre-send check", check.allowed, false);

  /* 6. the second sender can take over, and cannot be handed the first one's work twice */
  const s2cfg = await (await fetch(BASE + "/ext/config?task=" + dmPending.id, { headers: { authorization: "Bearer " + code2.t } })).json();
  eq("sender two owns the moved message", s2cfg.taskOk, true);
  const s1cfg = await (await fetch(BASE + "/ext/config?task=" + dmPending.id, { headers: { authorization: "Bearer " + code1.t } })).json();
  eq("sender one no longer does", s1cfg.taskOk, false);

  /* 7. release from the dashboard lifts the local pause with no manual step in the extension */
  await J("POST", `/api/accounts/${a1.account.id}/release`);
  store.busyAt = 0; store.lastIdentityAt = Date.now(); await run("tick()");
  eq("released from the dashboard: the extension resumes", [store.lockUntil, store.status.state], [0, "active"]);

  /* 8. a warning seen in the middle of a task is reported with the right trigger */
  alertOnNext = true; release();
  db.run("UPDATE tasks SET not_before = 0 WHERE status = 'pending'");
  await J("POST", "/api/leads/import", { clientId: c.id, records: [{ username: "third_roofer", biography: "Roofing Austin, TX (512) 555-0177", followersCount: 700, postsCount: 20, private: false, businessCategoryName: "Contractor", latestPosts: [{ caption: "x", timestamp: new Date().toISOString() }] }] });
  await app.jobs.drain(); await J("POST", `/api/leads/${db.get("SELECT id FROM leads WHERE username = 'third_roofer'").id}/approve`, {});
  db.run("UPDATE tasks SET done_at = done_at - 600000 WHERE type = 'dm' AND status = 'done'");
  for (let i = 0; i < 2; i++) { skipWarm(); release(); store.busyAt = 0; await run("tick()"); }   // first tick receives the task and may hold it; the second acts on it
  await until(() => db.get("SELECT state FROM accounts WHERE id = ?", a1.account.id).state === "quarantined");
  if (process.env.DEBUG_E2E && db.get("SELECT state FROM accounts WHERE id = ?", a1.account.id).state !== "quarantined") console.log("DEBUG", store.log.slice(0, 8), store.status.state, store.status.sentToday, store.status.capToday, store.status.health, JSON.stringify(store.deferUntil), db.all("SELECT id,type,status,account_id,not_before-? AS nb,result_code FROM tasks", Date.now()));
  eq("a warning during a task also quarantines (trigger passed through)", db.get("SELECT state, reason FROM accounts WHERE id = ?", a1.account.id).state, "quarantined");
  eq("the event trail records it", db.get("SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind = 'quarantine'", a1.account.id).n >= 2, true);

  store.localKill = true;                                   // ends the live link loop
  await app.close();
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
