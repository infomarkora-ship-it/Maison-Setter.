import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/db.js';

const sql = readFileSync(fileURLToPath(new URL('../src/db/schema.sql', import.meta.url)), 'utf8');
await getPool().query(sql);
console.log('Schema applied.');
await closePool();
