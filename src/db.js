/* Database. Two interchangeable backends behind one small synchronous API:
     - PostgreSQL (production, Railway): used when the target is a postgres:// URL — set DATABASE_URL and it wins over DB_PATH.
       Implemented on node-postgres, driven from a worker thread so the whole app can keep using the
       same blocking, synchronous calls it was written with (the worker owns the connections; the main
       thread waits on a shared buffer for each result, exactly like a local SQLite call).
     - SQLite via node:sqlite (local dev and the test suite): unchanged behaviour, file or :memory:.
   Both expose: get(sql, ...p), all(sql, ...p), run(sql, ...p) -> { changes, id }, tx(fn), setting(), setSetting(), close().
   Queries stay written in the app's SQLite dialect; the PostgreSQL worker translates the few dialect
   differences (? placeholders, IFNULL, INSERT OR IGNORE) on the way in. */
const fs = require("node:fs");
const path = require("node:path");

/* ---------- the v1 schema, SQLite dialect (unchanged) ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'America/New_York',
  offer TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT 'friendly, short, casual', booking_link TEXT NOT NULL DEFAULT '',
  opener_template TEXT NOT NULL DEFAULT '', followups TEXT NOT NULL DEFAULT '[]',
  auto_reply INTEGER NOT NULL DEFAULT 0, auto_approve_pass INTEGER NOT NULL DEFAULT 0, auto_reject_no INTEGER NOT NULL DEFAULT 1,
  daily_cap INTEGER NOT NULL DEFAULT 20, send_start INTEGER NOT NULL DEFAULT 9, send_end INTEGER NOT NULL DEFAULT 20,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('sender','finder')), label TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id), ig_username TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  ig_age TEXT NOT NULL DEFAULT 'young', state TEXT NOT NULL DEFAULT 'active', reason TEXT NOT NULL DEFAULT '',
  cooldown_until INTEGER NOT NULL DEFAULT 0, warm_started_at INTEGER NOT NULL, profiles_per_day INTEGER NOT NULL DEFAULT 40,
  daily_cap_override INTEGER, last_seen_at INTEGER, last_version TEXT, last_mode TEXT, logged_in_as TEXT,
  replaced_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_acc ON events(account_id, at);
CREATE TABLE IF NOT EXISTS lead_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', include TEXT NOT NULL DEFAULT '[]', include_mode TEXT NOT NULL DEFAULT 'any',
  exclude TEXT NOT NULL DEFAULT '[]', account_types TEXT NOT NULL DEFAULT '[]', min_followers INTEGER NOT NULL DEFAULT 0,
  max_followers INTEGER NOT NULL DEFAULT 0, active_within_days INTEGER NOT NULL DEFAULT 0, regions TEXT NOT NULL DEFAULT '[]',
  require_contact INTEGER NOT NULL DEFAULT 0, public_only INTEGER NOT NULL DEFAULT 1, borderline TEXT NOT NULL DEFAULT 'haiku',
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_type_id INTEGER REFERENCES lead_types(id), kind TEXT NOT NULL, ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'peers', enabled INTEGER NOT NULL DEFAULT 1,
  pause_reason TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'server', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_type_id INTEGER REFERENCES lead_types(id),
  lead_type_name TEXT NOT NULL DEFAULT '', lead_type_desc TEXT NOT NULL DEFAULT '', lead_regions TEXT NOT NULL DEFAULT '[]', source_id INTEGER REFERENCES sources(id), finder_account_id INTEGER, sender_account_id INTEGER,
  username TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  followers INTEGER, following INTEGER, posts INTEGER, is_business INTEGER, external_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', last_post_at INTEGER, captions TEXT NOT NULL DEFAULT '[]',
  surfaced_by TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'pass', needs_haiku INTEGER NOT NULL DEFAULT 0,
  rules_score INTEGER NOT NULL DEFAULT 0, reasons TEXT NOT NULL DEFAULT '[]',
  haiku_status TEXT NOT NULL DEFAULT 'none', haiku_fit TEXT NOT NULL DEFAULT '', haiku_score INTEGER, haiku_reason TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT 'pending', review_reason TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'new',
  opener TEXT NOT NULL DEFAULT '', opener_edited INTEGER NOT NULL DEFAULT 0, contact TEXT NOT NULL DEFAULT '{}',
  enrich_status TEXT NOT NULL DEFAULT 'none', thread_ig TEXT NOT NULL DEFAULT '', follow_step INTEGER NOT NULL DEFAULT 0,
  next_follow_at INTEGER, last_activity_at INTEGER, last_inbound_ts INTEGER NOT NULL DEFAULT 0,
  no_followup INTEGER NOT NULL DEFAULT 0, needs_human INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER, booked_at INTEGER,
  found_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS leads_uq ON leads(COALESCE(client_id, 0), username);
CREATE INDEX IF NOT EXISTS leads_client ON leads(client_id, review, stage);
CREATE INDEX IF NOT EXISTS leads_found ON leads(found_at);
CREATE TABLE IF NOT EXISTS claims (username TEXT PRIMARY KEY, client_id INTEGER NOT NULL, claimed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL,
  UNIQUE (lead_id, direction, ts, text));
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, client_id INTEGER, lead_id INTEGER, type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  not_before INTEGER NOT NULL DEFAULT 0, inbound_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, result_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, done_at INTEGER);
CREATE INDEX IF NOT EXISTS tasks_acc ON tasks(account_id, status, not_before);
CREATE INDEX IF NOT EXISTS tasks_lead ON tasks(lead_id, status);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id INTEGER, lead_id INTEGER, level TEXT NOT NULL DEFAULT 'info', kind TEXT NOT NULL DEFAULT '', text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
/* Every command the AI supervisor looked at, and what it decided. status: final | held | approved | denied */
CREATE TABLE IF NOT EXISTS supervisor_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id INTEGER, task_id INTEGER, lead_id INTEGER,
  kind TEXT NOT NULL, verdict TEXT NOT NULL, risk INTEGER, reason TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT 'rules', before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'final');
CREATE INDEX IF NOT EXISTS supervisor_at ON supervisor_log(at);
/* Accounts each sender has followed, so it never follows the same one twice and stays under its daily follow cap */
CREATE TABLE IF NOT EXISTS follows (account_id INTEGER NOT NULL, username TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (account_id, username));
`;

/* Columns added after v1. Each is added only if it is missing, so an existing database upgrades in place. */
const ADDS = [
  ["clients", "target", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "exclude_words", "TEXT NOT NULL DEFAULT '[]'"],
  ["clients", "allow_agencies", "INTEGER NOT NULL DEFAULT 0"],
  ["clients", "agency_opener_template", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "pre_dm_touch", "INTEGER NOT NULL DEFAULT 1"],
  ["clients", "min_followers", "INTEGER NOT NULL DEFAULT 150"],
  ["clients", "max_followers", "INTEGER NOT NULL DEFAULT 100000"],
  ["clients", "active_within_days", "INTEGER NOT NULL DEFAULT 30"],
  ["clients", "allow_creator_labels", "INTEGER NOT NULL DEFAULT 0"],
  ["clients", "require_contact", "INTEGER NOT NULL DEFAULT 1"],
  ["accounts", "driver", "TEXT NOT NULL DEFAULT 'extension'"],
  ["accounts", "dolphin_profile_id", "TEXT NOT NULL DEFAULT ''"],
  ["accounts", "proxy_ip", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "supervision", "TEXT NOT NULL DEFAULT 'supervised'"],
  ["clients", "follow_pool", "TEXT NOT NULL DEFAULT '[]'"],
  ["tasks", "sup_ok", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "needs_reset", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "quarantined_at", "INTEGER"],
  ["accounts", "last_action", "TEXT NOT NULL DEFAULT ''"],
  ["accounts", "last_action_at", "INTEGER"],
  ["leads", "source_type", "TEXT NOT NULL DEFAULT 'ig_organic'"],
  ["leads", "page_name", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "ad_copy", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "ad_landing_url", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "ad_start_date", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "entity_classification", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "entity_type", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "confidence", "INTEGER"],
  ["leads", "detected_niche", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "service_location", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "disqualification_reason", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "personalization_hook", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "has_booking_infra", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "has_website", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "quality_points", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "priority_boost", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "is_private", "INTEGER"],
  ["leads", "instagram_user_id", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "profile_data", "INTEGER NOT NULL DEFAULT 1"],
  ["leads", "gate", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "import_batch", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "links", "TEXT NOT NULL DEFAULT '[]'"],
  ["usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["usage", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"],
  /* Maison Setter growth command center */
  ["clients", "monthly_cost", "REAL NOT NULL DEFAULT 0"],
  ["leads", "pipeline", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "intent", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "score", "INTEGER"],
  ["leads", "score_detail", "TEXT NOT NULL DEFAULT '[]'"],
  ["leads", "opportunity_value", "REAL NOT NULL DEFAULT 0"],
  ["leads", "next_action", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "scored_at", "INTEGER"],
  ["leads", "last_reply_at", "INTEGER"],
  ["leads", "reply_intent", "TEXT NOT NULL DEFAULT ''"],
  /* Warm-up program: how many program days are complete, how far the day-checker has walked, holds and missed days */
  ["accounts", "warm_done", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "warm_cursor", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "warm_holds", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "warm_missed", "INTEGER NOT NULL DEFAULT 0"],
  /* Custom warm-up plan assigned to the account ("" = use the preset for its age) */
  ["accounts", "warm_plan", "TEXT NOT NULL DEFAULT ''"],
  /* v3.4: the lead brief (plain-words qualification description per campaign), full-auto booking,
     follow-leads-before-DM, and the pool of accounts the AI discovered while browsing */
  ["clients", "lead_brief", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "auto_book", "INTEGER NOT NULL DEFAULT 1"],
  ["clients", "follow_leads", "INTEGER NOT NULL DEFAULT 0"],
  ["clients", "follow_discovered", "TEXT NOT NULL DEFAULT '[]'"]
];

/* Tables for the growth command center. Created only if missing, so an existing database upgrades in place. */
const NEW_TABLES = `
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_id INTEGER REFERENCES leads(id),
  title TEXT NOT NULL DEFAULT '', scheduled_at INTEGER, duration_min INTEGER NOT NULL DEFAULT 30, tz TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'call', status TEXT NOT NULL DEFAULT 'booked', source TEXT NOT NULL DEFAULT 'outreach',
  notes TEXT NOT NULL DEFAULT '', value REAL NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS appts_client ON appointments(client_id, scheduled_at);
CREATE INDEX IF NOT EXISTS appts_lead ON appointments(lead_id);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_id INTEGER REFERENCES leads(id),
  value REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', won_reason TEXT NOT NULL DEFAULT '', lost_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, won_at INTEGER, lost_at INTEGER);
CREATE INDEX IF NOT EXISTS opps_client ON opportunities(client_id, status);
CREATE INDEX IF NOT EXISTS opps_lead ON opportunities(lead_id);
CREATE TABLE IF NOT EXISTS lead_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_id INTEGER REFERENCES leads(id),
  title TEXT NOT NULL, due_at INTEGER, priority TEXT NOT NULL DEFAULT 'medium', done INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ltasks_lead ON lead_tasks(lead_id, done);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', client_id INTEGER, lead_id INTEGER, appointment_id INTEGER,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open',
  snooze_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, priority);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key ON alerts(kind, COALESCE(lead_id, 0), COALESCE(client_id, 0)) WHERE status IN ('open','in_progress');
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  client_id INTEGER, lead_id INTEGER, read INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notif_read ON notifications(read, created_at);
CREATE TABLE IF NOT EXISTS onboarding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER UNIQUE REFERENCES clients(id), step INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}', completed INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;
/* Indexes on the later columns. (client_id, username) is already unique from v1. */
const INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS leads_uid ON leads(COALESCE(client_id, 0), instagram_user_id) WHERE instagram_user_id != ''",
  "CREATE INDEX IF NOT EXISTS leads_class ON leads(client_id, entity_classification, review)",
  "CREATE INDEX IF NOT EXISTS leads_batch ON leads(import_batch)"
];

/* Tables whose id comes from a sequence: INSERTs into these get "RETURNING id" on PostgreSQL so run().id keeps working. */
const SERIAL_TABLES = new Set(["clients", "accounts", "events", "lead_types", "sources", "leads", "messages", "tasks", "activity",
  "supervisor_log", "appointments", "opportunities", "lead_tasks", "alerts", "notifications", "onboarding"]);

/* ---------- the shared wrapper that both backends return ---------- */
function wrapper(runSql, txImpl, closeImpl) {
  const db = {
    get: (sql, ...p) => runSql(sql, p).rows[0],
    all: (sql, ...p) => runSql(sql, p).rows,
    run: (sql, ...p) => { const r = runSql(sql, p); const first = r.rows && r.rows[0]; return { changes: r.changes, id: first && first.id !== undefined && first.id !== null ? Number(first.id) : 0 }; },
    tx: txImpl,
    setting(key, def = null) { const r = db.get("SELECT value FROM settings WHERE key = ?", key); if (!r) return def; try { return JSON.parse(r.value); } catch { return def; } },
    setSetting(key, value) { db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value)); },
    close: closeImpl
  };
  return db;
}
const normParams = (p) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));

/* ---------- SQLite backend (unchanged behaviour) ---------- */
function openSqlite(file) {
  const { DatabaseSync } = require("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA);
  for (const stmt of NEW_TABLES.split(";")) { const s = stmt.trim(); if (s) { try { raw.exec(s); } catch { /* old data with a conflicting shape keeps running; code checks too */ } } }
  const have = {};
  for (const [t, c, ddl] of ADDS) {
    have[t] ||= new Set(raw.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
    if (!have[t].has(c)) { raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); have[t].add(c); if (t === "leads" && c === "gate") raw.exec("UPDATE leads SET gate = 'legacy'"); }   // leads from before the upgrade were never filtered: mark them done, not "processing"
  }
  const skipped = [];
  for (const sql of INDEXES) { try { raw.exec(sql); } catch (e) { skipped.push(e.message); } }   // old data with duplicates: keep running, the app also checks in code
  // Finding now happens outside this app (Apify imports), so old finder accounts are switched off, not deleted.
  raw.exec("UPDATE accounts SET state = 'killed', reason = 'Finding now happens through imports, so finder accounts are no longer used.' WHERE kind = 'finder' AND state != 'killed'");
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = raw.prepare(String(sql).replace(/\bILIKE\b/g, "LIKE")); cache.set(sql, s); } return s; };   // SQLite's LIKE is case-insensitive, so ILIKE queries behave the same
  let txActive = false;
  const db = wrapper(
    (sql, params) => ({ rows: st(sql).all(...normParams(params)), changes: 0, id: 0 }),
    (fn) => {
      if (txActive) throw new Error("nested transaction");
      txActive = true;
      raw.exec("BEGIN");
      try { const r = fn(); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; } finally { txActive = false; }
    },
    () => raw.close()
  );
  // SQLite reports the inserted row id from the statement itself, without RETURNING.
  db.run = (sql, ...p) => { const r = st(sql).run(...normParams(p)); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; };
  db.file = file;
  return db;
}

/* ---------- PostgreSQL dialect translation (mirrored inside the worker) ---------- */
function translateForPg(sql) {
  let s = String(sql);
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(s);
  if (ignore) s = s.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, "INSERT INTO ");
  let out = "", lit = false, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (lit) { out += c; if (c === "'") { if (s[i + 1] === "'") out += s[++i]; else lit = false; } continue; }
    if (c === "'") { lit = true; out += c; continue; }
    if (c === "?") { out += "$" + (++n); continue; }
    const rest = s.slice(i);
    if (/^IFNULL\b/i.test(rest)) { out += "COALESCE"; i += 5; continue; }   // +5 then the loop's i++ skips all 6 letters, landing on "("
    if (/^IS\s+NOT\s+\?/i.test(rest)) { out += "IS DISTINCT FROM $" + (++n); i += rest.match(/^IS\s+NOT\s+\?/i)[0].length - 1; continue; }
    if (/^IS\s+\?/i.test(rest)) { out += "IS NOT DISTINCT FROM $" + (++n); i += rest.match(/^IS\s+\?/i)[0].length - 1; continue; }
    out += c;
  }
  s = out;
  if (ignore) s += " ON CONFLICT DO NOTHING";
  const m = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(s);
  if (m && SERIAL_TABLES.has(m[1].toLowerCase())) s += " RETURNING id";
  return s;
}

/* ---------- PostgreSQL backend ---------- */
/* The worker owns the pg Pool and the schema. The main thread never blocks the event loop on network
   waits any longer than the old synchronous SQLite blocked it on disk waits: each call writes its
   request into a SharedArrayBuffer and waits for the result, one query at a time. */
const WORKER_SRC = `"use strict";
const { workerData } = require("node:worker_threads");
const { Pool, types } = require("pg");
const { sab, url, schema, newTables, adds, indexes } = workerData;
const hdr = new Int32Array(sab, 0, 8);            // 0: request seq | 1: response seq | 2: ready (-1 failed) | 3: dead | 4: request bytes | 5: response bytes
const data = new Uint8Array(sab, 64, sab.byteLength - 64);
const dec = new TextDecoder(), enc = new TextEncoder();

/* BIGSERIAL/NUMERIC come back as text by default; the app was written for SQLite numbers. */
types.setTypeParser(20, (v) => (v == null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));

/* Tables whose id comes from a sequence (mirrors SERIAL_TABLES on the main side). */
const SERIAL = new Set(${JSON.stringify([...SERIAL_TABLES])});

let pool = null, txClient = null;
const reply = (obj) => {
  const b = enc.encode(JSON.stringify(obj));
  if (b.length > data.length) { hdr[5] = 0; hdr[1] = Atomics.load(hdr, 0); Atomics.notify(hdr, 1); return; }
  data.set(b, 0); hdr[5] = b.length; hdr[1] = Atomics.load(hdr, 0); Atomics.notify(hdr, 1);
};

async function runOne(req) {
  if (req.op === "begin") { if (txClient) throw new Error("nested transaction"); txClient = await pool.connect(); await txClient.query("BEGIN"); return { ok: true, rows: [], changes: 0, id: 0 }; }
  if (req.op === "commit") { await txClient.query("COMMIT"); txClient.release(); txClient = null; return { ok: true, rows: [], changes: 0, id: 0 }; }
  if (req.op === "rollback") { await txClient.query("ROLLBACK"); txClient.release(); txClient = null; return { ok: true, rows: [], changes: 0, id: 0 }; }
  if (req.op === "close") return { ok: true, rows: [], changes: 0, id: 0 };
  // the main side already translated the query (translateForPg); this just runs it
  const r = await (req.tx && txClient ? txClient : pool).query({ text: req.sql, values: req.params || [] });
  return { ok: true, rows: r.rows, changes: r.rowCount == null ? 0 : r.rowCount };
}

async function handle(seq) {
  let req;
  try { req = JSON.parse(dec.decode(data.subarray(0, hdr[4]))); } catch { reply({ ok: false, message: "bad_request" }); return; }
  try { reply(await runOne(req)); }
  catch (e) { reply({ ok: false, message: String(e.message || e), code: String(e.code || ""), sql: e.code === "42601" ? req.sql : undefined }); }
}

async function main() {
  try {
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 8000, statement_timeout: 20000, idleTimeoutMillis: 30000, application_name: "maison-setter" });
    await pool.query("SELECT 1");
    await pool.query(schema);
    await pool.query(newTables);
    // add columns that an older PostgreSQL database is missing
    const have = {};
    for (const [t, c, ddl] of adds) {
      if (!have[t]) have[t] = new Set((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((r) => r.column_name));
      if (!have[t].has(c)) {
        await pool.query("ALTER TABLE " + t + " ADD COLUMN " + c + " " + ddl.split("INTEGER").join("BIGINT").split("REAL").join("DOUBLE PRECISION"));
        have[t].add(c);
        if (t === "leads" && c === "gate") await pool.query("UPDATE leads SET gate = 'legacy'");
      }
    }
    for (const sql of indexes) { try { await pool.query(sql); } catch (e) { /* old data with duplicates keeps running; the app checks in code too */ } }
    await pool.query("UPDATE accounts SET state = 'killed', reason = 'Finding now happens through imports, so finder accounts are no longer used.' WHERE kind = 'finder' AND state != 'killed'");
    hdr[2] = 1; Atomics.notify(hdr, 2);
  } catch (e) {
    const b = enc.encode(JSON.stringify({ ok: false, message: String(e.message || e) }));
    if (b.length <= data.length) { data.set(b, 0); hdr[5] = b.length; }
    hdr[2] = -1; Atomics.notify(hdr, 2);
    return;
  }

  let seen = 0;
  for (;;) {
    Atomics.wait(hdr, 0, seen);
    seen = Atomics.load(hdr, 0);
    await handle(seen);
  }
}
process.on("message", (m) => { if (m === "close") process.exit(0); });
main().catch((e) => {
  const b = enc.encode(JSON.stringify({ ok: false, message: String(e.message || e) }));
  if (b.length <= data.length) { data.set(b, 0); hdr[5] = b.length; }
  hdr[2] = -1; Atomics.notify(hdr, 2);
});
`;

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'America/New_York',
  offer TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT 'friendly, short, casual', booking_link TEXT NOT NULL DEFAULT '',
  opener_template TEXT NOT NULL DEFAULT '', followups TEXT NOT NULL DEFAULT '[]',
  auto_reply BIGINT NOT NULL DEFAULT 0, auto_approve_pass BIGINT NOT NULL DEFAULT 0, auto_reject_no BIGINT NOT NULL DEFAULT 1,
  daily_cap BIGINT NOT NULL DEFAULT 20, send_start BIGINT NOT NULL DEFAULT 9, send_end BIGINT NOT NULL DEFAULT 20,
  active BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('sender','finder')), label TEXT NOT NULL,
  client_id BIGINT REFERENCES clients(id), ig_username TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  ig_age TEXT NOT NULL DEFAULT 'young', state TEXT NOT NULL DEFAULT 'active', reason TEXT NOT NULL DEFAULT '',
  cooldown_until BIGINT NOT NULL DEFAULT 0, warm_started_at BIGINT NOT NULL, profiles_per_day BIGINT NOT NULL DEFAULT 40,
  daily_cap_override BIGINT, last_seen_at BIGINT, last_version TEXT, last_mode TEXT, logged_in_as TEXT,
  replaced_by BIGINT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, account_id BIGINT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS events_acc ON events(account_id, at);
CREATE TABLE IF NOT EXISTS lead_types (
  id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', include TEXT NOT NULL DEFAULT '[]', include_mode TEXT NOT NULL DEFAULT 'any',
  exclude TEXT NOT NULL DEFAULT '[]', account_types TEXT NOT NULL DEFAULT '[]', min_followers BIGINT NOT NULL DEFAULT 0,
  max_followers BIGINT NOT NULL DEFAULT 0, active_within_days BIGINT NOT NULL DEFAULT 0, regions TEXT NOT NULL DEFAULT '[]',
  require_contact BIGINT NOT NULL DEFAULT 0, public_only BIGINT NOT NULL DEFAULT 1, borderline TEXT NOT NULL DEFAULT 'haiku',
  enabled BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id BIGSERIAL PRIMARY KEY, lead_type_id BIGINT REFERENCES lead_types(id), kind TEXT NOT NULL, ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'peers', enabled BIGINT NOT NULL DEFAULT 1,
  pause_reason TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'server', created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY, client_id BIGINT REFERENCES clients(id), lead_type_id BIGINT REFERENCES lead_types(id),
  lead_type_name TEXT NOT NULL DEFAULT '', lead_type_desc TEXT NOT NULL DEFAULT '', lead_regions TEXT NOT NULL DEFAULT '[]', source_id BIGINT REFERENCES sources(id), finder_account_id BIGINT, sender_account_id BIGINT,
  username TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  followers BIGINT, following BIGINT, posts BIGINT, is_business BIGINT, external_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', last_post_at BIGINT, captions TEXT NOT NULL DEFAULT '[]',
  surfaced_by TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'pass', needs_haiku BIGINT NOT NULL DEFAULT 0,
  rules_score BIGINT NOT NULL DEFAULT 0, reasons TEXT NOT NULL DEFAULT '[]',
  haiku_status TEXT NOT NULL DEFAULT 'none', haiku_fit TEXT NOT NULL DEFAULT '', haiku_score BIGINT, haiku_reason TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT 'pending', review_reason TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'new',
  opener TEXT NOT NULL DEFAULT '', opener_edited BIGINT NOT NULL DEFAULT 0, contact TEXT NOT NULL DEFAULT '{}',
  enrich_status TEXT NOT NULL DEFAULT 'none', thread_ig TEXT NOT NULL DEFAULT '', follow_step BIGINT NOT NULL DEFAULT 0,
  next_follow_at BIGINT, last_activity_at BIGINT, last_inbound_ts BIGINT NOT NULL DEFAULT 0,
  no_followup BIGINT NOT NULL DEFAULT 0, needs_human BIGINT NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
  reviewed_at BIGINT, booked_at BIGINT,
  found_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS leads_uq ON leads(COALESCE(client_id, 0), username);
CREATE INDEX IF NOT EXISTS leads_client ON leads(client_id, review, stage);
CREATE INDEX IF NOT EXISTS leads_found ON leads(found_at);
CREATE TABLE IF NOT EXISTS claims (username TEXT PRIMARY KEY, client_id BIGINT NOT NULL, claimed_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY, lead_id BIGINT NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, ts BIGINT NOT NULL,
  UNIQUE (lead_id, direction, ts, text));
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY, account_id BIGINT, client_id BIGINT, lead_id BIGINT, type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  not_before BIGINT NOT NULL DEFAULT 0, inbound_at BIGINT, tries BIGINT NOT NULL DEFAULT 0, result_code TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL, done_at BIGINT);
CREATE INDEX IF NOT EXISTS tasks_acc ON tasks(account_id, status, not_before);
CREATE INDEX IF NOT EXISTS tasks_lead ON tasks(lead_id, status);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, calls BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity (id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, account_id BIGINT, lead_id BIGINT, level TEXT NOT NULL DEFAULT 'info', kind TEXT NOT NULL DEFAULT '', text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
CREATE TABLE IF NOT EXISTS supervisor_log (id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, account_id BIGINT, task_id BIGINT, lead_id BIGINT,
  kind TEXT NOT NULL, verdict TEXT NOT NULL, risk BIGINT, reason TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT 'rules', before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'final');
CREATE INDEX IF NOT EXISTS supervisor_at ON supervisor_log(at);
CREATE TABLE IF NOT EXISTS follows (account_id BIGINT NOT NULL, username TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (account_id, username));
`;

const PG_NEW_TABLES = `
CREATE TABLE IF NOT EXISTS appointments (
  id BIGSERIAL PRIMARY KEY, client_id BIGINT REFERENCES clients(id), lead_id BIGINT REFERENCES leads(id),
  title TEXT NOT NULL DEFAULT '', scheduled_at BIGINT, duration_min BIGINT NOT NULL DEFAULT 30, tz TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'call', status TEXT NOT NULL DEFAULT 'booked', source TEXT NOT NULL DEFAULT 'outreach',
  notes TEXT NOT NULL DEFAULT '', value DOUBLE PRECISION NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS appts_client ON appointments(client_id, scheduled_at);
CREATE INDEX IF NOT EXISTS appts_lead ON appointments(lead_id);
CREATE TABLE IF NOT EXISTS opportunities (
  id BIGSERIAL PRIMARY KEY, client_id BIGINT REFERENCES clients(id), lead_id BIGINT REFERENCES leads(id),
  value DOUBLE PRECISION NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', won_reason TEXT NOT NULL DEFAULT '', lost_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, won_at BIGINT, lost_at BIGINT);
CREATE INDEX IF NOT EXISTS opps_client ON opportunities(client_id, status);
CREATE INDEX IF NOT EXISTS opps_lead ON opportunities(lead_id);
CREATE TABLE IF NOT EXISTS lead_tasks (
  id BIGSERIAL PRIMARY KEY, client_id BIGINT REFERENCES clients(id), lead_id BIGINT REFERENCES leads(id),
  title TEXT NOT NULL, due_at BIGINT, priority TEXT NOT NULL DEFAULT 'medium', done BIGINT NOT NULL DEFAULT 0, done_at BIGINT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS ltasks_lead ON lead_tasks(lead_id, done);
CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', client_id BIGINT, lead_id BIGINT, appointment_id BIGINT,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open',
  snooze_until BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, resolved_at BIGINT);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, priority);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key ON alerts(kind, COALESCE(lead_id, 0), COALESCE(client_id, 0)) WHERE status IN ('open','in_progress');
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  client_id BIGINT, lead_id BIGINT, read BIGINT NOT NULL DEFAULT 0, read_at BIGINT, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS notif_read ON notifications(read, created_at);
CREATE TABLE IF NOT EXISTS onboarding (
  id BIGSERIAL PRIMARY KEY, client_id BIGINT UNIQUE REFERENCES clients(id), step BIGINT NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}', completed BIGINT NOT NULL DEFAULT 0, completed_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
`;

function openPg(url) {
  const { Worker } = require("node:worker_threads");
  const CAP = 16 * 1024 * 1024;
  const sab = new SharedArrayBuffer(64 + CAP);
  const hdr = new Int32Array(sab, 0, 8);
  const data = new Uint8Array(sab, 64, CAP);
  const dec = new TextDecoder();

  let worker;
  try {
    worker = new Worker(WORKER_SRC, { eval: true, workerData: { sab, url, schema: PG_SCHEMA, newTables: PG_NEW_TABLES, adds: ADDS, indexes: INDEXES } });
  } catch (e) { throw new Error("Could not start the PostgreSQL worker: " + e.message); }

  let seq = 0, lastResp = 0, txActive = false, txId = 0, dead = false;
  worker.on("exit", () => { dead = true; try { Atomics.store(hdr, 1, seq); Atomics.notify(hdr, 1); } catch { /* nothing waiting */ } });

  /* wait for the worker to be ready (schema applied) or to report a fatal error */
  for (;;) {
    const w = Atomics.wait(hdr, 2, 0, 30_000);
    if (w === "not-equal") break;                      // ready flag was set before we waited
    if (w === "timed-out") { worker.terminate(); throw new Error("The PostgreSQL worker did not start within 30 seconds."); }
    if (Atomics.load(hdr, 2) === -1) { worker.terminate(); throw new Error("PostgreSQL is not usable: " + dec.decode(data.subarray(0, hdr[5]))); }
  }

  const call = (req) => {
    const my = ++seq;
    const bytes = new TextEncoder().encode(JSON.stringify({ ...req, seq: my }));
    if (bytes.length > CAP) throw new Error("db_request_too_large");
    data.set(bytes, 0); hdr[4] = bytes.length;
    Atomics.store(hdr, 0, my); Atomics.notify(hdr, 0);
    for (;;) {
      const w = Atomics.wait(hdr, 1, lastResp, 30_000);
      if (dead) throw new Error("The PostgreSQL worker stopped unexpectedly. Check DATABASE_URL.");
      if (w === "timed-out") continue;                 // keep waiting; the query has its own 20s statement timeout
      const resp = Atomics.load(hdr, 1);
      if (resp !== my) { lastResp = resp; continue; }  // a stale response from an earlier timed-out call
      lastResp = resp;
      break;
    }
    const out = JSON.parse(dec.decode(data.subarray(0, hdr[5])));
    if (out && out.ok === false && out.message === "") throw new Error("db_result_too_large");
    if (!out || out.ok !== true) {
      let msg = out && out.message || "db_error";
      if (out && out.code === "23505") msg = "UNIQUE constraint failed: " + msg;   // same wording SQLite uses, so app code can match /UNIQUE/
      throw new Error(msg + (out && out.code ? ` (pg: ${out.code})` : "") + (out && out.sql ? `\nSQL was: ${out.sql}` : ""));
    }
    return out;
  };

  let txSeq = 0;
  const runSql = (sql, params) => call({ op: "query", sql: translateForPg(sql), params: normParams(params), tx: txActive ? txSeq : 0 });

  const db = wrapper(
    (sql, params) => runSql(sql, params),
    (fn) => {
      if (txActive) throw new Error("nested transaction");
      txActive = true; txSeq = (txSeq + 1) | 0;
      try {
        call({ op: "begin", tx: txSeq });
        const r = fn();
        call({ op: "commit" });
        return r;
      } catch (e) { try { call({ op: "rollback" }); } catch { /* report the original error */ } throw e; }
      finally { txActive = false; }
    },
    () => { setTimeout(() => { try { worker.terminate(); } catch { /* already gone */ } }, 0); }   // the worker parks in Atomics.wait, so terminate is the only way it comes down
  );
  db.url = String(url).replace(/:[^:@/]+@/, ":***@");
  return db;
}

function openDb(target) {
  const t = String(target || "");
  if (/^postgres(ql)?:\/\//i.test(t)) return openPg(t);
  return openSqlite(t);
}
module.exports = { openDb };
