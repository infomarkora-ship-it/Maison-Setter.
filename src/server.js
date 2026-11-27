const http = require("node:http");
const path = require("node:path");
const { loadConfig } = require("./config");
const { openDb } = require("./db");
const { createJobs } = require("./jobs");
const { createAuth } = require("./auth");
const { createHaiku } = require("./haiku");
const { createBrain } = require("./brain");
const { createBuilder } = require("./builder");
const { createAccounts } = require("./accounts");
const { createLeads } = require("./leads");
const { createScheduler } = require("./scheduler");
const { createStats } = require("./stats");
const { createSupervisor } = require("./supervisor");
const { createVision } = require("./vision");
const { registerRunner } = require("./runner");
const { createBus } = require("./bus");
const { createWarmup } = require("./warmup");
const { createLive } = require("./live");
const { createLab } = require("./lab");
const crypto = require("node:crypto");
const { registerExt } = require("./ext");
const { registerApi } = require("./api");
const { createCrm } = require("./crm");
const { createGrowth } = require("./growth");
const { send, openStream, readJson, parseCookies, isHttps, clientIp, serveStatic, createRouter } = require("./http");
const { HttpError } = require("./util");

/* The subscribable calendar feed (Google Calendar, Apple Calendar, Outlook: "Add calendar from URL").
   Public but token-gated: the URL carries the token shown on the Appointments page. */
const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function buildIcs(rows, calName = "Maison Setter appointments") {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Maison Setter//Appointments//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEsc(calName)}`];
  for (const a of rows) {
    const start = a.scheduled_at, end = start + (a.duration_min || 30) * 60_000;
    lines.push("BEGIN:VEVENT", `UID:maison-setter-appt-${a.id}@maison-setter`, `DTSTAMP:${icsStamp(a.updated_at || a.created_at || Date.now())}`,
      `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`, `SUMMARY:${icsEsc(a.title || (a.username ? `Call with @${a.username}` : "Appointment"))}`,
      `DESCRIPTION:${icsEsc([a.status ? `Status: ${a.status}` : "", a.notes || ""].filter(Boolean).join(" | ").slice(0, 900))}`,
      a.username ? `ATTENDEE;CN=${icsEsc("@" + a.username)}:mailto:outreach-${a.lead_id || "x"}@maison-setter.invalid` : null,
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}

function createApp(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const db = openDb(cfg.dbPath);
  const jobs = createJobs(overrides.logger || console);
  const auth = createAuth(db, cfg);
  const haiku = createHaiku(cfg, db);
  const bus = createBus();
  const ctx = { cfg, db, jobs, auth, haiku, bus, live: createLive() };
  ctx.accounts = createAccounts(ctx);
  ctx.warmup = createWarmup(ctx);
  ctx.accounts.attachWarmup(ctx.warmup);
  ctx.brain = createBrain(ctx);            // company brain + layered knowledge: feeds every prompt below
  ctx.leads = createLeads(ctx);
  ctx.crm = createCrm(ctx);
  ctx.growth = createGrowth(ctx);
  ctx.builder = createBuilder(ctx);        // describe-it builders, the 8-question interview, the chat panel
  ctx.stats = createStats(ctx);
  ctx.scheduler = createScheduler(ctx);
  ctx.supervisor = createSupervisor(ctx);
  ctx.vision = createVision(ctx);
  ctx.lab = createLab(ctx);

  const ext = createRouter(), api = createRouter();
  registerExt(ext, ctx);
  const runner = createRouter();
  ctx.runner = registerRunner(runner, ctx);
  const { importKey } = registerApi(api, ctx);
  const keyOk = (given) => { const a = Buffer.from(String(given || "")), b = Buffer.from(importKey()); return a.length === b.length && crypto.timingSafeEqual(a, b); };

  async function handle(req, res) {
    const url = new URL(req.url, "http://x"), pathname = url.pathname;
    try {
      if (pathname === "/health") return send(res, 200, { ok: true, db: !!db.get("SELECT 1 AS x") });

      /* Live feed for open dashboards (server-sent events). */
      if (pathname === "/api/stream" && req.method === "GET") {
        if (!auth.sessionOk(parseCookies(req.headers.cookie).me_session)) return send(res, 401, { error: "Please sign in." });
        const stream = openStream(req, res), unsub = bus.subscribe((e) => stream.send(e)), beat = setInterval(stream.ping, 20_000);
        stream.send({ t: "hello", at: Date.now() });
        req.on("close", () => { unsub(); clearInterval(beat); });
        return;
      }
      /* Automation hook (Apify integrations, Make, Zapier, n8n): POST records with the import key. */
      if (pathname === "/hooks/import" && req.method === "POST") {
        const ip = clientIp(req);
        if (auth.throttled(ip)) return send(res, 429, { error: "Too many attempts. Try again in a few minutes." });
        if (!keyOk(req.headers["x-import-key"])) { auth.noteFail(ip); return send(res, 401, { error: "Wrong or missing x-import-key header." }); }
        const body = await readJson(req, 25_000_000), records = Array.isArray(body) ? body : body.records || body.items || body.leads;
        const out = ctx.leads.importBatch({ clientId: Number(url.searchParams.get("campaignId") || url.searchParams.get("clientId") || body.campaignId || body.clientId), records,
          sourceType: url.searchParams.get("sourceType") || body.sourceType || body.source_type, via: "hook" });
        return send(res, 200, out);
      }

      /* Subscribable calendar feed (token-gated, no session needed — calendar apps cannot log in). */
      if (pathname === "/api/calendar.ics" && req.method === "GET") {
        const tok = db.setting("calendar_token", "");
        if (!tok || url.searchParams.get("token") !== tok) return send(res, 401, { error: "Wrong or missing calendar token. Copy the link again from the Appointments page." });
        const rows = db.all(`SELECT a.*, l.username FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id
          WHERE a.scheduled_at IS NOT NULL AND a.status NOT IN ('cancelled') ORDER BY a.scheduled_at DESC LIMIT 1000`);
        return send(res, 200, buildIcs(rows), { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-cache" });
      }

      const router = pathname.startsWith("/ext/") ? ext : pathname.startsWith("/runner/") ? runner : pathname.startsWith("/api/") ? api : null;
      if (!router) {
        if (req.method === "GET" && serveStatic(path.join(__dirname, "..", "public"), pathname, res)) return;
        return send(res, 404, { error: "Not found" });
      }
      // dashboard auth
      const isApi = router === api;
      if (isApi && pathname !== "/api/login" && pathname !== "/api/session") {
        if (!auth.sessionOk(parseCookies(req.headers.cookie).me_session)) return send(res, 401, { error: "Please sign in." });
      }
      if (req.method !== "GET" && req.method !== "HEAD" && isApi && !String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "Send JSON." });

      if (isApi && pathname === "/api/session" && req.method === "GET") {
        const authed = auth.sessionOk(parseCookies(req.headers.cookie).me_session);
        return send(res, 200, { authed, setupNeeded: !cfg.adminPassword, version: "3.6.0", ...(authed ? { haiku: haiku.status() } : {}) });
      }
      if (isApi && pathname === "/api/login" && req.method === "POST") {
        const ip = clientIp(req), body = await readJson(req);
        if (!cfg.adminPassword) return send(res, 503, { error: "Set the ADMIN_PASSWORD environment variable, then restart the server." });
        if (auth.throttled(ip)) return send(res, 429, { error: "Too many attempts. Try again in a few minutes." });
        if (!auth.passwordOk(body.password)) { auth.noteFail(ip); return send(res, 401, { error: "That password is not right." }); }
        return send(res, 200, { ok: true }, { "set-cookie": `me_session=${encodeURIComponent(auth.makeSession())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.SESSION_MS / 1000)}${isHttps(req) ? "; Secure" : ""}` });
      }
      if (isApi && pathname === "/api/logout" && req.method === "POST") return send(res, 200, { ok: true }, { "set-cookie": "me_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });

      const m = router.match(req.method, pathname);
      if (!m) return send(res, router.pathExists(pathname) ? 405 : 404, { error: "Not found" });
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req, /\/leads\/import/.test(pathname) ? 25_000_000 : /\/vision\//.test(pathname) ? 6_000_000 : undefined);
      const out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, body });
      if (out && out.__text !== undefined) return send(res, 200, out.__text, { "content-type": "text/markdown; charset=utf-8" });
      return send(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error(`${req.method} ${pathname}:`, e);
      return send(res, 500, { error: "Something went wrong on the server." });
    }
  }

  const server = http.createServer(handle);
  let timer = null;
  const maintain = () => { try { ctx.scheduler.maintain(); } catch (e) { console.error("maintain:", e.message); } try { ctx.growth?.tick(); } catch (e) { console.error("growth tick:", e.message); } };
  return {
    cfg, db, jobs, ctx, server, maintain,
    listen(port = cfg.port) { return new Promise((r) => server.listen(port, () => { timer = setInterval(maintain, 60_000); timer.unref(); maintain(); r(server.address().port); })); },
    async close() { clearInterval(timer); bus.releaseAll(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await jobs.drain(); db.close(); }
  };
}

if (require.main === module) {
  const app = createApp();
  if (!app.cfg.adminPassword) console.warn("WARNING: ADMIN_PASSWORD is not set. Nobody can sign in to the dashboard until you set it.");
  if (!app.cfg.anthropicKey && !app.cfg.geminiKey) console.warn("Note: no AI key is set (ANTHROPIC_API_KEY / GEMINI_API_KEY). The bouncer, the setter, the builders and the interview are switched off.");
  app.listen().then((port) => console.log(`Maison Setter server v3.6.0 listening on ${port}`));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => app.close().then(() => process.exit(0)));
}
module.exports = { createApp };
