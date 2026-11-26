/* One-time migration: copy an existing SQLite database into PostgreSQL.
   Run it ONCE on the machine that has the old data file (your laptop, the VPS), pointing at the new
   Postgres URL, BEFORE switching the server over:

       node scripts/migrate-sqlite-to-postgres.js data/magnetengine.db "$DATABASE_URL"

   What it does:
     - applies the full schema to PostgreSQL (the same thing the server does on start),
     - copies every table row by row in batches, keeping the original ids,
     - moves each id sequence past the highest copied id so new rows never collide,
   It is safe to re-run: rows that already exist (by primary key) are skipped.
   Progress prints per table. The server should be STOPPED while this runs. */
const fs = require("node:fs");
const path = require("node:path");

const sqliteFile = process.argv[2];
const pgUrl = process.argv[3];
if (!sqliteFile || !pgUrl || !/^postgres(ql)?:\/\//.test(pgUrl)) {
  console.error("Usage: node scripts/migrate-sqlite-to-postgres.js <sqlite-file> <postgres-url>");
  process.exit(1);
}
if (!fs.existsSync(sqliteFile)) { console.error(`No such file: ${sqliteFile}`); process.exit(1); }

const { DatabaseSync } = require("node:sqlite");
const { Client } = require("pg");

/* Copy order respects foreign keys. pk: how re-runs detect already-copied rows. */
const TABLES = [
  { name: "clients", pk: "id" },
  { name: "accounts", pk: "id" },
  { name: "lead_types", pk: "id" },
  { name: "sources", pk: "id" },
  { name: "leads", pk: "id" },
  { name: "messages", pk: "id" },
  { name: "tasks", pk: "id" },
  { name: "events", pk: "id" },
  { name: "activity", pk: "id" },
  { name: "supervisor_log", pk: "id" },
  { name: "claims", pk: "username" },
  { name: "follows", pk: null },
  { name: "usage", pk: "day" },
  { name: "settings", pk: "key" },
  { name: "appointments", pk: "id" },
  { name: "opportunities", pk: "id" },
  { name: "lead_tasks", pk: "id" },
  { name: "alerts", pk: "id" },
  { name: "notifications", pk: "id" },
  { name: "onboarding", pk: "id" }
];
const BATCH = 200;

async function main() {
  const lite = new DatabaseSync(sqliteFile, { readOnly: true });
  const pg = new Client({ connectionString: pgUrl });
  await pg.connect();
  console.log("Connected. Applying schema to PostgreSQL…");

  // apply the exact schema the server would (additive, idempotent)
  const { openDb } = require(path.join(__dirname, "..", "src", "db.js"));
  const probe = openDb(pgUrl);   // creates schema + columns + indexes, then we drop the probe worker
  probe.close();
  console.log("Schema ready. Copying data…");

  let grand = 0;
  for (const t of TABLES) {
    const rows = lite.prepare(`SELECT * FROM ${t.name}`).all();
    let copied = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map((c) => {
        const v = row[c];
        return v === undefined ? null : typeof v === "bigint" ? Number(v) : v;
      });
      const ph = cols.map((_, k) => "$" + (k + 1)).join(", ");
      const onConflict = t.pk ? ` ON CONFLICT (${t.pk}) DO NOTHING` : " ON CONFLICT DO NOTHING";
      const r = await pg.query(`INSERT INTO ${t.name}(${cols.join(", ")}) VALUES(${ph})${onConflict}`, values);
      copied += r.rowCount || 0;
    }
    grand += copied;
    // keep the id sequence ahead of the copied rows
    if (t.pk === "id" && rows.length) {
      await pg.query(`SELECT setval(pg_get_serial_sequence('${t.name}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t.name}), 1))`);
    }
    console.log(`  ${t.name}: ${rows.length} row${rows.length === 1 ? "" : "s"} (${copied} new)`);
  }
  await pg.end();
  console.log(`Done. ${grand} rows copied. You can point the server at DATABASE_URL now.`);
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
