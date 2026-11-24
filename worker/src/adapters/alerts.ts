// Air-raid alerts.
//   Primary: alerts.in.ua (only with a token) or siren.pp.ua (no key; wrapper of ukrainealarm).
//   Cross-check: vadimklimenko.com/map/statuses.json (no key, independent, oblast + raion with change times).
// siren.pp.ua sits behind a proxy cache that serves STALE or UPDATING copies when its upstream is slow;
// such a copy counts as a siren failure. Each source is cached in its own feed, so the cross-check still runs while
// siren fails: when the two sources disagree, the one with the more recent state change wins; when one
// sees an alert and the other has nothing newer, the alert is shown (a false alarm is better than a missed one).
// Kyiv oblast often has raion-level alerts only, so the status checks oblast + raion + hromada together.
import { feed, getJson, UA } from '../lib/feed';
import type { Region } from './regions';

export type AlertLevel = 'red' | 'yellow' | null;
export interface ActiveAlert {
  regionId: string;
  type: string; // air | artillery | urban_fights | chemical | nuclear | other
  level: AlertLevel;
  since: string | null;
  threats: string[];
}
/** Cross-check state of one oblast or raion, keyed by normalized name. */
export interface CrossState {
  active: boolean;
  level: AlertLevel;
  changedAt: string | null; // enabled_at when active, disabled_at when not
}
export interface ActiveList {
  source: 'alerts.in.ua' | 'siren';
  alerts: ActiveAlert[];
  primaryStale?: boolean; // legacy: only in rows a 0.5.0 Worker wrote
  cross?: Record<string, CrossState>; // vadimklimenko.com, by normalized region name
}
export interface WatchIds {
  oblast: string;
  raion?: string;
  hromada?: string;
}
export interface AlertStatus {
  active: boolean;
  level: AlertLevel;
  scope: 'oblast' | 'raion' | 'hromada' | null; // the broadest area that is under alert
  since: string | null;
  types: string[];
  threats: string[];
  matches: { regionId: string; name: string; type: string; level: AlertLevel; since: string | null }[];
  watched: { regionId: string; name: string; scope: 'oblast' | 'raion' | 'hromada' }[];
  source: ActiveList['source'];
  crossChecked: boolean;
  corrected: boolean; // the cross-check overruled the primary source
  crossConfirmed: boolean; // a fresh cross-check sees the displayed state at oblast/raion scope
}

const rank = (l: AlertLevel) => (l === 'red' ? 2 : l === 'yellow' ? 1 : 0);
const maxLevel = (a: AlertLevel, b: AlertLevel): AlertLevel => (rank(a) >= rank(b) ? a : b);
const ms = (s: string | null | undefined) => (s ? Date.parse(s.replace(/(\.\d{3})\d+/, '$1')) : NaN);
const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : ms(a) <= ms(b) ? a : b);
const toLevel = (v: unknown): AlertLevel => {
  const s = String(v ?? '').toLowerCase();
  return s === 'red' ? 'red' : s === 'yellow' ? 'yellow' : null;
};
export const normName = (s: string) => s.toLocaleLowerCase('uk').replace(/[’'ʼ`]/g, "'").replace(/\s+/g, ' ').trim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromSiren(list: any[]): ActiveList {
  const alerts: ActiveAlert[] = [];
  for (const region of list) {
    for (const a of region.activeAlerts ?? []) {
      let level: AlertLevel = null;
      let since: string | null = null;
      for (const lv of a.activeAlertLevels ?? []) {
        level = maxLevel(level, toLevel(lv.alertLevel));
        since = earliest(since, lv.createdAt ?? null);
      }
      alerts.push({ regionId: String(a.regionId ?? region.regionId), type: String(a.type).toLowerCase(), level, since: since ?? a.lastUpdate ?? null, threats: [] });
    }
  }
  return { source: 'siren', alerts };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromAlertsInUa(j: any): ActiveList {
  const alerts: ActiveAlert[] = (j.alerts ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((a: any) => !a.finished_at)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((a: any) => ({
      regionId: String(a.location_uid),
      type: a.alert_type === 'air_raid' ? 'air' : String(a.alert_type),
      level: toLevel(a.alert_level),
      since: a.started_at ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      threats: [...new Set<string>((a.threats ?? []).map((t: any) => String(t.threat_type)))],
    }));
  return { source: 'alerts.in.ua', alerts };
}

/** vadimklimenko.com/map/statuses.json → states and districts by normalized name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromKlymenko(j: any): Record<string, CrossState> {
  const out: Record<string, CrossState> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const put = (name: string, v: any) => {
    const active = !!v.enabled;
    out[normName(name)] = { active, level: active ? toLevel(v.alert_level) ?? 'red' : null, changedAt: (active ? v.enabled_at : v.disabled_at) ?? null };
  };
  for (const [name, st] of Object.entries(j.states ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = st as any;
    put(name, s);
    for (const [dn, dv] of Object.entries(s.districts ?? {})) put(dn, dv);
  }
  return out;
}

const PRIMARY_LAG_MS = 10_000; // siren's snapshot trails ukrainealarm by ~1-2 s

export function alertStatus(list: ActiveList, ids: WatchIds, names: Map<string, Region>, primaryAt: number): AlertStatus {
  const scopes: [keyof WatchIds, string | undefined][] = [['oblast', ids.oblast], ['raion', ids.raion], ['hromada', ids.hromada]];
  const watched = scopes.filter(([, id]) => id).map(([scope, id]) => ({ regionId: id!, name: names.get(id!)?.name ?? id!, scope }));
  const cross = list.cross;
  const crossFor = (name: string | undefined) => (cross && name ? cross[normName(name)] : undefined);
  const raionName = ids.raion ? names.get(ids.raion)?.name : undefined;
  let corrected = false;

  const hits: ActiveAlert[] = [];
  const confirmed = new Set<ActiveAlert>();
  for (const w of watched) {
    const own = list.alerts.filter((a) => a.regionId === w.regionId);
    // a hromada has no cross-check entry: its raion's state decides whether the primary is stale
    const x = crossFor(w.scope === 'hromada' ? raionName : w.name);
    if (!x) {
      hits.push(...own);
      continue;
    }
    if (!x.active) {
      // an all-clear ends only the air alerts that started before it
      const kept = own.filter((a) => !(a.type === 'air' && x.changedAt && a.since && ms(x.changedAt) > ms(a.since)));
      if (kept.length < own.length) corrected = true;
      hits.push(...kept);
    } else if (w.scope !== 'hromada') {
      const air = own.filter((a) => a.type === 'air');
      // Klymenko saw this alert start after the primary last confirmed: the stored air alerts are an older one
      const newer = !!x.changedAt && ms(x.changedAt) > primaryAt - PRIMARY_LAG_MS && air.every((a) => !a.since || ms(a.since) < ms(x.changedAt!));
      if (air.length && !newer) {
        hits.push(...own);
        air.forEach((a) => confirmed.add(a));
      } else {
        corrected = true; // the primary missed or outlived an alert the cross-check sees
        const k: ActiveAlert = { regionId: w.regionId, type: 'air', level: x.level, since: x.changedAt, threats: [] };
        hits.push(...own.filter((a) => a.type !== 'air'), k);
        confirmed.add(k);
      }
    } else {
      hits.push(...own);
    }
  }

  const seen = watched.filter((w) => w.scope !== 'hromada').map((w) => crossFor(w.name));
  // Klymenko cannot see a hromada, so an all-clear is confirmed only when no hromada is watched
  const crossConfirmed = hits.length ? hits.every((h) => confirmed.has(h)) : seen.length > 0 && seen.length === watched.length && seen.every((x) => !!x && !x.active);
  const scopeOf = new Map(watched.map((w) => [w.regionId, w.scope]));
  let level: AlertLevel = null;
  let since: string | null = null;
  for (const h of hits) {
    level = maxLevel(level, h.level);
    since = earliest(since, h.since);
  }
  const order = ['oblast', 'raion', 'hromada'] as const;
  const scope = order.find((s) => hits.some((h) => scopeOf.get(h.regionId) === s)) ?? null;
  return {
    active: hits.length > 0,
    level: hits.length && !level ? 'red' : level, // an alert without a level is treated as a full alert
    scope,
    since,
    types: [...new Set(hits.map((h) => h.type))],
    threats: [...new Set(hits.flatMap((h) => h.threats))],
    matches: hits.map((h) => ({ regionId: h.regionId, name: names.get(h.regionId)?.name ?? h.regionId, type: h.type, level: h.level, since: h.since })),
    watched,
    source: list.source,
    crossChecked: !!cross,
    corrected,
    crossConfirmed,
  };
}

const TIMEOUT_MS = 5_000; // per upstream call; with a token the primary may take 5 s + 5 s, still under the page's 15 s abort
const KLYMENKO_URL = 'https://vadimklimenko.com/map/statuses.json';

async function loadSiren(): Promise<ActiveList> {
  const r = await fetch('https://siren.pp.ua/api/v3/alerts', { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`siren.pp.ua: HTTP ${r.status}`);
  const cache = (r.headers.get('x-cache-status') ?? '').toUpperCase();
  if (cache === 'STALE' || cache === 'UPDATING') throw new Error(`siren.pp.ua: stale proxy copy (${cache})`);
  return fromSiren(await r.json());
}

async function loadPrimary(token: string | undefined): Promise<ActiveList> {
  if (token) {
    try {
      return fromAlertsInUa(await getJson('https://api.alerts.in.ua/v1/alerts/active.json', { Authorization: `Bearer ${token}` }, TIMEOUT_MS));
    } catch {
      // fall through to the no-key source
    }
  }
  return loadSiren();
}

export async function loadAlerts(db: D1Database, token: string | undefined, ttlMs: number) {
  const [primary, cross] = await Promise.all([
    feed(db, 'alerts:active', ttlMs, () => loadPrimary(token)),
    feed(db, 'alerts:cross', ttlMs, () => getJson(KLYMENKO_URL, {}, TIMEOUT_MS).then(fromKlymenko)).catch(() => null),
  ]);
  // a stale cross row still counts while it is newer than the primary's, and keeps its own time; setting cross last also drops one embedded in a 0.5.0 row
  const usable = cross && (!cross.stale || cross.fetchedAt > primary.fetchedAt) ? cross : null;
  const list: ActiveList = { ...primary.value, cross: usable?.value };
  return { list, fetchedAt: primary.fetchedAt, crossAt: usable?.fetchedAt, stale: primary.stale };
}

/** When the displayed state was last confirmed by a source that can see its scope. */
export function confirmedAt(s: AlertStatus, r: { fetchedAt: number; crossAt?: number }): number {
  return s.crossConfirmed && r.crossAt !== undefined ? Math.max(r.fetchedAt, r.crossAt) : r.fetchedAt;
}
