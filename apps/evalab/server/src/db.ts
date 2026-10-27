import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';

export function createPool(databaseUrl: string, schema: string): Pool {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid DB schema');
  const requested = Number(process.env.PG_POOL_MAX ?? 5);
  const max = Number.isInteger(requested) && requested >= 1 && requested <= 20 ? requested : 5;
  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 20000,
    application_name: '110lab-assessment',
    options: `-c search_path=${schema},public`,
  });
  pool.on('error', (err: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ component: 'db', event: 'pool-error', code: err.code ?? 'unknown' }));
  });
  return pool;
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already lost */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`110lab-migrate-${schema}`]);
    for (const id of ['001_init', '002_oauth', '003_direct_upload', '004_admin_deletion', '005_exam_duration', '006_registration_protection', '007_public_identity']) {
      const reg = await client.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [`${schema}.schema_migrations`]);
      if (reg.rows[0]?.name) {
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
        if ((done.rowCount ?? 0) > 0) continue;
      }
      const sql = await readFile(new URL(`../migrations/${id}.sql`, import.meta.url), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`110lab-migrate-${schema}`]).catch(() => undefined);
    client.release();
  }
}
