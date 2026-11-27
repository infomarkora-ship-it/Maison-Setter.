/* The real runner code driving a real Chromium through a fake Dolphin Anty, against a fake Instagram and the real server.
   Needs Playwright. RUNNER_DIR points at the runner folder (with a trailing slash). */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
let pw; for (const p of [process.env.PLAYWRIGHT, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(p); break; } catch { /* next */ } }
const RUNNER = process.env.RUNNER_DIR || "../../runner/";
if (!pw || !fs.existsSync(path.resolve(__dirname, RUNNER) + "/src/index.js")) { console.log("Skipped: needs Playwright and RUNNER_DIR (the runner folder)."); process.exit(0); }
const { createApp } = require("../src/server"), { createFakeIg } = require("./fake-ig"), { createFakeDolphin } = require("./fake-dolphin");
const { createRunner } = require(path.resolve(__dirname, RUNNER) + "/src/index.js"), { Human, mulberry32 } = require(path.resolve(__dirname, RUNNER) + "/src/human.js");
let bad = 0, total = 0;
const eq = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `\n   got  ${JSON.stringify(g)}\n   want ${JSON.stringify(w)}`); };
const yes = (n, v) => eq(n, !!v, true);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60_000, label = "") => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ } await wait(150); } if (label) console.log("   (timed out waiting for: " + label + ")"); return false; };
const DAYMS = 86_400_000;

(async () => {
  /* ---- fake Claude: bouncer, supervisor, vision ---- */
  const claude = await new Promise((r) => { const s = http.createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const b = JSON.parse(raw), sys = Array.isArray(b.system) ? b.system.map((x) => x.text).join("") : String(b.system), content = b.messages[0].content, user = Array.isArray(content) ? content.filter((x) => x.type === "text").map((x) => x.text).join("\n") : content;
    const J = (o) => JSON.stringify(o); let text = "{}";
    if (/bouncer for an Instagram outreach team/.test(sys)) text = J({ decision: "PASS", confidence_score: 92, entity_type: "REAL_SERVICE_BUSINESS", detected_niche: "roofing", service_location: "Austin, TX", disqualification_reason: null, personalization_hook: "your roofing work in Austin" });
    else if (/supervisor for an Instagram outreach team/.test(sys)) {
      const to = (/to: @(\S+)/.exec(user) || [])[1] || "";
      text = to === "edit_me" ? J({ verdict: "edit", risk: 40, reason: "Removed an invented guarantee.", edited_text: "Hey there! Love your work. Open to new customers?" })
        : to === "hold_me" ? J({ verdict: "hold", risk: 80, reason: "The lead asked if this is a bot.", edited_text: null }) : J({ verdict: "allow", risk: 8, reason: "Routine, no claims.", edited_text: null });
    } else if (/eyes of a browser automation runner/.test(sys)) {
      const task = (/task: (\w+)/.exec(user) || [])[1], who = (/expected username: @(\S+)/.exec(user) || [])[1] || "";
      text = task === "locate" ? J({ found: true, x: 490, y: 322, seen: "Send message", confidence: 90 }) : task === "classify" ? J({ screen: "profile", warning: false, trigger: null, dismiss_label: null, note: "a profile" })
        : task === "verify_thread" ? J({ correct_thread: who !== "wrong_chat", name_seen: who === "wrong_chat" ? "someone_else" : who, text_in_box: true, problems: who === "wrong_chat" ? "Header shows a different person." : "" }) : J({ visible: true, problems: "" });
    } else if (/draft the next Instagram DM reply/.test(sys)) text = J({ intent: "question", reply: "It depends on the roof. Want a quick call?", handoff: false });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 50, output_tokens: 40 } })); }); }); s.listen(0, "127.0.0.1", () => r(s)); });
  const app = createApp({ dbPath: ":memory:", adminPassword: "pw-pw-pw-pw", anthropicKey: "k", anthropicBase: `http://127.0.0.1:${claude.address().port}`, allowPrivateFetch: true, logger: { error() {} } });
  const port = await app.listen(0), BASE = `http://127.0.0.1:${port}`, { db, ctx } = app;
  db.setSetting("default_window", { start: 0, end: 24 });
  const cookie = (await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw-pw-pw-pw" }) })).headers.get("set-cookie").split(";")[0];
  const J = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json" }, body: m === "GET" ? undefined : JSON.stringify(b ?? {}) })).json();

  const fakeIg = createFakeIg(), igPort = await fakeIg.listen(), IG = `http://127.0.0.1:${igPort}`;
  const dolphin = createFakeDolphin(pw.chromium), dPort = await dolphin.listen();

  /* ---- workspace ---- */
  const camp = await J("POST", "/api/clients", { name: "Acme", offer: "Free roof inspections.", target: "roofers", bookingLink: "https://book.example/x", sendStart: 0, sendEnd: 24, followPool: "niche_page_one\nniche_page_two", supervision: "supervised" });
  const acc = (await J("POST", "/api/accounts", { label: "Acme sender 1", igUsername: "acme_one", clientId: camp.id, igAge: "established" })).account;
  db.run("UPDATE accounts SET warm_started_at = ?", Date.now() - 40 * DAYMS);
  eq("a runner account needs its Dolphin profile first", (await fetch(BASE + `/api/accounts/${acc.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ driver: "runner" }) })).status, 400);
  eq("switching to the runner with a profile works", (await J("PATCH", `/api/accounts/${acc.id}`, { driver: "runner", dolphinProfileId: "p1" })).driver, "runner");
  const prof = (u, o = {}) => ({ username: u, fullName: u, biography: "Roofing in Austin, TX (512) 555-0134", followersCount: 800, postsCount: 30, private: false, businessCategoryName: "Roofing Service", latestPosts: [{ caption: "New roof", timestamp: new Date().toISOString() }], ...o });
  const names = ["joes_roofing", "edit_me", "hold_me", "stuck_user", "wrong_chat", "ring_user", "warn_user", "ip_check"];
  await J("POST", "/api/leads/import", { clientId: camp.id, records: names.map((n) => prof(n)) }); await app.jobs.drain();
  const lead = (u) => db.get("SELECT * FROM leads WHERE username = ?", u);
  eq("all leads passed the pre-filter and the bouncer", names.every((n) => lead(n).entity_classification === "REAL_BUSINESS"), true);
  eq("the extension is no longer given this account's work", (await (await fetch(BASE + "/ext/tasks/next", { headers: { authorization: "Bearer " + JSON.parse(Buffer.from((await J("POST", `/api/accounts/${acc.id}/rotate`)).pairingCode.slice(4), "base64url")).t } })).json()).task, null);

  /* ---- movement: the same code on a real page ---- */
  { const b = await pw.chromium.launch(), p = await b.newPage({ viewport: { width: 1280, height: 800 } }); await p.goto(IG + "/"); const h = new Human(p, { rand: mulberry32(11), timeScale: 1 });
    await p.mouse.move(60, 60); h.pos = { x: 60, y: 60 }; await h.moveTo(1000, 600, { overshoot: false }); await wait(900);
    const pts = fakeIg.events.filter((e) => e.t === "mm").flatMap((e) => e.pts).sort((a, c) => a[2] - c[2]);
    const run = pts.filter((q) => q[0] > 50), x0 = run[0], x1 = run[run.length - 1], dx = x1[0] - x0[0], dy = x1[1] - x0[1], len = Math.hypot(dx, dy);
    const dev = Math.max(...run.map((q) => Math.abs((q[0] - x0[0]) * dy - (q[1] - x0[1]) * dx) / len)), dts = run.slice(1).map((q, i) => (q[2] - run[i][2] > 0 ? Math.hypot(q[0] - run[i][0], q[1] - run[i][1]) / (q[2] - run[i][2]) : null)).filter((d) => d != null), mean = dts.reduce((a, c) => a + c, 0) / dts.length, sd = Math.sqrt(dts.reduce((a, c) => a + (c - mean) ** 2, 0) / dts.length);
    yes(`the mouse takes a curved path, not a straight line (max ${Math.round(dev)} px off the straight line over ${Math.round(len)} px)`, dev > 12 && run.length > 15);
    yes(`and moves at uneven speed (speed varies by ${Math.round((sd / mean) * 100)}% between steps)`, sd / mean > 0.3);
    await b.close(); fakeIg.events.length = 0; }

  /* ---- start the runner ---- */
  const logs = []; const stateFile = path.join(os.tmpdir(), `runner-state-${Date.now()}.json`);
  const cfg = { server: BASE, runnerToken: ctx.runner.token(), dolphin: { localApi: `http://127.0.0.1:${dPort}`, token: "dolphin-secret" }, igBase: IG, proxyCheckUrl: IG + "/_ip", acceptIpChange: false, maxProfiles: 1, verifyFirstMessages: true, useVision: true, timeScale: 0.01, stateFile };
  eq("a wrong runner token is refused", (await fetch(BASE + "/runner/accounts", { headers: { authorization: "Bearer nope" } })).status, 401);
  const runner = createRunner(cfg, { playwright: pw, onLog: (t, l) => { logs.push(`${l}: ${t}`); if (process.env.DEBUG_RUNNER) console.log("   [runner]", l, t); } }); await runner.start();
  const act = () => db.all("SELECT text FROM activity").map((r) => r.text).join("\n");

  eq("Dolphin was logged in with the token", dolphin.calls.includes("POST /v1.0/auth/login-with-token"), true);
  // The server schedules each day's warm-up sessions at random times through the day. Make them due now.
  yes("the server queued the day's warm-up sessions", await until(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE type = 'warm'").n >= 1, 30_000, "warm tasks"));
  db.run("UPDATE tasks SET not_before = 0 WHERE type = 'warm' AND status = 'pending'");

  /* ---- warm-up: browsing and a couple of follows from the pool ---- */
  yes("a warm-up session ran", await until(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE type = 'warm' AND status = 'done'").n >= 1, 90_000, "warm-up"));
  const followed = db.all("SELECT username FROM follows").map((r) => r.username).sort();
  yes("it followed accounts from the campaign's pool and recorded them", followed.length >= 1 && followed.every((u) => ["niche_page_one", "niche_page_two"].includes(u)));
  eq("the follows really happened in the browser, and never the same account twice", [fakeIg.events.filter((e) => e.t === "follow").length === followed.length, new Set(followed).size === followed.length], [true, true]);
  db.run("UPDATE tasks SET status = 'skipped' WHERE type = 'warm' AND status = 'pending'");

  eq("the profile was opened and closed by Dolphin, and its proxy address recorded", [dolphin.calls.some((c) => /start$/.test(c)), dolphin.calls.some((c) => /stop$/.test(c)), dolphin.running.size === 0, db.get("SELECT proxy_ip FROM accounts WHERE id = ?", acc.id).proxy_ip], [true, true, true, "203.0.113.10"]);
  const approve = (u) => J("POST", `/api/leads/${lead(u).id}/approve`, {});
  const dm = (u) => db.get("SELECT * FROM tasks WHERE lead_id = ? AND type = 'dm'", lead(u).id), touchOf = (u) => db.get("SELECT * FROM tasks WHERE lead_id = ? AND type = 'touch'", lead(u).id);
  const ageDms = () => db.run("UPDATE tasks SET done_at = done_at - 900000 WHERE type IN ('dm','followup') AND status = 'done'");
  const releaseDm = (u) => db.run("UPDATE tasks SET not_before = 0 WHERE lead_id = ? AND type = 'dm' AND status = 'pending'", lead(u).id);
  const settle = async () => { await until(() => dolphin.running.size === 0, 30_000); await wait(1200); };     // let the runner finish and report before the next lead
  const flow = async (u, { dmWait = true, touchWait = 60_000 } = {}) => { await settle(); ageDms(); await approve(u); const t = await until(() => touchOf(u)?.status === "done" || touchOf(u)?.status === "failed", touchWait, `touch ${u}`); if (!t && process.env.DEBUG_RUNNER) console.log("   DEBUG", u, db.all("SELECT id,type,status,account_id,not_before-? AS nb FROM tasks WHERE lead_id = ?", Date.now(), lead(u).id), db.get("SELECT state FROM accounts WHERE id = ?", acc.id), JSON.stringify(ctx.scheduler.nextTask(db.get("SELECT * FROM accounts WHERE id = ?", acc.id), [], "runner"))); if (dmWait) releaseDm(u); return t; };
  const sentTo = (u) => fakeIg.events.filter((e) => e.t === "dm" && e.to === u);

  /* ---- a normal first message: touch, supervisor, verified chat, human typing ---- */
  await flow("joes_roofing");
  yes("before the message, the runner liked a recent post on their profile (no story to view)", fakeIg.events.some((e) => e.t === "like") && fakeIg.events.some((e) => e.t === "open_thread" ? false : true));
  yes("the first message was sent", await until(() => dm("joes_roofing").status === "done", 60_000, "dm joes"));
  eq("exactly the approved text was typed into the right chat", [sentTo("joes_roofing").length, sentTo("joes_roofing")[0]?.text], [1, lead("joes_roofing").opener]);
  eq("the server recorded it and the lead moved on", [dm("joes_roofing").result_code, lead("joes_roofing").stage], ["sent", "contacted"]);
  yes("the supervisor logged the check (allowed, by AI) and the first message got a screenshot check", db.get("SELECT COUNT(*) AS n FROM supervisor_log WHERE kind = 'dm' AND verdict = 'allow' AND by = 'ai'").n >= 1 && db.get("SELECT COUNT(*) AS n FROM supervisor_log WHERE kind = 'vision'").n >= 1);

  /* ---- inbox: now that we have messaged them, the runner reads Instagram's own JSON and the server records their reply ---- */
  yes("the runner reads the inbox and the server records the lead's reply", await until(() => db.get("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'").n >= 1, 60_000, "inbox"));
  eq("and the lead is marked as replied", lead("joes_roofing").stage, "replied");

  /* ---- the supervisor edits a message ---- */
  ageDms(); await approve("edit_me"); await until(() => touchOf("edit_me")?.status === "done", 60_000); db.run("UPDATE tasks SET text = ? WHERE lead_id = ? AND type = 'dm'", "We guarantee the lowest price in Texas!", lead("edit_me").id); releaseDm("edit_me");
  yes("the edited message was sent instead of the original", await until(() => sentTo("edit_me").length === 1, 60_000, "edit"));
  eq("what was typed is the supervisor's version, logged as an edit", [sentTo("edit_me")[0].text, db.get("SELECT verdict, before_text AS b FROM supervisor_log WHERE lead_id = ? AND kind = 'dm'", lead("edit_me").id).verdict], ["Hey there! Love your work. Open to new customers?", "edit"]);

  /* ---- the supervisor holds one for a human ---- */
  await flow("hold_me");
  yes("the supervisor held it", await until(() => dm("hold_me").status === "held", 60_000, "hold"));
  eq("nothing was sent while it waits", sentTo("hold_me").length, 0);
  const heldLog = db.get("SELECT id FROM supervisor_log WHERE lead_id = ? AND status = 'held'", lead("hold_me").id);
  ctx.supervisor.approve(heldLog.id, { text: "Hey there! Happy to help. Want a quick call?" });
  yes("after you approve it, it goes out with your wording", await until(() => sentTo("hold_me").length === 1, 60_000, "approved hold") && sentTo("hold_me")[0].text === "Hey there! Happy to help. Want a quick call?");

  /* ---- stuck: the Message button isn't where the script expects, so it pauses, looks again, then asks the AI ---- */
  const visionBefore = db.get("SELECT COUNT(*) AS n FROM supervisor_log WHERE kind = 'vision'").n;
  await flow("stuck_user");
  yes("it still sent the message", await until(() => sentTo("stuck_user").length === 1, 90_000, "stuck dm"));
  yes("by pausing, looking again, then asking the AI to find the button", act().includes("Can't see the Message button") && act().includes("The AI found the Message button") && db.get("SELECT COUNT(*) AS n FROM supervisor_log WHERE kind = 'vision'").n > visionBefore);

  /* ---- wrong chat: the AI looks at the screen before Send and stops it ---- */
  await flow("wrong_chat");
  yes("the AI caught the wrong chat and nothing was sent", await until(() => dm("wrong_chat").status === "failed", 60_000, "wrong chat") && sentTo("wrong_chat").length === 0);
  eq("the failure says why", dm("wrong_chat").result_code, "thread_mismatch");

  /* ---- story view ---- */
  await flow("ring_user", { dmWait: false });
  yes("when there's a story the runner watches it instead of liking", await until(() => fakeIg.events.some((e) => e.t === "story_viewed"), 30_000) && /viewed their story/.test(act()));
  db.run("UPDATE tasks SET status = 'skipped' WHERE lead_id = ? AND type = 'dm'", lead("ring_user").id);

  /* ---- a changed proxy address stops everything ---- */
  fakeIg.setIp("198.51.100.77"); const likesBefore = fakeIg.events.filter((e) => e.t === "like").length;
  await flow("ip_check", { dmWait: false, touchWait: 6000 });
  yes("if the profile's proxy address changed, it refuses to run", await until(() => /internet address changed from 203\.0\.113\.10 to 198\.51\.100\.77/.test(act()), 40_000, "ip change"));
  eq("and did nothing on Instagram", fakeIg.events.filter((e) => e.t === "like").length, likesBefore);
  fakeIg.setIp("203.0.113.10");
  db.run("UPDATE tasks SET status = 'skipped' WHERE lead_id = ? AND status = 'pending'", lead("ip_check").id);

  /* ---- a warning screen: quarantine from the runner ---- */
  ageDms(); db.run("UPDATE accounts SET state = 'active', cooldown_until = 0 WHERE id = ?", acc.id);
  await approve("warn_user");
  yes("when Instagram shows 'Try Again Later' the runner quarantines the account", await until(() => db.get("SELECT state FROM accounts WHERE id = ?", acc.id).state === "quarantined", 90_000, "warning"));
  eq("with the reason and trigger recorded", [db.get("SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind = 'quarantine'", acc.id).n >= 1, /quarantined/i.test(act())], [true, true]);

  /* ---- shutting down ---- */
  await runner.stop(); await wait(600);
  yes("the dashboard shows the runner as seen", db.setting("runner_seen_at", 0) > Date.now() - 120_000);
  await dolphin.close(); await fakeIg.close(); claude.close(); await app.close();
  try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`);
  if (bad && process.env.DEBUG_RUNNER) console.log(logs.slice(-40).join("\n"));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
