/* Drives the real dashboard in a real Chromium: every page renders with no console or security-policy errors,
   the main buttons work, hostile text from a lead never becomes an element, and live updates arrive without a reload.
   Needs Playwright (set PLAYWRIGHT to its folder). Set SHOTS=/some/dir to save screenshots. */
const http = require("node:http"), fs = require("node:fs");
const { createApp } = require("../src/server");
let pw; for (const p of [process.env.PLAYWRIGHT, "playwright", "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) { try { pw = require(p); break; } catch { /* next */ } }
if (!pw) { console.log("Skipped: Playwright is not installed. Set PLAYWRIGHT to its folder to run the browser tests."); process.exit(0); }
let bad = 0, total = 0;
const eq = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `\n   got  ${JSON.stringify(g)}\n   want ${JSON.stringify(w)}`); };
const yes = (n, v) => eq(n, !!v, true);
const DAYMS = 86_400_000, SHOTS = process.env.SHOTS;

(async () => {
  /* ---- fake Claude so leads get judged ---- */
  const claude = await new Promise((r) => { const s = http.createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const b = JSON.parse(raw), u = (/username: @(\S+)/.exec(b.messages[0].content) || [])[1] || "", J = (o) => JSON.stringify({ disqualification_reason: null, personalization_hook: null, service_location: null, ...o });
    let text = "{}";
    if (/bouncer/.test(JSON.stringify(b.system))) text = /agency|growth/.test(u) ? J({ decision: "REJECT", confidence_score: 94, entity_type: "MARKETING_AGENCY", detected_niche: "lead generation", disqualification_reason: "Sells lead generation to contractors." })
      : /coach|guru/.test(u) ? J({ decision: "REJECT", confidence_score: 92, entity_type: "COURSE_CREATOR", detected_niche: "coaching", disqualification_reason: "Sells coaching." })
      : J({ decision: "PASS", confidence_score: 70 + (u.length * 7) % 29, entity_type: "REAL_SERVICE_BUSINESS", detected_niche: /spa/.test(u) ? "med spa" : /dent/.test(u) ? "dentistry" : "roofing", service_location: /spa/.test(u) ? "Toronto, ON" : "Austin, TX", personalization_hook: /spa/.test(u) ? "your skin treatments at the Toronto clinic" : "your shingle roof replacements around Austin" });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 60, output_tokens: 90, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 } })); }); }); s.listen(0, "127.0.0.1", () => r(s)); });
  const app = createApp({ dbPath: process.env.TEST_DB_PATH || ":memory:", adminPassword: "demo-pass-123", anthropicKey: "k", anthropicBase: `http://127.0.0.1:${claude.address().port}`, allowPrivateFetch: true, logger: { error() {} } });
  const port = await app.listen(0), BASE = `http://127.0.0.1:${port}`, { db } = app;
  db.setSetting("default_window", { start: 0, end: 24 });
  const login = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "demo-pass-123" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const J = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json" }, body: m === "GET" ? undefined : JSON.stringify(b ?? {}) }); return r.json(); };
  const E = async (m, p, tok, b) => (await fetch(BASE + p, { method: m, headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: m === "GET" ? undefined : JSON.stringify(b ?? {}) })).json();

  /* ---- seed a believable workspace ---- */
  const c1 = await J("POST", "/api/clients", { name: "Acme Roofing", offer: "Free roof inspections and fair quotes for homeowners.", target: "Local roofers and exterior contractors in Texas", bookingLink: "https://cal.com/acme/inspection", sendStart: 0, sendEnd: 24, tz: "America/Toronto" });
  const c2 = await J("POST", "/api/clients", { name: "Glow Med Spa Growth", offer: "Booking system for med spas.", target: "Med spas and aesthetic clinics", sendStart: 0, sendEnd: 24, allowAgencies: true });
  const mk = async (label, user, client, age) => { const r = await J("POST", "/api/accounts", { label, igUsername: user, clientId: client, igAge: age }); return { id: r.account.id, tok: JSON.parse(Buffer.from(r.pairingCode.slice(4), "base64url")).t }; };
  const s1 = await mk("Acme sender 1", "acme_one", c1.id, "established"), s2 = await mk("Acme sender 2", "acme_two", c1.id, "established"), s3 = await mk("Glow sender", "glow_sender", c2.id, "young");
  db.run("UPDATE accounts SET warm_started_at = ?, warm_done = 7, warm_cursor = 40, warm_holds = 0, warm_missed = 33 WHERE id IN (?, ?)", Date.now() - 40 * DAYMS, s1.id, s2.id);   // earned: 7 clean program days
  db.run("UPDATE accounts SET warm_started_at = ?, warm_done = 2, warm_cursor = 3, warm_holds = 0, warm_missed = 1 WHERE id = ?", Date.now() - 3 * DAYMS, s3.id);   // young account, day 3 of 14
  await E("POST", "/ext/heartbeat", s1.tok, { version: "5.0.0", loggedInAs: "acme_one", mode: "sender" }); await E("POST", "/ext/heartbeat", s3.tok, { version: "5.0.0", loggedInAs: "glow_sender", mode: "sender" });
  await E("POST", "/ext/quarantine", s2.tok, { trigger: "rate_limit" });
  const now = Date.now(), iso = (d) => new Date(now - d * DAYMS).toISOString();
  const prof = (u, o = {}) => ({ username: u, fullName: u.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), biography: "Licensed & insured. Free estimates. Austin, TX (512) 555-0134", followersCount: 600 + (u.length * 131) % 4000, postsCount: 40, private: false, businessCategoryName: "Roofing Service", externalUrl: "https://" + u.replace(/_/g, "") + ".com", latestPosts: [{ caption: "Finished another roof this week.", timestamp: iso(2) }, { caption: "Storm damage repair, same day.", timestamp: iso(6) }], ...o });
  const good = ["joes_roofing", "lone_star_roofs", "capital_exteriors", "summit_roof_co", "blue_ridge_roofing", "oak_city_gutters", "prime_shingles"].map((u) => prof(u));
  const hostile = prof("evil_bio_roofing", { biography: "<img src=x onerror=\"window.__pwn=1\"> Roofing (512) 555-0111 <script>window.__pwn=1</script>", fullName: "<b>Bold</b> Name" });
  const junk = [prof("private_roofer", { private: true }), prof("coach_mike", { businessCategoryName: "Coach" }), prof("tiny_crew", { followersCount: 60 }), prof("guru_links", { externalUrl: "https://stan.store/guru" }), prof("smma_king", { biography: "smma owner, free training" }), prof("quiet_roofer", { latestPosts: [{ caption: "old", timestamp: iso(120) }] }), prof("no_info_page", { biography: "Roofing", externalUrl: "" })];
  const ads = [{ ig_username: "pro_crew_growth", page_name: "Pro Crew Growth", ad_copy: "Attention Concrete Contractors! We fill your calendar.", ad_landing_url: "https://go.proagency.com/x", niche: "concrete" }, { ig_username: "dental_agency_growth", page_name: "Dental Growth Agency", ad_copy: "Attention Dentists! 30 new patients a month.", ad_landing_url: "https://dentalgrowth.com/book" }];
  await J("POST", "/api/leads/import", { clientId: c1.id, records: [...good, hostile, ...junk] });
  await J("POST", "/api/leads/import-ads", { clientId: c2.id, records: ads });
  await J("POST", "/api/leads/import", { clientId: c2.id, records: [prof("glow_skin_spa", { businessCategoryName: "Medical Spa", biography: "Medical spa, Toronto, ON. Book online (416) 555-0100" }), prof("bloom_aesthetics_spa", { businessCategoryName: "Medical Spa", biography: "Aesthetic clinic, Toronto ON (416) 555-0188" })] });
  await app.jobs.drain();
  const id = (u) => db.get("SELECT id FROM leads WHERE username = ?", u).id;
  for (const u of ["joes_roofing", "lone_star_roofs", "capital_exteriors", "summit_roof_co"]) await J("POST", `/api/leads/${id(u)}/approve`, {});
  await J("PATCH", `/api/leads/${id("joes_roofing")}`, { stage: "contacted" }); await J("PATCH", `/api/leads/${id("lone_star_roofs")}`, { stage: "interested" }); await J("PATCH", `/api/leads/${id("capital_exteriors")}`, { stage: "booked" });
  const nowS = Math.floor(now / 1000);
  for (const [u, msgs] of [["joes_roofing", [["out", "Hey Joe! Came across your page and love your shingle roof replacements around Austin. Are you open to new customers right now?", -9000], ["in", "Hey, thanks! How much do you charge for the inspections?", -300]]], ["lone_star_roofs", [["out", "Hey! Love your shingle roof work. Open to new customers?", -50000], ["in", "Yes actually, send me details", -40000]]]])
    for (const [dir, text, off] of msgs) db.run("INSERT INTO messages(lead_id, direction, text, ts) VALUES(?,?,?,?)", id(u), dir, text, nowS + off);
  db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, status, text, not_before, created_at, inbound_at) VALUES(?,?,?,?,?,?,?,?,?)", s1.id, c1.id, id("joes_roofing"), "reply", "draft", "Great question! It depends on the roof, but the inspection itself is free. Want to grab a time? https://cal.com/acme/inspection", 0, now, now - 300000);
  for (let i = 0; i < 9; i++) db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, status, result_code, not_before, created_at, done_at) VALUES(?,?,?,?,?,?,?,?,?)", s1.id, c1.id, id("joes_roofing"), "dm", "done", "sent", 0, now, now - i * 50 * 60000 - 600000);
  db.run("UPDATE leads SET needs_human = 1 WHERE id = ?", id("joes_roofing"));

  /* ---- the browser ---- */
  const errors = [];
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: false });
  ctx.on("page", (p) => { p.on("pageerror", (e) => errors.push("pageerror: " + e.message)); p.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/favicon|EventSource|Failed to load resource: the server responded with a status of 40[014]/.test(m.text())) errors.push(m.type() + ": " + m.text()); }); });
  const page = await ctx.newPage(); page.on("dialog", (d) => d.accept());
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); } };
  const goto = async (route) => { await page.evaluate((r) => { location.hash = "#/" + r; }, route); await page.waitForTimeout(600); };

  await page.goto(BASE + "/");
  yes("login page is shown to a visitor", await page.locator("#loginForm").isVisible());
  await shot("00-login");
  await page.fill("#pw", "wrong-password"); await page.click("#loginForm button[type=submit]"); await page.waitForTimeout(300);
  eq("a wrong password shows a message", await page.locator("#loginMsg").innerText(), "That password is not right.");
  await page.fill("#pw", "demo-pass-123"); await page.click("#loginForm button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#liveText")?.textContent === "Live", null, { timeout: 5000 }).catch(() => {});
  eq("the live link connects", await page.locator("#liveText").innerText(), "Live");
  eq("the brand is Maison Setter", (await page.locator(".brand-name").first().innerText()), "Maison Setter");
  await page.waitForTimeout(700);

  /* overview — the command center */
  eq("overview is the first page", await page.locator("#pageTitle").innerText(), "Overview");
  yes("overview shows the KPI tiles with previous-period deltas", (await page.locator(".kpi").count()) === 5);
  yes("overview shows quarantined-account alert", (await page.locator(".alert.bad").allInnerTexts()).some((t) => /quarantined/i.test(t)));
  yes("overview shows today's priorities", /Today's priorities/.test(await page.locator("#main").innerText()));
  yes("overview shows performance insights", /Performance insights/.test(await page.locator("#main").innerText()));
  yes("overview shows each sender with a sent-today counter", (await page.locator("#main").innerText()).match(/\d+ \/ \d+ sent today/));
  yes("overview shows the growth timeline chart", (await page.locator("svg.chart-svg").count()) >= 1);
  await shot("01-overview");

  /* global search */
  await page.fill("#globalSearch", "joes"); await page.waitForTimeout(600);
  yes("global search finds a lead", /joes_roofing/.test(await page.locator("#searchPop").innerText()));
  await page.fill("#globalSearch", "");

  /* notifications bell */
  await page.click("#bellBtn"); await page.waitForTimeout(500);
  yes("the notification center opens", await page.locator("#notifPop").isVisible());
  await page.keyboard.press("Escape"); await page.click("#pageTitle");

  /* review */
  await goto("review");
  eq("review page title", await page.locator("#pageTitle").innerText(), "Review");
  const tabs = await page.locator('[role="tab"]').allInnerTexts();
  yes("review has Real businesses, Agencies and Needs a look tabs", tabs.length === 3 && /Real businesses/.test(tabs[0]) && /Agencies/.test(tabs[1]) && /Needs a look/.test(tabs[2]));
  const cards0 = await page.locator("article.lead").count();
  yes("review lists leads that passed", cards0 >= 3);
  eq("hostile bio never became an element or ran", [await page.locator("#main img").count(), await page.evaluate(() => window.__pwn === undefined)], [0, true]);
  await shot("02-review");
  const first = page.locator("article.lead").first(), who = (await first.locator("a.user").innerText()).replace("@", "");
  await first.locator("button", { hasText: "Approve and queue" }).click(); await page.waitForTimeout(700);
  eq("approving removes the card and queues the lead", [await page.locator("article.lead").count(), db.get("SELECT review FROM leads WHERE username = ?", who).review], [cards0 - 1, "approved"]);

  /* live update on the Review page */
  await page.locator('[role="tab"]', { hasText: "Real businesses" }).click();
  const before = await page.locator("article.lead").count();
  await J("POST", "/api/leads/import", { clientId: c1.id, records: [prof("fresh_arrival_roofing")] }); await app.jobs.drain();
  await page.waitForFunction((n) => document.querySelectorAll("article.lead").length > n || document.querySelector(".banner.good"), before, { timeout: 5000 }).catch(() => {});
  yes("a lead imported elsewhere appears live, or announces itself, with no reload", (await page.locator("article.lead").count()) > before || (await page.locator(".banner.good").count()) > 0);

  /* pipeline */
  await goto("pipeline"); await shot("03-pipeline");
  yes("pipeline has columns and cards", (await page.locator(".col").count()) >= 6 && (await page.locator(".pcard").count()) >= 3);
  await page.locator(".pcard", { hasText: "joes_roofing" }).click(); await page.waitForSelector("#drawer .body");
  yes("a lead opens a drawer with its conversation and score breakdown", (await page.locator("#drawer .bubble").count()) === 2);
  yes("the drawer explains the lead score", /Why this score/.test(await page.locator("#drawer").innerText()) || (await page.locator("#drawer").innerText()).includes("Rescore"));
  await shot("04-lead-drawer"); await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  yes("Escape closes the drawer", await page.locator("#drawerWrap").isHidden());

  /* leads CRM */
  await goto("leads");
  yes("the leads table shows pipeline, score and value columns", /pipeline/i.test(await page.locator("#main").innerText()) && /score/i.test(await page.locator("#main").innerText()));
  await shot("05-leads");

  /* inbox — unified conversations */
  await goto("inbox"); await page.waitForTimeout(400);
  yes("inbox auto-opens the conversation that needs attention first", (await page.locator(".convo-pane h3").innerText()).includes("joes_roofing"));
  yes("inbox shows the draft, editable, next to the conversation", (await page.locator("main textarea").first().inputValue()).includes("Great question!") && (await page.locator("main .bubble").count()) >= 2);
  yes("inbox has the lead context panel", /pipeline/i.test(await page.locator(".ctx-pane").innerText()) && /attribution/i.test(await page.locator(".ctx-pane").innerText()));
  await shot("06-inbox");

  /* AI supervisor */
  const nowMs = Date.now(), ins = (verdict, risk, reason, before2, after, status, lead) => db.run("INSERT INTO supervisor_log(at, account_id, task_id, lead_id, kind, verdict, risk, reason, by, before_text, after_text, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", nowMs - Math.floor(Math.random() * 3600e3), s1.id, null, id(lead), "dm", verdict, risk, reason, "ai", before2, after, status);
  db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, status, text, not_before, created_at) VALUES(?,?,?,?,?,?,?,?)", s1.id, c1.id, id("prime_shingles"), "reply", "held", "Great, let's chat!", 0, nowMs);
  const heldTask = db.get("SELECT MAX(id) AS id FROM tasks").id;
  db.run("INSERT INTO supervisor_log(at, account_id, task_id, lead_id, kind, verdict, risk, reason, by, before_text, after_text, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", nowMs, s1.id, heldTask, id("prime_shingles"), "reply", "hold", 82, "The lead asked if this is a bot; a person should answer.", "ai", "Great, let's chat!", "Great, let's chat!", "held");
  ins("edit", 45, "Removed an invented guarantee.", "We guarantee the lowest price in Texas!", "It depends on the roof, so the inspection comes first. Want to grab a time?", "final", "joes_roofing");
  ins("block", 95, "Supervisor: The lead asked to stop.", "Just bumping this!", "Just bumping this!", "final", "lone_star_roofs"); ins("allow", 8, "Short, specific, no claims.", "Hey there! Love your roofing work.", "Hey there! Love your roofing work.", "final", "capital_exteriors");
  await goto("supervisor");
  const sup = await page.locator("#main").innerText();
  yes("the supervisor page shows what needs you, what it edited and what it blocked", /Waiting for you/.test(sup) && /Edited by the AI/.test(sup) && /Blocked/.test(sup) && /invented guarantee/.test(sup) && /asked to stop/.test(sup));
  yes("the held command is editable text next to its reason", (await page.locator("main textarea").first().inputValue()).includes("let's chat") && /asked if this is a bot/.test(sup));
  await shot("18-supervisor");
  eq("each campaign has a Watch / Supervised / Autopilot choice, set from the server", [await page.locator('input[name="mode' + c1.id + '"]:checked').getAttribute("value")], ["supervised"]);
  await page.locator("label", { hasText: "Autopilot" }).first().click(); await page.waitForTimeout(500);
  eq("choosing Autopilot saves at once", db.get("SELECT supervision FROM clients WHERE id = ?", c1.id).supervision, "autopilot");
  await page.locator("label", { hasText: "Supervised" }).first().click(); await page.waitForTimeout(400);
  await page.locator("main textarea").first().fill("Happy to help! Want a quick call tomorrow?"); await page.locator("button", { hasText: "Approve and send" }).first().click(); await page.waitForTimeout(700);
  eq("approving a held command (with your edit) releases it to the runner", [db.get("SELECT status, sup_ok, text FROM tasks WHERE id = ?", heldTask).status, db.get("SELECT sup_ok FROM tasks WHERE id = ?", heldTask).sup_ok, db.get("SELECT text FROM tasks WHERE id = ?", heldTask).text], ["pending", 1, "Happy to help! Want a quick call tomorrow?"]);

  /* runner page */
  await goto("runner");
  const rn = await page.locator("#main").innerText();
  yes("the runner page says it has never connected, hides the token, and lists the accounts", /Never connected/.test(rn) && /•{10}/.test(rn) && /Acme sender 1/.test(rn) && /Glow sender/.test(rn));
  await shot("19-runner");
  const glowRow = page.locator("tr", { hasText: "Glow sender" });
  await glowRow.locator("select").selectOption("runner"); await glowRow.locator("button", { hasText: "Save" }).click(); await page.waitForTimeout(500);
  yes("a runner account can't be saved without its Dolphin profile", /Dolphin profile ID/.test(await page.locator("#toasts").innerText()) && db.get("SELECT driver FROM accounts WHERE id = ?", s3.id).driver === "extension");
  await page.locator("tr", { hasText: "Glow sender" }).locator('input[type="text"]').fill("987654321"); await page.locator("tr", { hasText: "Glow sender" }).locator("button", { hasText: "Save" }).click(); await page.waitForTimeout(600);
  eq("with the profile ID it switches to the runner", [db.get("SELECT driver FROM accounts WHERE id = ?", s3.id).driver, db.get("SELECT dolphin_profile_id FROM accounts WHERE id = ?", s3.id).dolphin_profile_id], ["runner", "987654321"]);
  await page.click("button:has-text('Show token')"); yes("the token can be revealed", /runner_/.test(await page.locator("pre.code").first().innerText()));

  /* quality */
  await goto("quality");
  const q2 = await page.locator("#main").innerText();
  yes("quality shows the three required counts and reasons", /Passed real businesses/i.test(q2) && /Filtered agencies/i.test(q2) && /Rejected spam/i.test(q2) && /Disqualification reasons/i.test(q2) && /Private account/.test(q2));
  yes("quality shows the AI checker and the cache", /Prompt cache hit rate/.test(q2) && /claude-haiku-5-5/.test(q2));
  await shot("07-quality");

  /* appointments */
  await goto("appointments");
  await page.click("button:has-text('New appointment')"); await page.waitForSelector("#apT");
  await page.fill("#apT", "Call with @joes_roofing");
  const soon = new Date(Date.now() + 26 * 3600 * 1000);
  await page.fill("#apD", new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await page.click("#drawer button:has-text('Create appointment')"); await page.waitForTimeout(700);
  eq("an appointment can be created from the dashboard", db.get("SELECT COUNT(*) AS n FROM appointments WHERE title = 'Call with @joes_roofing'").n, 1);
  const apptRow = page.locator("tr", { hasText: "Call with @joes_roofing" });
  await apptRow.locator("button", { hasText: "Mark completed" }).click(); await page.waitForTimeout(600);
  eq("marking it completed updates the status", db.get("SELECT status FROM appointments WHERE title = 'Call with @joes_roofing'").status, "completed");
  yes("appointments show the KPI row", /booking pending|no-shows/i.test(await page.locator("#main").innerText()));
  await shot("08-appointments");

  /* opportunities + alerts */
  await J("PATCH", `/api/leads/${id("lone_star_roofs")}`, { stage: "interested" });
  await J("POST", "/api/opportunities", { leadId: id("capital_exteriors"), value: 4500 });
  await goto("opportunities"); await page.waitForTimeout(600);
  const opp = await page.locator("#main").innerText();
  yes("the recovery center shows alerts and the pipeline", /Needs action/.test(opp) && /Opportunities/.test(opp) && /\$4,500/.test(opp));
  await shot("09-opportunities");
  const oppRow = page.locator("tr", { hasText: "capital_exteriors" });
  await oppRow.locator("button", { hasText: "Value" }).click(); await page.waitForTimeout(300);
  await oppRow.locator("button", { hasText: "Won" }).click(); await page.waitForTimeout(700);
  eq("marking an opportunity won records revenue", db.get("SELECT status, value FROM opportunities WHERE lead_id = ?", id("capital_exteriors")).status, "won");

  /* analytics & ROI */
  await goto("analytics");
  const an = await page.locator("#main").innerText();
  yes("analytics shows the journey, revenue and honest attribution", /lead-to-revenue journey/i.test(an) && /Revenue attributed/i.test(an) && /never presented as money earned/i.test(an));
  await shot("10-analytics");

  /* reports */
  await goto("reports");
  yes("the report narrates the period in plain words", (await page.locator("#main li").count()) >= 1 && /plain words/i.test(await page.locator("#main").innerText()));
  await shot("11-reports");

  /* onboarding wizard */
  await goto("onboarding");
  eq("onboarding starts at the welcome slide", await page.locator(".ob-slide h3").innerText(), "Welcome to Maison Setter");
  await page.click("button:has-text('Start setup')"); await page.waitForTimeout(300);
  await page.click("button:has-text('Skip: fill the forms instead')"); await page.waitForTimeout(300);
  await page.fill("#ob_business_name", "Acme Roofing & Exteriors");
  await page.fill("#ob_business_location", "Austin, TX");
  await page.click("button:has-text('Save & continue')"); await page.waitForTimeout(600);
  const obSaved = db.get("SELECT data FROM onboarding WHERE client_id = ?", c1.id);
  eq("onboarding saves the section as you go", obSaved ? JSON.parse(obSaved.data).business.name : "", "Acme Roofing & Exteriors");
  await shot("12-onboarding");

  /* business profile */
  await goto("profile");
  yes("the business profile shows what onboarding captured", /Business profile/.test(await page.locator("#main").innerText()) && /Acme Roofing & Exteriors/.test(await page.locator("#main").innerText()));

  /* import */
  await goto("import");
  await page.fill("#impT", JSON.stringify([prof("pasted_one_roofing"), prof("pasted_two_roofing"), { nope: 1 }]));
  yes("import reads the pasted records", /3 records ready/.test(await page.locator("#main").innerText()));
  await page.click("button:has-text('Import leads')"); await page.waitForTimeout(800);
  yes("import reports what happened", /Queued/.test(await page.locator("#main").innerText()) && db.get("SELECT COUNT(*) AS n FROM leads WHERE username LIKE 'pasted_%'").n === 2);
  await page.fill("#impT", "username,biography,followersCount\nfrom_csv_roofing,Roofing (512) 555-0000,500"); yes("import reads CSV too", /1 record ready/.test(await page.locator("#main").innerText()));
  await shot("13-import");

  /* campaigns + the agency toggle */
  await goto("campaigns"); await shot("14-campaigns");

  const acme = page.locator("article.card", { hasText: "Acme Roofing" }), glow = page.locator("article.card", { hasText: "Glow Med Spa Growth" });
  eq("each campaign has the agency filter switch, set from the server", [await acme.locator(`#agf${c1.id}`).isChecked(), await glow.locator(`#agf${c2.id}`).isChecked()], [true, false]);
  await acme.locator(`label[for=agf${c1.id}]`).click(); await page.waitForTimeout(500);
  eq("switching the filter off saves at once and reveals the agency script", [db.get("SELECT allow_agencies FROM clients WHERE id = ?", c1.id).allow_agencies, await acme.locator("textarea").isVisible()], [1, true]);
  await acme.locator(`label[for=agf${c1.id}]`).click(); await page.waitForTimeout(500);
  eq("and back to filtering agencies out", db.get("SELECT allow_agencies FROM clients WHERE id = ?", c1.id).allow_agencies, 0);
  await acme.locator("button", { hasText: "Edit settings" }).click(); await page.waitForSelector("#cName");
  eq("the editor drawer exposes the same agency filter switch", await page.locator("#cAgf").isChecked(), true);
  await page.fill("#cMin", "300"); await page.click("#drawer button:has-text('Save changes')"); await page.waitForTimeout(600);
  eq("campaign settings save", db.get("SELECT min_followers FROM clients WHERE id = ?", c1.id).min_followers, 300);

  /* accounts */
  await goto("accounts"); await shot("15-accounts");
  const cardText = await page.locator("#main").innerText();
  yes("accounts show badges, counters and health", /Quarantined/.test(cardText) && /Warming up/.test(cardText) && /Active/.test(cardText) && /\d+ \/ \d+/.test(cardText));
  const s1card = page.locator("article.acct", { hasText: "Acme sender 1" });
  await s1card.locator("button", { hasText: "Quarantine now" }).click(); await page.waitForTimeout(700);
  eq("Quarantine now works from the dashboard", db.get("SELECT state FROM accounts WHERE id = ?", s1.id).state, "quarantined");
  await page.locator("article.acct", { hasText: "Acme sender 1" }).locator("button", { hasText: "Release now" }).click(); await page.waitForTimeout(700);
  eq("and Release brings it back", db.get("SELECT state FROM accounts WHERE id = ?", s1.id).state, "active");

  /* warm-up programs */
  await goto("warmup"); await shot("15b-warmup");
  const wuText = await page.locator("#main").innerText();
  yes("warm-up page shows program cards with a calendar grid", /Warm-up programs/.test(wuText) && /clean days/.test(wuText) && (await page.locator(".wu-cell").count()) > 10);
  await goto("accounts"); await page.waitForTimeout(400);
  await page.fill("#naL", "Third sender"); await page.fill("#naU", "third_sender_ig"); await page.click("button:has-text('Add sender account')"); await page.waitForTimeout(700);
  yes("adding an account shows a pairing code", (await page.locator("pre.code").first().innerText()).startsWith("me1."));
  await shot("16-accounts-pairing");

  /* live update on accounts */
  await E("POST", "/ext/quarantine", s3.tok, { trigger: "automation_warning" });
  await page.waitForFunction(() => /Glow sender/.test(document.body.innerText) && document.querySelectorAll(".badge.bad").length >= 2, null, { timeout: 5000 }).catch(() => {});
  eq("a warning reported by the extension flips the badge live", (await page.locator("article.acct", { hasText: "Glow sender" }).innerText()).includes("Quarantined"), true);

  /* live feed */
  await goto("overview");
  await E("POST", "/ext/log", s1.tok, { lines: [{ text: "Warm-touch @joes_roofing: liked a recent post", level: "good" }] });
  await page.waitForFunction(() => /liked a recent post/.test(document.querySelector("[data-feed]")?.innerText || ""), null, { timeout: 5000 }).catch(() => {});
  yes("the live feed shows an extension log line as it happens", /liked a recent post/.test(await page.locator("[data-feed]").innerText()));
  await shot("17-overview-live");

  /* settings */
  await goto("settings"); yes("settings shows the import key (hidden until shown)", /•{10}/.test(await page.locator("pre.code").first().innerText())); await shot("20-settings");

  /* mobile + dark */
  await page.setViewportSize({ width: 390, height: 844 }); await goto("overview");
  yes("on a phone the sidebar is hidden behind a menu button", (await page.locator("#menu").isVisible()) && !(await page.locator("#side").evaluate((e) => e.getBoundingClientRect().right > 20)));
  await shot("21-mobile-overview");
  await page.click("#menu"); await page.waitForTimeout(350); yes("the menu opens", await page.locator("#side").evaluate((e) => e.getBoundingClientRect().left >= 0)); await shot("22-mobile-menu"); await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1360, height: 900 }); await page.click("summary:has-text('Display')"); await page.selectOption("#theme", "dark"); await page.waitForTimeout(300); await goto("review"); await shot("23-dark-review"); await goto("analytics"); await shot("24-dark-analytics");
  eq("theme choice is remembered", await page.evaluate(() => JSON.parse(localStorage.getItem("me_prefs")).theme), "dark");

  /* sign out */
  await page.click("#logout"); await page.waitForTimeout(400);
  yes("signing out returns to the login page", await page.locator("#loginForm").isVisible());
  eq("no console errors or security-policy violations anywhere", errors, []);
  await browser.close(); await app.close(); claude.close();
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
