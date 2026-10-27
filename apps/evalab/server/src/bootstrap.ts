import type { Pool } from 'pg';
import { hashPassword } from './security.js';
import { withTx } from './db.js';
import type { StartupSecrets } from './config.js';

export async function bootstrapAdmin(pool: Pool, startup: StartupSecrets): Promise<void> {
  if (!startup.adminEmail || !startup.adminPassword) return;
  const email = startup.adminEmail;
  await withTx(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['110lab-admin-bootstrap']);
    const existing = await client.query<{ id: string; role: string }>(
      'SELECT id, role FROM users WHERE email = $1 FOR UPDATE',
      [email],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.role !== 'ADMIN') {
        console.error(JSON.stringify({ component: 'bootstrap', event: 'admin-email-belongs-to-candidate' }));
      }
      return;
    }
    const password = startup.adminPassword;
    if (!password) return;
    const passwordHash = await hashPassword(password);
    await client.query(
      `INSERT INTO users (role, name, email, password_hash) VALUES ('ADMIN', $1, $2, $3)`,
      [startup.adminName, email, passwordHash],
    );
  });
}
