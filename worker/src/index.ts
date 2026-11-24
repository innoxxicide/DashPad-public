// DashPad Worker: data feeds for the tablet dashboard + the multi-account «Ход работ» mirror.
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { alertStatus, confirmedAt, loadAlerts, type WatchIds } from './adapters/alerts';
import {
  dtekGroups,
  dtekHomeNum,
  dtekStreets,
  housesFrom,
  loadDtekSnapshot,
  loadSvitlo,
  normalizeDtek,
  normalizeSvitlo,
  OUTAGE_REGIONS,
  parseDtekStamp,
  pickAnchor,
  withToday,
  type OutageDay,
  type OutageFeed,
} from './adapters/outages';
import { loadRegions, regionNames } from './adapters/regions';
import { loadWeather } from './adapters/weather';
import { feed } from './lib/feed';
import { kvAges, kvGet, kvPut, kvPutStmt, ensureSchema } from './lib/kv';
import { progressPage } from './progress';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from './settings';

type Bindings = {
  DB: D1Database;
  PROGRESS_WRITE_KEY: string;
  DASHPAD_READ_KEY: string; // the "device key": tablet, dashboard page, settings
  ALERTS_IN_UA_TOKEN?: string;
};
type Ctx = Context<{ Bindings: Bindings }>;

const VERSION = '0.5.1';
const MAX_BODY = 1_500_000; // D1 rows are capped at ~2 MB
const MAX_SETTINGS = 16_000; // the largest real settings patch (weather) is under 300 chars
const MIN = 60_000;
const TTL = {
  alerts: 10_000, // with the tablet polling every 15 s, an alert change shows up within ~25 s
  weather: 15 * MIN,
  dtekFact: 5 * MIN,
  svitlo: 10 * MIN,
  regions: 24 * 60 * MIN,
  dtekStreets: 24 * 60 * MIN,
  dtekAnchor: 7 * 24 * 60 * MIN,
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('/api/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'If-None-Match'], exposeHeaders: ['ETag'] }));
app.onError((err, c) => c.json({ error: err.message }, 500));

// ---------------- auth ----------------
async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
function presentedKey(c: Ctx): string {
  const h = c.req.header('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : c.req.query('k') || '';
}
const canRead = (c: Ctx) => sameSecret(presentedKey(c), c.env.DASHPAD_READ_KEY);
const canWrite = (c: Ctx) => sameSecret(presentedKey(c), c.env.PROGRESS_WRITE_KEY);
const forbidden = (c: Ctx) => c.json({ error: 'forbidden' }, 403);

// ---------------- settings ----------------
async function loadSettings(db: D1Database): Promise<Settings> {
  const row = (await kvGet(db, ['settings'])).settings;
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const s = JSON.parse(row.v) as Partial<Settings>;
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...s,
    display: { ...DEFAULT_SETTINGS.display, ...(s.display ?? {}) },
    progress: { ...DEFAULT_SETTINGS.progress, ...(s.progress ?? {}) },
  };
}

app.get('/api/settings', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  return c.json(await loadSettings(c.env.DB));
});

app.put('/api/settings', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const raw = await c.req.text();
  if (raw.length > MAX_SETTINGS) return c.json({ error: 'too large' }, 413);
  let patch: unknown;
  try {
    patch = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  try {
    const next = mergeSettings(await loadSettings(c.env.DB), patch);
    await kvPut(c.env.DB, 'settings', JSON.stringify(next));
    return c.json(next);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// ---------------- weather ----------------
app.get('/api/weather', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const s = await loadSettings(c.env.DB);
  const lat = Number(c.req.query('lat') ?? s.weather.lat);
  const lon = Number(c.req.query('lon') ?? s.weather.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return c.json({ error: 'lat/lon' }, 400);
  const f = await feed(c.env.DB, `weather:${lat.toFixed(3)},${lon.toFixed(3)}`, TTL.weather, () => loadWeather(lat, lon));
  return c.json({ ...f.value, name: c.req.query('lat') ? null : s.weather.name, fetchedAt: f.fetchedAt, stale: f.stale });
});

// ---------------- alerts ----------------
async function regionsFeed(db: D1Database) {
  return feed(db, 'regions', TTL.regions, loadRegions);
}

app.get('/api/alerts', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  let ids: WatchIds;
  const q = c.req.query('ids');
  if (q) {
    const [oblast, raion, hromada] = q.split(',');
    ids = { oblast, raion, hromada };
  } else {
    ids = (await loadSettings(c.env.DB)).alerts;
  }
  const [a, regions] = await Promise.all([
    loadAlerts(c.env.DB, c.env.ALERTS_IN_UA_TOKEN, TTL.alerts),
    regionsFeed(c.env.DB).catch(() => null),
  ]);
  const status = alertStatus(a.list, ids, regionNames(regions?.value ?? []), a.fetchedAt);
  // ageMs counts from the latest confirmation of the shown state, on the Worker clock
  return c.json({ ...status, primaryStale: !!a.list.primaryStale, fetchedAt: a.fetchedAt, ageMs: Math.max(0, Date.now() - confirmedAt(status, a)), stale: a.stale });
});

app.get('/api/regions', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const f = await regionsFeed(c.env.DB);
  return c.json({ regions: f.value, fetchedAt: f.fetchedAt });
});

// ---------------- outages ----------------
async function dtekAnchor(db: D1Database, host: string) {
  return (await feed(db, `dtek-anchor:${host}`, TTL.dtekAnchor, async () => pickAnchor(await dtekStreets(host)))).value;
}

async function outages(db: D1Database, regionId: string, group: string | null): Promise<OutageFeed & { groups: string[] }> {
  const reg = OUTAGE_REGIONS[regionId];
  const out: OutageFeed & { groups: string[] } = {
    provider: 'none',
    region: regionId,
    regionName: reg.name,
    group,
    days: [],
    emergency: null,
    sourceUpdatedAt: null,
    fetchedAt: null,
    stale: false,
    errors: [],
    groups: [],
  };
  let dtekDays: OutageDay[] | null = null;
  try {
    const f = await feed(db, `dtek-fact:${reg.dtekHost}`, TTL.dtekFact, async () => loadDtekSnapshot(reg.dtekHost, await dtekAnchor(db, reg.dtekHost)));
    out.groups = dtekGroups(f.value);
    if (group) dtekDays = normalizeDtek(f.value, group);
    out.provider = 'dtek';
    out.sourceUpdatedAt = parseDtekStamp(f.value.fact.update) ?? null;
    out.fetchedAt = f.fetchedAt;
    out.stale = f.stale;
    if (f.error) out.errors.push(f.error);
  } catch (e) {
    out.errors.push((e as Error).message);
  }
  try {
    const s = await feed(db, `svitlo:${reg.svitloCpu}`, TTL.svitlo, () => loadSvitlo(reg.svitloCpu));
    out.emergency = s.value.emergency;
    if (!out.groups.length) out.groups = Object.keys(s.value.schedule).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (group && (!dtekDays || out.stale)) {
      const sd = normalizeSvitlo(s.value, group);
      if (sd.length) {
        dtekDays = sd;
        out.provider = 'svitlo.live';
        out.sourceUpdatedAt = s.value.snapshotAt || null;
        out.fetchedAt = s.fetchedAt;
        out.stale = s.stale;
      }
    }
  } catch (e) {
    out.errors.push((e as Error).message);
  }
  out.days = withToday(dtekDays ?? []);
  return out;
}

app.get('/api/outages', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const s = await loadSettings(c.env.DB);
  const region = c.req.query('region') ?? s.outages.region;
  const group = c.req.query('group') ?? s.outages.group ?? null;
  if (!OUTAGE_REGIONS[region]) return c.json({ error: `region: one of ${Object.keys(OUTAGE_REGIONS).join(', ')}` }, 400);
  return c.json(await outages(c.env.DB, region, group));
});

app.get('/api/outages/regions', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  return c.json(Object.entries(OUTAGE_REGIONS).map(([id, r]) => ({ id, name: r.name })));
});

// Address lookup for the settings page: settlements → streets → houses (with their groups).
app.get('/api/outages/streets', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const reg = OUTAGE_REGIONS[c.req.query('region') ?? ''];
  if (!reg) return c.json({ error: 'region' }, 400);
  const f = await feed(c.env.DB, `dtek-streets:${reg.dtekHost}`, TTL.dtekStreets, () => dtekStreets(reg.dtekHost));
  const city = c.req.query('city');
  if (!city) {
    const q = (c.req.query('q') ?? '').toLocaleLowerCase('uk');
    const all = Object.keys(f.value).sort((a, b) => a.localeCompare(b, 'uk'));
    return c.json({ settlements: q ? all.filter((n) => n.toLocaleLowerCase('uk').includes(q)).slice(0, 50) : all });
  }
  const streets = Object.hasOwn(f.value, city) ? f.value[city] : null;
  if (!streets) return c.json({ error: 'unknown settlement' }, 404);
  return c.json({ city, streets: [...streets].sort((a, b) => a.localeCompare(b, 'uk')) });
});

app.get('/api/outages/houses', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const reg = OUTAGE_REGIONS[c.req.query('region') ?? ''];
  const city = c.req.query('city');
  const street = c.req.query('street');
  if (!reg || !city || !street) return c.json({ error: 'region, city, street' }, 400);
  const j = await dtekHomeNum(reg.dtekHost, city, street);
  return c.json({ city, street, houses: housesFrom(j) });
});

// ---------------- health ----------------
app.get('/api/health', async (c) => {
  const now = Date.now();
  const base = { ok: true, version: VERSION };
  if (!(await canRead(c))) return c.json(base);
  const rows = await kvAges(c.env.DB, 'feed:');
  const hb = (await kvGet(c.env.DB, ['heartbeat'])).heartbeat;
  return c.json({
    ...base,
    alertsSource: (c.env.ALERTS_IN_UA_TOKEN ? 'alerts.in.ua → siren' : 'siren') + ' + cross-check vadimklimenko.com',
    // The Android ⚙ panel maps these keys by prefix (alerts:active, dtek-fact:, svitlo:, weather:).
    feeds: rows.map((r) => ({ key: r.k.slice(5), ageSec: Math.round((now - r.updated) / 1000) })),
    publisherHeartbeatAgeSec: hb ? Math.round((now - Number(hb.v)) / 1000) : null,
  });
});

// ---------------- «Ход работ» mirror ----------------
// Publisher on the PC → Worker. Body: { heartbeat, docs?, stamp?, template? }
app.post('/api/progress', async (c) => {
  if (!(await canWrite(c))) return forbidden(c);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json({ error: 'too large' }, 413);
  let body: { heartbeat?: number; docs?: unknown; stamp?: number; template?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const now = Date.now();
  const db = c.env.DB;
  await ensureSchema(db);
  const ops = [kvPutStmt(db, 'heartbeat', String(now), now)];
  if (body.docs !== undefined) {
    if (typeof body.docs !== 'object' || body.docs === null || Array.isArray(body.docs)) return c.json({ error: 'docs must be an object' }, 400);
    ops.push(kvPutStmt(db, 'docs', JSON.stringify({ docs: body.docs, stamp: Number(body.stamp) || now }), now));
  }
  if (typeof body.template === 'string' && body.template.length > 0) ops.push(kvPutStmt(db, 'template', body.template, now));
  await db.batch(ops);
  return c.json({ ok: true, stored: ops.length });
});

app.get('/api/progress', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const kv = await kvGet(c.env.DB, ['docs', 'heartbeat']);
  const docs = kv.docs ? (JSON.parse(kv.docs.v) as { docs: Record<string, unknown>; stamp: number }) : { docs: {}, stamp: 0 };
  const heartbeat = kv.heartbeat ? Number(kv.heartbeat.v) : 0;
  const etag = `"${docs.stamp}-${heartbeat}"`;
  const headers = { ETag: etag, 'Cache-Control': 'no-store' };
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
  return c.json({ docs: docs.docs, stamp: docs.stamp, heartbeat }, 200, headers);
});

app.get('/progress', async (c) => {
  if (!(await canRead(c))) return c.text('forbidden', 403);
  const [kv, s] = await Promise.all([kvGet(c.env.DB, ['template']), loadSettings(c.env.DB)]);
  return c.html(progressPage(kv.template?.v ?? null, presentedKey(c), s.progress.staleHours), 200, { 'Cache-Control': 'no-store' });
});

// ---------------- standup brief ----------------
// Publisher on the PC → Worker. Body: { html, generatedAt } (epoch ms of the file's mtime)
const MAX_BRIEF = 256_000;

app.post('/api/brief', async (c) => {
  if (!(await canWrite(c))) return forbidden(c);
  const raw = await c.req.text();
  if (raw.length > MAX_BRIEF) return c.json({ error: 'too large' }, 413);
  let body: { html?: unknown; generatedAt?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const { html, generatedAt } = body ?? {};
  if (typeof html !== 'string' || !html.trim()) return c.json({ error: 'html must be a non-empty string' }, 400);
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt) || !(generatedAt > 1e12)) return c.json({ error: 'generatedAt must be epoch ms' }, 400);
  if (generatedAt > Date.now() + 10 * 60_000) return c.json({ error: 'generatedAt is in the future' }, 400);
  const stored = (await kvGet(c.env.DB, ['brief'])).brief;
  // 200, not an error: the publisher retries any non-200, and a temp cleanup can surface an older file.
  if (stored && (JSON.parse(stored.v) as { generatedAt: number }).generatedAt >= generatedAt) return c.json({ ok: true, ignored: true });
  await kvPut(c.env.DB, 'brief', JSON.stringify({ html, generatedAt }));
  return c.json({ ok: true });
});

app.get('/api/brief', async (c) => {
  if (!(await canRead(c))) return forbidden(c);
  const row = (await kvGet(c.env.DB, ['brief'])).brief;
  const brief = row ? (JSON.parse(row.v) as { html: string; generatedAt: number }) : null;
  return c.json({ brief }, 200, { 'Cache-Control': 'no-store' });
});

// Everything else (/, /assets/*, /sw.js, /version.json) is the dashboard build, served as static assets.
export default app;
