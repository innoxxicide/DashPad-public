// Upstream cache: isolate memory first, then D1 (shared, survives isolates, doubles as "last known good").
// The Cache API is not used: it is a no-op on *.workers.dev.
import { kvGet, kvPut } from './kv';

export const UA = 'DashPad/0.2';

export interface FeedResult<T> {
  value: T;
  fetchedAt: number;
  stale: boolean; // true when the upstream failed and we serve the last good value
  error?: string;
}

const mem = new Map<string, { at: number; value: unknown }>();
const failUntil = new Map<string, number>();
const RETRY_AFTER_FAIL_MS = 30_000;

export async function feed<T>(db: D1Database, key: string, ttlMs: number, load: () => Promise<T>): Promise<FeedResult<T>> {
  const now = Date.now();
  const m = mem.get(key);
  if (m && now - m.at < ttlMs) return { value: m.value as T, fetchedAt: m.at, stale: false };

  const row = (await kvGet(db, ['feed:' + key]))['feed:' + key];
  const stored = row ? (JSON.parse(row.v) as { at: number; value: T }) : null;
  if (stored && now - stored.at < ttlMs) {
    mem.set(key, stored);
    return { value: stored.value, fetchedAt: stored.at, stale: false };
  }
  if (stored && (failUntil.get(key) ?? 0) > now) return { value: stored.value, fetchedAt: stored.at, stale: true, error: 'retrying soon' };

  try {
    const value = await load();
    const rec = { at: Date.now(), value };
    mem.set(key, rec);
    failUntil.delete(key);
    await kvPut(db, 'feed:' + key, JSON.stringify(rec));
    return { value, fetchedAt: rec.at, stale: false };
  } catch (e) {
    failUntil.set(key, now + RETRY_AFTER_FAIL_MS);
    if (stored) return { value: stored.value, fetchedAt: stored.at, stale: true, error: String(e) };
    throw e;
  }
}

export async function getJson<T = unknown>(url: string, headers: Record<string, string> = {}, timeoutMs = 12_000): Promise<T> {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
  return (await r.json()) as T;
}
