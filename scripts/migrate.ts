import { applySchema } from '../src/db/migrate.js';
import { closePool } from '../src/db.js';

await applySchema();
console.log('Schema applied.');
await closePool();
