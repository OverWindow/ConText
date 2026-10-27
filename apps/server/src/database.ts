import pg, { type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
export type DB = PoolClient;
export class Database {
  pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({connectionString:url,max:10,connectionTimeoutMillis:5000}); }
  async transaction<T>(fn: (client: DB) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query(`BEGIN ISOLATION LEVEL ${isolation}`); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async migrate() {
    await this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock($1)',[804209106]);
      await db.query(await readFile(new URL('../migrations/0001_unified.sql',import.meta.url),'utf8'));
    });
  }
  async close() { await this.pool.end(); }
}
