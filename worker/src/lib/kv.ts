// One small key/value table in D1 holds everything: settings, feed caches, the progress mirror.
let schemaReady = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL)').run();
  schemaReady = true;
}

export type KvRow = { v: string; updated: number };

export async function kvGet(db: D1Database, keys: string[]): Promise<Record<string, KvRow>> {
  await ensureSchema(db);
  const marks = keys.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT k, v, updated FROM kv WHERE k IN (${marks})`)
    .bind(...keys)
    .all<{ k: string; v: string; updated: number }>();
  return Object.fromEntries(results.map((r) => [r.k, { v: r.v, updated: r.updated }]));
}

export function kvPutStmt(db: D1Database, k: string, v: string, now = Date.now()): D1PreparedStatement {
  return db
    .prepare('INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated')
    .bind(k, v, now);
}

export async function kvPut(db: D1Database, k: string, v: string): Promise<void> {
  await ensureSchema(db);
  await kvPutStmt(db, k, v).run();
}

export async function kvAges(db: D1Database, prefix: string): Promise<{ k: string; updated: number }[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare('SELECT k, updated FROM kv WHERE k LIKE ? ORDER BY k')
    .bind(prefix + '%')
    .all<{ k: string; updated: number }>();
  return results;
}
