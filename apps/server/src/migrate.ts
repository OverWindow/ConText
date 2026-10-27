import { configFromEnv } from './config.ts';
import { Database } from './database.ts';
const db = new Database(configFromEnv().databaseUrl);
try { await db.migrate(); process.stdout.write('Unified workspace schema is ready.\n'); } finally { await db.close(); }
