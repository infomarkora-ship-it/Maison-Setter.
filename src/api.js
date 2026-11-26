/* Dashboard API (cookie session). Everything returns JSON except the report. */
const { now, DAY, j, lc, str, num, clamp, uid, HttpError } = require("./util");
const { validTz } = require("./tz");
const { DEFAULT_OPENER, DEFAULT_AGENCY_OPENER } = require("./leads");
const rules = require("./rules");

const DEFAULT_FOLLOWUPS = [
  { afterDays: 2, text: "Hey {first_name}, just bumping this in case it got buried. No pressure at all!" },
  { afterDays: 5, text: "Last one from me, {first_name}. If now isn't the right time, no worries. Wishing you a great week!" }
];

function registerApi(router, ctx) {
  const { db, cfg, accounts, leads, stats, haiku, jobs, bus, crm, growth, live, lab, warmup, builder, brain } = ctx;
  const base = (req) => cfg.publicUrl || `${req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").startsWith("https") ? "https" : "http"}://${req.headers.host}`;

  /* ---------- campaigns (the clients table) ---------- */
  const clientOut = (r) => ({ id: r.id, name: r.name, tz: r.tz, offer: r.offer, target: r.target, tone: r.tone, bookingLink: r.booking_link,
    openerTemplate: r.opener_template || DEFAULT_OPENER, agencyOpenerTemplate: r.agency_opener_template || DEFAULT_AGENCY_OPENER, followups: j(r.followups, []),
    allowAgencies: !!r.allow_agencies, preDmTouch: !!r.pre_dm_touch, minFollowers: r.min_followers, maxFollowers: r.max_followers, activeWithinDays: r.active_within_days,
    allowCreatorLabels: !!r.allow_creator_labels, requireContact: !!r.require_contact, excludeWords: j(r.exclude_words, []),
    supervision: r.supervision || "supervised", followPool: j(r.follow_pool, []), monthlyCost: r.monthly_cost ?? 0,
    leadBrief: r.lead_brief || "", autoBook: r.auto_book === undefined ? true : !!r.auto_book, followLeads: !!r.follow_leads,
    discoveredPool: j(r.follow_discovered, []).length,
    onboarding: (() => { const o = db.get("SELECT completed, step FROM onboarding WHERE client_id = ?", r.id); return o ? { completed: !!o.completed, step: o.step } : { completed: false, step: 0 }; })(),
    autoReply: !!r.auto_reply, autoApprovePass: !!r.auto_approve_pass, autoRejectNo: !!r.auto_reject_no, dailyCap: r.daily_cap, sendStart: r.send_start, sendEnd: r.send_end, active: !!r.active,
    pending: db.get("SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND review = 'pending' AND gate != ''", r.id).n,
    pendingAgencies: db.get("SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND review = 'pending' AND entity_classification = 'AGENCY'", r.id).n,
    accounts: db.get("SELECT COUNT(*) AS n FROM accounts WHERE client_id = ? AND state != 'killed'", r.id).n });
  function parseClient(b, partial) {
    const o = {}, has = (k) => b[k] !== undefined;
    if (!partial || has("name")) { o.name = str(b.name, 80).trim(); if (!o.name) throw new HttpError(400, "Give the campaign a name."); }
    if (has("tz")) { if (!validTz(b.tz)) throw new HttpError(400, "That time zone is not recognised. Use a name like America/Toronto."); o.tz = b.tz; }
    if (has("offer")) o.offer = str(b.offer, 800).trim();
    if (has("target")) o.target = str(b.target, 600).trim();
    if (has("tone")) o.tone = str(b.tone, 200).trim() || "friendly, short, casual";
    if (has("bookingLink")) {
      const v = str(b.bookingLink, 300).trim();
      if (v) { let u; try { u = new URL(v); } catch { throw new HttpError(400, "The booking link must be a full web address."); } if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "The booking link must start with http or https."); }
      o.booking_link = v;
    }
    if (has("openerTemplate")) o.opener_template = str(b.openerTemplate, 400).trim();
    if (has("agencyOpenerTemplate")) o.agency_opener_template = str(b.agencyOpenerTemplate, 400).trim();
    if (has("followups")) {
      if (!Array.isArray(b.followups) || b.followups.length > 6) throw new HttpError(400, "Use up to 6 follow-ups.");
      o.followups = JSON.stringify(b.followups.map((f) => ({ afterDays: clamp(num(f.afterDays, 3), 0.25, 30), text: str(f.text, 500).trim() })));
    }
    for (const [k, col] of [["autoReply", "auto_reply"], ["autoApprovePass", "auto_approve_pass"], ["autoRejectNo", "auto_reject_no"], ["active", "active"], ["allowAgencies", "allow_agencies"],
      ["preDmTouch", "pre_dm_touch"], ["allowCreatorLabels", "allow_creator_labels"], ["requireContact", "require_contact"], ["autoBook", "auto_book"], ["followLeads", "follow_leads"]]) if (has(k)) o[col] = b[k] ? 1 : 0;
    if (has("leadBrief")) o.lead_brief = str(b.leadBrief, 6000).trim();
    if (has("supervision")) { if (!["watch", "supervised", "autopilot"].includes(b.supervision)) throw new HttpError(400, "Supervision must be watch, supervised or autopilot."); o.supervision = b.supervision; }
    if (has("followPool")) { const list = rules.splitWords(b.followPool).map((x) => x.replace(/^@/, "")); const bad = list.find((x) => !/^[a-z0-9._]{1,30}$/.test(x)); if (bad) throw new HttpError(400, `"${bad}" is not a valid Instagram username.`); o.follow_pool = JSON.stringify(list.slice(0, 200)); }
    if (has("excludeWords")) o.exclude_words = JSON.stringify(rules.splitWords(b.excludeWords).slice(0, 80));
    if (has("minFollowers")) o.min_followers = clamp(Math.round(num(b.minFollowers, 150)), 0, 1e9);
    if (has("maxFollowers")) o.max_followers = clamp(Math.round(num(b.maxFollowers, 100000)), 0, 1e9);
    if (o.min_followers && o.max_followers && o.min_followers > o.max_followers) throw new HttpError(400, "Fewest followers can't be more than most followers.");
    if (has("activeWithinDays")) o.active_within_days = clamp(Math.round(num(b.activeWithinDays, 30)), 0, 3650);
    if (has("dailyCap")) o.daily_cap = clamp(Math.round(num(b.dailyCap, 20)), 1, 40);
    if (has("sendStart")) o.send_start = clamp(Math.round(num(b.sendStart, 9)), 0, 23);
    if (has("sendEnd")) o.send_end = clamp(Math.round(num(b.sendEnd, 20)), 1, 24);
    if (has("monthlyCost")) o.monthly_cost = Math.max(0, num(b.monthlyCost, 0));
    return o;
  }
  const insert = (table, o) => { const k = Object.keys(o); return db.run(`INSERT INTO ${table}(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`, ...k.map((x) => o[x])); };
  const patch = (table, id, o) => { const k = Object.keys(o); if (k.length) db.run(`UPDATE ${table} SET ${k.map((x) => x + " = ?").join(", ")} WHERE id = ?`, ...k.map((x) => o[x]), id); };
  const wakeCampaign = (id) => { for (const a of db.all("SELECT id FROM accounts WHERE client_id = ?", id)) bus.bump(a.id); bus.publish({ t: "campaign", id: +id }); };

  router.get("/api/clients", () => ({ clients: db.all("SELECT * FROM clients ORDER BY name").map(clientOut) }));
  router.post("/api/clients", ({ body }) => {
    const o = parseClient(body, false);
    const c = { tz: cfg.defaultTz, followups: JSON.stringify(DEFAULT_FOLLOWUPS), opener_template: DEFAULT_OPENER, ...o, created_at: now() };
    return clientOut(db.get("SELECT * FROM clients WHERE id = ?", insert("clients", c).id));
  });
  router.patch("/api/clients/:id", ({ params, body }) => {
    if (!db.get("SELECT id FROM clients WHERE id = ?", params.id)) throw new HttpError(404, "Campaign not found.");
    const o = parseClient(body, true), cur = db.get("SELECT * FROM clients WHERE id = ?", params.id);
    if ((o.send_end ?? cur.send_end) <= (o.send_start ?? cur.send_start)) throw new HttpError(400, "Sending must end after it starts.");
    patch("clients", params.id, o); wakeCampaign(params.id);
    return clientOut(db.get("SELECT * FROM clients WHERE id = ?", params.id));
  });
  router.del("/api/clients/:id", ({ params }) => {
    if (db.get("SELECT 1 AS x FROM leads WHERE client_id = ?", params.id) || db.get("SELECT 1 AS x FROM accounts WHERE client_id = ?", params.id)) throw new HttpError(409, "This campaign has leads or accounts. Switch it off instead of deleting.");
    db.run("DELETE FROM clients WHERE id = ?", params.id);
    return { ok: true };
  });

  /* ---------- accounts (senders) ---------- */
  const visible = () => db.all("SELECT * FROM accounts WHERE kind = 'sender' AND (state != 'killed' OR replaced_by IS NULL) ORDER BY id").map(accounts.summary);
  router.get("/api/accounts", () => ({ accounts: visible() }));
  router.post("/api/accounts", ({ req, body }) => {
    const made = accounts.create({ kind: body.kind || "sender", label: body.label, igUsername: body.igUsername, clientId: num(body.clientId), igAge: body.igAge });
    return { account: accounts.summary(accounts.byId(made.account.id)), pairingCode: accounts.pairingCode(made.account, made.token, base(req)) };
  });
  router.patch("/api/accounts/:id", ({ params, body }) => {
    const a = accounts.byId(params.id); if (!a) throw new HttpError(404, "Account not found.");
    if (body.action) accounts.act(a.id, body.action);
    const o = {};
    if (body.label !== undefined) o.label = str(body.label, 80);
    if (body.dailyCapOverride !== undefined) o.daily_cap_override = body.dailyCapOverride === null || body.dailyCapOverride === "" ? null : clamp(Math.round(num(body.dailyCapOverride, 20)), 0, 40);
    if (body.driver !== undefined) { if (!["extension", "runner"].includes(body.driver)) throw new HttpError(400, "Driver must be extension or runner."); o.driver = body.driver; }
    if (body.dolphinProfileId !== undefined) { const v = str(body.dolphinProfileId, 60).trim(); if (v && !/^[A-Za-z0-9_-]+$/.test(v)) throw new HttpError(400, "The Dolphin profile ID can only contain letters, numbers, dashes and underscores."); o.dolphin_profile_id = v; }
    if ((o.driver || a.driver) === "runner" && !(o.dolphin_profile_id ?? a.dolphin_profile_id)) throw new HttpError(400, "Enter the Dolphin profile ID before switching this account to the runner.");
    if (body.igAge !== undefined) { if (!accounts.WARM_DAYS[body.igAge]) throw new HttpError(400, "Account age must be new, young or established."); o.ig_age = body.igAge; }
    patch("accounts", a.id, o); bus.bump(a.id); bus.publish({ t: "account", id: a.id });
    return accounts.summary(accounts.byId(a.id));
  });
  router.post("/api/accounts/:id/rotate", ({ req, params }) => {
    if (!accounts.byId(params.id)) throw new HttpError(404, "Account not found.");
    const r = accounts.rotateToken(params.id);
    return { pairingCode: accounts.pairingCode(r.account, r.token, base(req)) };
  });
  /* Pause a sender for 48 hours and hand its unsent first messages to healthy senders. The extension calls the same thing at /ext/quarantine. */
  router.post("/api/accounts/:id/quarantine", ({ params, body }) => {
    const a = accounts.byId(params.id); if (!a) throw new HttpError(404, "Account not found.");
    const r = accounts.quarantine(a, { reason: str(body.reason, 160) || "Quarantined from the dashboard.", trigger: "dashboard", needsReset: !!body.needsReset, hours: clamp(num(body.hours, 48), 1, 168) });
    return { account: accounts.summary(r.account), moved: r.moved, released: r.released };
  });
  router.post("/api/accounts/:id/release", ({ params }) => ({ account: accounts.summary(accounts.release(+params.id)) }));
  router.get("/api/accounts/:id/events", ({ params }) => ({ events: db.all("SELECT kind, detail, at FROM events WHERE account_id = ? ORDER BY at DESC LIMIT 40", params.id) }));

  /* ---------- sender test bench: one account, one real action, right now ----------
     Queues a type='test' task pinned to the chosen account. It jumps the whole queue (no sending
     window, no caps, no warm-up gating) and runs the moment that browser checks in - the long poll
     wakes it within a second. Quarantined / restricted / switched-off accounts refuse to test. */
  const testUser = (u) => String(u || "").toLowerCase().replace(/^@/, "").replace(/\/+$/, "").trim();
  const TEST_WHAT = (p) => p.kind === "follow" ? `follow @${p.username}` : p.kind === "like" ? (p.postUrl ? `like ${p.postUrl}` : `like @${p.username}'s latest post`) : `message @${p.username}`;
  router.post("/api/test/run", ({ body }) => {
    const a = accounts.byId(num(body.accountId));
    if (!a || a.kind !== "sender") throw new HttpError(404, "Pick a sender account to run the test on.");
    if (db.get("SELECT id FROM tasks WHERE account_id = ? AND type = 'test' AND status = 'pending'", a.id)) throw new HttpError(409, `${a.label} already has a test waiting. It runs within a few seconds - wait for it or cancel it.`);
    const st = accounts.effectiveState(a);
    if (["quarantined", "cooldown", "restricted", "killed"].includes(st.state)) throw new HttpError(409, `${a.label} is ${st.state} right now, so testing is off. Fix that first: ${st.reason || accounts.summary(a).reason}`);
    const kind = ["follow", "like", "dm"].includes(body.kind) ? body.kind : null;
    if (!kind) throw new HttpError(400, "The test must be follow, like or dm.");
    const payload = { kind };
    let text = "";
    if (kind === "follow") {
      payload.username = testUser(body.username);
      if (!/^[a-z0-9._]{1,30}$/.test(payload.username)) throw new HttpError(400, "Enter the Instagram username to follow.");
    } else if (kind === "like") {
      const url = String(body.postUrl || "").trim();
      if (url) {
        let u2; try { u2 = new URL(url); } catch { throw new HttpError(400, "The post link must be a full web address."); }
        if (!/(^|\.)instagram\.com$/i.test(u2.hostname) || !/^\/(p|reel|tv)\/[\w-]+/.test(u2.pathname)) throw new HttpError(400, "That is not an Instagram post or reel link. It should look like https://www.instagram.com/p/…");
        payload.postUrl = `https://www.instagram.com${u2.pathname.split("/").slice(0, 3).join("/")}/`;
      } else {
        payload.username = testUser(body.username);
        if (!/^[a-z0-9._]{1,30}$/.test(payload.username)) throw new HttpError(400, "Give a post link, or a username whose latest post should be liked.");
      }
    } else {
      payload.username = testUser(body.username);
      if (!/^[a-z0-9._]{1,30}$/.test(payload.username)) throw new HttpError(400, "Enter the Instagram username to message.");
      text = str(body.text, 1000).trim();
      if (!text) throw new HttpError(400, "Write the test message to send.");
    }
    const id = db.run("INSERT INTO tasks(account_id, client_id, type, text, payload, status, not_before, created_at) VALUES(?,?,?,?,?,?,?,?)",
      a.id, a.client_id, "test", text, JSON.stringify(payload), "pending", now(), now()).id;
    accounts.note(a, "info", `Test queued on ${a.label}: ${TEST_WHAT(payload)}. It runs the moment the browser checks in - usually within seconds.`, "test");
    bus.bump(a.id); bus.publish({ t: "task", accountId: a.id }); bus.publish({ t: "account", id: a.id });
    return { ok: true, task: db.get("SELECT * FROM tasks WHERE id = ?", id), account: accounts.summary(accounts.byId(a.id)) };
  });
  router.get("/api/test/tasks", ({ query }) => {
    const id = num(query.get("accountId"));
    const rows = db.all(`SELECT t.*, ac.label AS account_label FROM tasks t JOIN accounts ac ON ac.id = t.account_id WHERE t.type = 'test' ${id ? "AND t.account_id = ?" : ""} ORDER BY t.id DESC LIMIT 25`, ...(id ? [id] : []));
    return { tasks: rows.map((r) => { const p = j(r.payload, {}); return { id: r.id, accountId: r.account_id, account: r.account_label, kind: p.kind || "?", username: p.username || "", postUrl: p.postUrl || "", status: r.status, code: r.result_code, text: r.text || "", createdAt: r.created_at, doneAt: r.done_at, tries: r.tries }; }) };
  });
  router.post("/api/test/cancel/:id", ({ params }) => {
    const t = db.get("SELECT * FROM tasks WHERE id = ? AND type = 'test' AND status = 'pending'", params.id);
    if (!t) throw new HttpError(404, "That test is not waiting any more.");
    db.run("UPDATE tasks SET status = 'skipped', result_code = 'cancelled', done_at = ? WHERE id = ?", now(), t.id);
    const a = accounts.byId(t.account_id);
    if (a) accounts.note(a, "info", `A queued test was cancelled from the dashboard before it ran.`, "test");
    bus.publish({ t: "task", accountId: t.account_id });
    return { ok: true };
  });

  /* ---------- Senders Live: what every sender's browser is doing right now ---------- */
  router.get("/api/live", () => ({
    accounts: visible().map((a) => ({ ...a, live: live.get(a.id), log: live.logOf(a.id), diary: live.diaryOf(a.id, 40), liveFresh: live.fresh(a.id) })),
    stats: live.stats(), runnerSeenAt: db.setting("runner_seen_at", 0)
  }));

  /* ---------- Day diary: everything each sender did, narrated step by step ----------
     today  = the in-memory narration ring (this browser session, exact micro-steps)
     history = the durable activity table for that account (survives restarts, last 14 days) */
  router.get("/api/diary", ({ query }) => {
    const id = num(query.get("accountId"));
    const accs = id ? db.all("SELECT id, label, ig_username FROM accounts WHERE id = ?", id) : db.all("SELECT id, label, ig_username FROM accounts WHERE kind = 'sender' AND state != 'killed' ORDER BY id");
    const since = num(query.get("since"), 0), limit = Math.min(300, num(query.get("limit"), 200));
    return {
      accounts: accs.map((a) => ({ id: a.id, label: a.label, igUsername: a.ig_username, live: !!live.fresh(a.id),
        today: live.diaryOf(a.id, 120).filter((x) => x.at >= since),
        history: db.all("SELECT at, level, kind, text FROM activity WHERE account_id = ? ORDER BY at DESC LIMIT ?", a.id, limit) })),
      stats: live.stats()
    };
  });

  /* ---------- AI Lab: test the bot without touching real leads ---------- */
  router.post("/api/lab/draft", ({ body }) => lab.draft(body));
  router.post("/api/lab/verdict", ({ body }) => lab.verdict(body));
  router.get("/api/lab/history", ({ query }) => lab.history({ limit: query.get("limit") }));

  /* ---------- AI builder: describe what you want, the AI fills the real fields ---------- */
  router.post("/api/ai/build", ({ body }) => builder.build(body));
  /* The lead brief, translated into concrete pre-filter settings: a proposal you review, nothing saves by itself. */
  router.post("/api/ai/brief-rules", ({ body }) => builder.briefRules(body));
  /* The onboarding interview: a fixed set of 8 questions, asked one at a time; after the last answer it
     returns the company brain and a draft ICP for approval. */
  router.post("/api/ai/interview", ({ body }) => builder.interview(body));
  /* Approve (or overwrite) the brain + ICP; apply=true also syncs the campaign row. */
  router.post("/api/ai/brain", ({ body }) => builder.approveBrain(body));
  /* The chat builder: talk it out, get a proposed patch back, apply what you like in the dashboard. */
  router.post("/api/ai/chat", ({ body }) => builder.chat(body));

  /* ---------- knowledge base: global company knowledge, layered under each campaign's own ---------- */
  router.get("/api/kb", ({ query }) => ({ global: brain.getGlobal(), campaign: query.get("clientId") ? brain.campaignKB(num(query.get("clientId"))) : null, fields: brain.KB_FIELDS }));
  router.put("/api/kb", ({ body }) => ({ global: brain.saveGlobal(body.kb && typeof body.kb === "object" ? body.kb : body) }));

  /* ---------- Warm-up plans: presets plus your own ---------- */
  router.get("/api/warmup/plans", () => warmup.listPlans());
  router.post("/api/warmup/plans", ({ body }) => {
    const saved = warmup.savePlan(body.plan || body, { allowUnsafe: !!body.allowUnsafe || !!body.plan?.allowUnsafe });
    for (const a of db.all("SELECT id FROM accounts WHERE warm_plan = ?", saved.id)) bus.bump(a.id);
    return { plan: saved, plans: warmup.listPlans() };
  });
  router.del("/api/warmup/plans/:id", ({ params }) => { const r = warmup.deletePlan(params.id); bus.bumpAll(db.all("SELECT id FROM accounts").map((a) => a.id)); return r; });
  router.post("/api/warmup/assign", ({ body }) => {
    const a = accounts.byId(num(body.accountId)); if (!a) throw new HttpError(404, "Account not found.");
    const r = warmup.assignPlan(a.id, String(body.planId || ""));
    bus.bump(a.id); bus.publish({ t: "account", id: a.id });
    return { ...r, program: accounts.summary(accounts.byId(a.id)).program };
  });
  /* Warm-up programs: one row per sender, with the full program object and its calendar grid. */
  router.get("/api/warmup", () => ({ accounts: db.all("SELECT * FROM accounts WHERE kind = 'sender' AND state != 'killed' ORDER BY id")
    .map((a) => { const s = accounts.summary(a); return { id: s.id, label: s.label, igUsername: s.igUsername, igAge: s.igAge, clientId: s.clientId,
      state: s.state, badge: s.badge, online: s.online, health: s.health, sentToday: s.sentToday, capToday: s.capToday,
      program: ctx.warmup ? ctx.warmup.program(a) : null }; }) }));

  /* ---------- leads ---------- */
  router.get("/api/leads", ({ query }) => leads.list({ clientId: query.get("clientId") || undefined, review: query.get("review") || undefined, stage: query.get("stage") || undefined, bucket: query.get("bucket") || undefined,
    batch: query.get("batch") || undefined, pipeline: query.get("pipeline") || undefined, intent: query.get("intent") || undefined, minScore: query.get("minScore") || undefined, needsHuman: query.get("needsHuman") || undefined,
    q: query.get("q") || undefined, limit: num(query.get("limit"), 100), offset: num(query.get("offset"), 0) }));
  router.get("/api/leads/:id", ({ params }) => { const l = leads.must(params.id);
    return { lead: leads.leadOut(l), messages: leads.messagesFor(l.id), appointments: db.all("SELECT * FROM appointments WHERE lead_id = ? ORDER BY scheduled_at DESC", l.id).map(crm.apptOut),
      opportunity: db.get("SELECT * FROM opportunities WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1", l.id) || null, tasks: crm.listLeadTasks({ leadId: l.id, limit: 50 }),
      activity: db.all("SELECT at, level, kind, text FROM activity WHERE lead_id = ? ORDER BY at DESC LIMIT 60", l.id) }; });
  router.post("/api/leads/:id/approve", ({ params, body }) => ({ lead: leads.leadOut(leads.approve(+params.id, { clientId: body.clientId, opener: body.opener })) }));
  router.post("/api/leads/:id/reject", ({ params, body }) => ({ lead: leads.leadOut(leads.reject(+params.id, body.reason)) }));
  router.patch("/api/leads/:id", ({ params, body }) => {
    if (body.pipeline !== undefined) { crm.setPipeline(+params.id, body.pipeline); delete body.pipeline; }
    return { lead: leads.leadOut(leads.update(+params.id, body)) };
  });
  router.post("/api/leads/rescore", ({ body }) => leads.rescoreAll({ clientId: body.clientId ? num(body.clientId) : undefined }));
  router.post("/api/leads/:id/score", ({ params }) => ({ score: leads.scoreLead(+params.id, {}) }));
  router.post("/api/leads/:id/opener", ({ params }) => { const l = leads.must(params.id); leads.touch(l.id, { opener_edited: 0 }); jobs.add(() => leads.makeOpener(l.id), "opener"); return { ok: true, queued: haiku.enabled() }; });
  router.post("/api/leads/:id/requalify", ({ params }) => { const l = leads.must(params.id); leads.touch(l.id, { gate: "", haiku_status: "queued", review: "pending", review_reason: "", entity_classification: "" }); jobs.add(() => leads.processLead(l.id), "qualify"); return { ok: true }; });
  router.post("/api/leads/bulk", ({ body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 200), done = [], failed = [];
    for (const id of ids) {
      try { if (body.action === "approve") leads.approve(+id, { clientId: body.clientId }); else if (body.action === "reject") leads.reject(+id, body.reason); else throw new HttpError(400, "Unknown action."); done.push(id); }
      catch (e) { failed.push({ id, error: e.message }); }
    }
    return { done, failed };
  });

  /* Apify exports and Meta Ad Library records. Records: { ig_username, page_name, ad_copy, ad_landing_url, niche } or a full Apify profile.
     Duplicates (same username in the campaign) are dropped; everything else is queued for the pre-filter and the bouncer. */
  const importHandler = (forced) => ({ body }) => {
    const records = Array.isArray(body) ? body : body.records || body.items || body.leads;
    return leads.importBatch({ clientId: num(body.clientId ?? body.campaignId), records, sourceType: forced || body.sourceType || body.source_type, via: "dashboard" });
  };
  router.post("/api/leads/import", importHandler());
  router.post("/api/leads/import-ads", importHandler("meta_ad_library"));
  router.get("/api/imports", () => ({ batches: db.all(`SELECT import_batch AS id, MIN(found_at) AS at, client_id AS clientId, source_type AS sourceType, COUNT(*) AS total,
      SUM(CASE WHEN gate = '' THEN 1 ELSE 0 END) AS processing, SUM(CASE WHEN entity_classification = 'REAL_BUSINESS' THEN 1 ELSE 0 END) AS real, SUM(CASE WHEN entity_classification = 'AGENCY' THEN 1 ELSE 0 END) AS agency, SUM(CASE WHEN entity_classification = 'REJECT' THEN 1 ELSE 0 END) AS rejected
    FROM leads WHERE import_batch != '' GROUP BY import_batch, client_id, source_type ORDER BY at DESC LIMIT 15`) }));

  /* ---------- replies waiting for a person ---------- */
  router.get("/api/replies", () => {
    const rows = db.all(`SELECT t.id, t.text, t.lead_id, t.inbound_at, t.created_at, l.username, l.name, l.stage, l.client_id FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.type = 'reply' AND t.status = 'draft' ORDER BY t.created_at`);
    return { replies: rows.map((r) => ({ taskId: r.id, leadId: r.lead_id, username: r.username, name: r.name, stage: r.stage, draft: r.text, inboundAt: r.inbound_at, conversation: leads.messagesFor(r.lead_id).slice(-8) })),
      needsHuman: db.all(`SELECT * FROM leads WHERE needs_human = 1 AND id NOT IN (SELECT lead_id FROM tasks WHERE type = 'reply' AND status = 'draft' AND lead_id IS NOT NULL) ORDER BY updated_at DESC LIMIT 50`).map(leads.leadOut) };
  });
  router.post("/api/tasks/:id/approve", ({ params, body }) => {
    const t = db.get("SELECT * FROM tasks WHERE id = ? AND type = 'reply' AND status = 'draft'", params.id); if (!t) throw new HttpError(404, "That reply is no longer waiting.");
    const l = leads.must(t.lead_id), text = leads.cleanText(body.text !== undefined ? body.text : t.text, db.get("SELECT * FROM clients WHERE id = ?", l.client_id), true);
    if (!text) throw new HttpError(400, "Write the reply first.");
    db.run("UPDATE tasks SET text = ?, status = 'pending', not_before = ? WHERE id = ?", text, now(), t.id);
    leads.touch(l.id, { needs_human: 0 }); if (t.account_id) bus.bump(t.account_id); else for (const a of db.all("SELECT id FROM accounts WHERE client_id = ?", l.client_id)) bus.bump(a.id);
    return { ok: true };
  });
  router.post("/api/tasks/:id/discard", ({ params }) => {
    const t = db.get("SELECT * FROM tasks WHERE id = ? AND type = 'reply' AND status = 'draft'", params.id); if (!t) throw new HttpError(404, "That reply is no longer waiting.");
    db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", now(), t.id); leads.touch(t.lead_id, { needs_human: 0 });
    return { ok: true };
  });

  /* ---------- overview, quality, activity, report ---------- */
  const activityRows = (limit = 40, since = 0) => db.all(`SELECT a.id, a.at, a.level, a.kind, a.text, a.account_id AS accountId, a.lead_id AS leadId, ac.label AS account FROM activity a LEFT JOIN accounts ac ON ac.id = a.account_id WHERE a.at > ? ORDER BY a.id DESC LIMIT ?`, since, limit);
  router.get("/api/activity", ({ query }) => ({ activity: activityRows(Math.min(200, num(query.get("limit"), 40)), num(query.get("since"), 0)) }));
  router.get("/api/digest", ({ query }) => stats.digest({ clientId: num(query.get("clientId")), days: num(query.get("days"), 7) }));
  router.get("/api/quality", ({ query }) => ({ ...stats.quality({ clientId: num(query.get("clientId")), days: num(query.get("days"), 7) }), haiku: haiku.status() }));
  router.get("/api/report", ({ query }) => ({ __text: stats.report({ clientId: num(query.get("clientId")), days: num(query.get("days"), 7) }) }));
  router.get("/api/overview", ({ query }) => {
    const clientId = num(query.get("clientId")), days = num(query.get("days"), 7), accs = visible(), alerts = [];
    for (const a of accs) {
      if (a.badge === "quarantined") alerts.push({ level: "bad", text: `${a.label} is quarantined. ${a.reason}`, to: "#/accounts" });
      else if (a.state === "paused" && a.reason.startsWith("This is a")) alerts.push({ level: "warn", text: `${a.label}: ${a.reason}`, to: "#/accounts" });
      if (a.state === "active" && a.health.level === "risky") alerts.push({ level: "bad", text: `${a.label} has a risky health score (${a.health.score}). Its limits were cut.`, to: "#/accounts" });
      if (a.state === "active" && (!a.lastSeenAt || now() - a.lastSeenAt > 15 * 60_000)) alerts.push({ level: "warn", text: a.lastSeenAt ? `${a.label} has not checked in for ${Math.round((now() - a.lastSeenAt) / 60000)} minutes. Is its browser open?` : `${a.label} has never connected. Pair the extension.`, to: "#/accounts" });
      if (db.get("SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind = 'selector_error' AND at > ?", a.id, now() - DAY).n) alerts.push({ level: "warn", text: `${a.label} could not read Instagram's pages. The layout may have changed.`, to: "#/accounts" });
    }
    const d = stats.digest({ clientId, days });
    if (d.pendingReview) alerts.push({ level: "info", text: `${d.pendingReview} lead${d.pendingReview === 1 ? "" : "s"} waiting for your review.`, to: "#/review" });
    if (d.repliesWaiting) alerts.push({ level: "info", text: `${d.repliesWaiting} reply draft${d.repliesWaiting === 1 ? "" : "s"} waiting for approval.`, to: "#/replies" });
    const held = ctx.supervisor.stats(7).waiting; if (held) alerts.push({ level: "warn", text: `The supervisor is holding ${held} command${held === 1 ? "" : "s"} for your OK.`, to: "#/supervisor" });
    const rs = db.setting("runner_seen_at", 0), runnerAccts = accs.filter((a) => a.driver === "runner" && a.state === "active");
    if (runnerAccts.length && (!rs || now() - rs > 5 * 60_000)) alerts.push({ level: "bad", text: `The runner is offline, so ${runnerAccts.length} account${runnerAccts.length === 1 ? "" : "s"} can't send. Check the VPS.`, to: "#/runner" });
    if (!haiku.enabled()) alerts.push({ level: "warn", text: "Haiku is not connected (no ANTHROPIC_API_KEY). Imported leads pass the pre-filter but cannot be checked by the bouncer.", to: "#/settings" });
    return { digest: d, supervisor: ctx.supervisor.stats(7), quality: stats.quality({ clientId, days }), accounts: accs, alerts, haiku: haiku.status(), activity: activityRows(25), live: { dashboards: bus.subscribers() },
      priorities: growth.priorities({ clientId }).priorities.slice(0, 8), insights: growth.insights({ clientId, days }).insights, unread: db.get("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").n,
      appointmentCounts: crm.listAppointments({ clientId: clientId || undefined, limit: 1000 }).counts, opportunityTotals: crm.listOpportunities({ clientId: clientId || undefined }).totals };
  });

  /* ---------- runner (the VPS program) ---------- */
  const runnerState = () => { const seenAt = db.setting("runner_seen_at", 0), list = db.all("SELECT * FROM accounts WHERE kind = 'sender' AND driver = 'runner' AND state != 'killed' ORDER BY id").map(accounts.summary);
    return { token: ctx.runner.token(), seenAt, online: !!seenAt && now() - seenAt < 90_000, accounts: list, followCap: db.setting("follow_cap", 3), serverUrl: cfg.publicUrl || "" }; };
  router.get("/api/runner", ({ req }) => ({ ...runnerState(), serverUrl: base(req) }));
  router.post("/api/runner/token", () => { ctx.runner.regenerate(); return runnerState(); });

  /* ---------- supervisor ---------- */
  router.get("/api/supervisor", ({ query }) => ({ items: ctx.supervisor.list({ status: query.get("status") || undefined, limit: num(query.get("limit"), 80) }), stats: ctx.supervisor.stats(num(query.get("days"), 7)),
    visionUsedToday: db.get("SELECT COUNT(*) AS n FROM supervisor_log WHERE kind = 'vision' AND at >= ?", now() - DAY).n, haiku: haiku.enabled() }));
  router.post("/api/supervisor/:id/approve", ({ params, body }) => ctx.supervisor.approve(num(params.id), { text: body.text }));
  router.post("/api/supervisor/:id/deny", ({ params }) => ctx.supervisor.deny(num(params.id)));

  /* ---------- growth command center: appointments, opportunities, alerts, notifications, insights, roi, onboarding ---------- */
  const calToken = () => { let k = db.setting("calendar_token", ""); if (!k) { k = "cal_" + uid(24); db.setSetting("calendar_token", k); } return k; };
  router.get("/api/appointments", ({ query, req }) => {
    const from = query.get("from") ? num(query.get("from"), 0) : undefined, to = query.get("to") ? num(query.get("to"), 0) : undefined;
    return { ...crm.listAppointments({ clientId: num(query.get("clientId")) || undefined, status: query.get("status") || undefined, from, to, limit: num(query.get("limit"), 300) }), statuses: crm.APPT_STATUSES, labels: crm.APPT_LABEL, outcomes: crm.OUTCOMES,
      calendarUrl: `${base(req)}/api/calendar.ics?token=${calToken()}` };
  });
  router.post("/api/appointments", ({ body }) => ({ appointment: crm.apptOut(crm.createAppointment(body)) }));
  router.patch("/api/appointments/:id", ({ params, body }) => ({ appointment: crm.apptOut(crm.updateAppointment(+params.id, body)) }));
  router.del("/api/appointments/:id", ({ params }) => { if (!db.get("SELECT id FROM appointments WHERE id = ?", params.id)) throw new HttpError(404, "Appointment not found."); db.run("DELETE FROM appointments WHERE id = ?", params.id); return { ok: true }; });

  router.get("/api/opportunities", ({ query }) => ({ ...crm.listOpportunities({ clientId: num(query.get("clientId")) || undefined, status: query.get("status") || undefined }) }));
  router.post("/api/opportunities", ({ body }) => ({ opportunity: db.get("SELECT o.*, l.username, l.name FROM opportunities o LEFT JOIN leads l ON l.id = o.lead_id WHERE o.id = ?", crm.createOpportunity(body).id) }));
  router.patch("/api/opportunities/:id", ({ params, body }) => ({ opportunity: crm.updateOpportunity(+params.id, body) }));

  router.get("/api/alerts", ({ query }) => growth.listAlerts({ status: query.get("status") || "open", clientId: num(query.get("clientId")) || undefined }));
  router.post("/api/alerts/:id", ({ params, body }) => growth.setAlert(+params.id, body));

  router.get("/api/notifications", ({ query }) => growth.listNotifications({ unreadOnly: query.get("unread") === "1", limit: num(query.get("limit"), 60) }));
  router.post("/api/notifications/read", ({ body }) => growth.markRead(body));

  router.get("/api/priorities", ({ query }) => growth.priorities({ clientId: num(query.get("clientId")) || undefined }));
  router.get("/api/insights", ({ query }) => growth.insights({ clientId: num(query.get("clientId")) || undefined, days: num(query.get("days"), 7) }));
  router.get("/api/roi", ({ query }) => growth.roi({ clientId: num(query.get("clientId")) || undefined, days: num(query.get("days"), 30) }));
  router.get("/api/growth-report", ({ query }) => { const r = growth.report({ clientId: num(query.get("clientId")) || undefined, days: num(query.get("days"), 7) }); return { ...r, __text: undefined }; });
  router.get("/api/health-status", () => growth.health());

  router.get("/api/onboarding", ({ query }) => {
    if (query.get("clientId")) { const r = growth.getOnboarding(num(query.get("clientId"))); if (!r) return { onboarding: null, sections: growth.SECTIONS };
      return { onboarding: growth.onboardingOut(r), sections: growth.SECTIONS }; }
    const rows = db.all("SELECT * FROM onboarding ORDER BY updated_at DESC");
    return { onboardings: rows.map(growth.onboardingOut), sections: growth.SECTIONS };
  });
  router.put("/api/onboarding", ({ body }) => { if (!body.clientId) throw new HttpError(400, "Say which campaign this setup belongs to."); return { onboarding: growth.saveOnboarding(num(body.clientId), body) }; });
  router.post("/api/onboarding/complete", ({ body }) => { if (!body.clientId) throw new HttpError(400, "Say which campaign this setup belongs to."); return { onboarding: growth.completeOnboarding(num(body.clientId)) }; });

  router.get("/api/lead-tasks", ({ query }) => ({ tasks: crm.listLeadTasks({ clientId: num(query.get("clientId")) || undefined, leadId: num(query.get("leadId")) || undefined, done: query.get("done") === "" ? undefined : query.get("done") === "1" ? 1 : query.get("done") === "0" ? 0 : undefined }) }));
  router.post("/api/lead-tasks", ({ body }) => ({ task: crm.createLeadTask(body) }));
  router.patch("/api/lead-tasks/:id", ({ params, body }) => ({ task: crm.updateLeadTask(+params.id, body) }));

  router.get("/api/search", ({ query }) => growth.search(query.get("q") || ""));
  router.post("/api/reports/generate", ({ body }) => ({ report: growth.report({ clientId: body.clientId ? num(body.clientId) : undefined, days: num(body.days, 7) }) }));

  /* ---------- settings ---------- */
  const importKey = () => { let k = db.setting("import_key", ""); if (!k) { k = "imp_" + uid(24); db.setSetting("import_key", k); } return k; };
  router.get("/api/settings", () => ({ followCap: db.setting("follow_cap", 3), skipList: db.setting("skip_list", []), exclusiveClaims: db.setting("exclusive_claims", true), importKey: importKey(),
    selectors: db.setting("selectors", {}), blockPhrases: db.setting("block_phrases", []), defaultWindow: { start: 9, end: 20, tz: cfg.defaultTz, ...db.setting("default_window", {}) },
    ai: { chosen: db.setting("ai_provider", "") || cfg.aiProvider || "", active: haiku.status().provider, providers: haiku.providers(), status: haiku.status() },
    haiku: haiku.status(), jobErrors: jobs.errors.slice(0, 5) }));
  router.post("/api/settings/import-key", () => { db.setSetting("import_key", "imp_" + uid(24)); return { importKey: importKey() }; });
  router.put("/api/settings", ({ body }) => {
    if (body.skipList !== undefined) {
      const list = [...new Set((Array.isArray(body.skipList) ? body.skipList : String(body.skipList).split(/[\s,;]+/)).map((x) => lc(x).replace(/^@/, "")).filter(Boolean))];
      const bad = list.find((x) => !/^[a-z0-9._]{1,30}$/.test(x)); if (bad) throw new HttpError(400, `"${bad}" is not a valid username.`);
      db.setSetting("skip_list", list.slice(0, 2000));
    }
    if (body.exclusiveClaims !== undefined) db.setSetting("exclusive_claims", !!body.exclusiveClaims);
    if (body.followCap !== undefined) db.setSetting("follow_cap", clamp(Math.round(num(body.followCap, 3)), 0, 8));
    if (body.selectors !== undefined) {
      const o = {}; for (const [k, v] of Object.entries(body.selectors || {})) if (/^[A-Za-z]{2,30}$/.test(k) && typeof v === "string" && v.length <= 200) o[k] = v;
      db.setSetting("selectors", o);
    }
    if (body.defaultWindow !== undefined) {
      const w = body.defaultWindow || {}, start = clamp(Math.round(num(w.start, 9)), 0, 23), end = clamp(Math.round(num(w.end, 20)), 1, 24);
      if (end <= start) throw new HttpError(400, "The window must end after it starts.");
      if (w.tz && !validTz(w.tz)) throw new HttpError(400, "That time zone is not recognised.");
      db.setSetting("default_window", { start, end, ...(w.tz ? { tz: w.tz } : {}) });
    }
    if (body.blockPhrases !== undefined) db.setSetting("block_phrases", (Array.isArray(body.blockPhrases) ? body.blockPhrases : []).map((x) => str(x, 120)).filter(Boolean).slice(0, 30));
    if (body.aiProvider !== undefined) haiku.setProvider(body.aiProvider);            // "haiku" | "gemini" | "" = automatic
    if (body.geminiKey !== undefined && body.geminiKey !== "••••••••") haiku.setGeminiKey(body.geminiKey);   // the dashboard never echoes the key back
    bus.bumpAll(db.all("SELECT id FROM accounts").map((a) => a.id));
    return { ok: true };
  });
  /* Ping a provider with a one-word question, so Settings can prove the key works before you rely on it. */
  router.post("/api/settings/ai/test", async ({ body }) => {
    const p = ["haiku", "gemini"].includes(body.provider) ? body.provider : haiku.active();
    if (p === "gemini" && !haiku.providers().gemini) throw new HttpError(400, "Add a Gemini API key first (Settings, or the GEMINI_API_KEY environment variable).");
    if (p === "haiku" && !haiku.providers().haiku) throw new HttpError(400, "Set the ANTHROPIC_API_KEY environment variable first.");
    return await haiku.testProvider(p);
  });
  return { importKey, calToken };
}
module.exports = { registerApi };
