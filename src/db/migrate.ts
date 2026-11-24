import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db.js';

/** Idempotent: creates or upgrades the schema in place. Safe to run on every boot. */
export async function applySchema(): Promise<void> {
  const sql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await getPool().query(sql);
}
