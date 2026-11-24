import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import klymenko from './fixtures/klymenko-kyiv.json';
import sirenAlerts from './fixtures/siren-alerts.json';
import sirenRegions from './fixtures/siren-regions-kyiv.json';
import { alertStatus, fromAlertsInUa, fromKlymenko, fromSiren, type ActiveAlert, type ActiveList, type WatchIds } from '../src/adapters/alerts';
import { normalizeRegions, regionNames } from '../src/adapters/regions';

const tree = normalizeRegions(sirenRegions);
const names = regionNames(tree);
const ids = { oblast: '14', raion: '79', hromada: '684' }; // Kyiv oblast, Brovary raion, Brovary hromada
const RAION = 'Броварський район'; // the watched raion's key in the Klymenko feed
const sirenBody = (since: string, regionIds = [ids.raion, ids.hromada]) =>
  regionIds.map((id) => ({ regionId: id, activeAlerts: [{ regionId: id, type: 'AIR', activeAlertLevels: [{ alertLevel: 'Yellow', createdAt: since }] }] }));
const siren = (since: string, regionIds?: string[]) => fromSiren(sirenBody(since, regionIds));
const alert = (type: string, since: string, regionId = ids.raion): ActiveAlert => ({ regionId, type, level: 'yellow', since, threats: [] });
const noHromada: WatchIds = { oblast: '14', raion: ids.raion };
// the captured siren body has one alert in the watched raion; without it the body has none in 14/79/684
const sirenNoWatched = sirenAlerts.filter((r) => r.regionId !== ids.raion);
const FRESH = Date.now(); // primaryAt for pure tests: siren confirmed just now

describe('regions', () => {
  it('builds oblast → raion → hromada', () => {
    const kyivObl = tree.find((r) => r.id === '14')!;
    expect(kyivObl.type).toBe('oblast');
    expect(kyivObl.children).toHaveLength(7);
    expect(names.get('711')?.type).toBe('hromada');
  });
});

describe('siren source', () => {
  const list = fromSiren(sirenAlerts);

  it('normalizes types and levels', () => {
    expect(list.source).toBe('siren');
    expect(new Set(list.alerts.map((a) => a.type))).toEqual(new Set(['air', 'artillery', 'urban_fights']));
    expect(list.alerts.every((a) => a.level === 'red' || a.level === 'yellow')).toBe(true);
  });

  it('finds a raion-level alert while the oblast record is clear (Vyshhorod raion 74)', () => {
    const s = alertStatus(list, { oblast: '14', raion: '74' }, names, FRESH);
    expect(s.active).toBe(true);
    expect(s.scope).toBe('raion');
    expect(s.matches.map((m) => m.regionId)).toEqual(['74']);
    expect(s.watched.map((w) => w.name)).toEqual(['Київська область', 'Вишгородський район']);
  });

  it('is clear for a raion without alerts (Bila Tserkva raion 73)', () => {
    const s = alertStatus(list, { oblast: '14', raion: '73', hromada: '711' }, names, FRESH);
    expect(s.active).toBe(false);
    expect(s.level).toBeNull();
    expect(s.scope).toBeNull();
  });
});

describe('alerts.in.ua source', () => {
  const sample = {
    alerts: [
      { location_uid: '14', location_type: 'oblast', alert_type: 'air_raid', alert_level: 'red', started_at: '2026-11-19T20:01:00.000Z', finished_at: null, threats: [{ threat_type: 'ballistic_missiles' }] },
      { location_uid: '79', location_type: 'raion', alert_type: 'air_raid', alert_level: 'yellow', started_at: '2026-11-19T19:00:00.000Z', finished_at: null, threats: [{ threat_type: 'drones' }] },
      { location_uid: '73', location_type: 'raion', alert_type: 'air_raid', alert_level: 'yellow', started_at: '2026-11-19T18:00:00.000Z', finished_at: '2026-11-19T18:30:00.000Z', threats: [] },
    ],
  };
  const list = fromAlertsInUa(sample);

  it('drops finished alerts', () => {
    expect(list.alerts.map((a) => a.regionId)).toEqual(['14', '79']);
  });

  it('takes the highest level and the broadest scope', () => {
    const s = alertStatus(list, noHromada, names, FRESH);
    expect(s.level).toBe('red');
    expect(s.scope).toBe('oblast');
    expect(s.since).toBe('2026-11-19T19:00:00.000Z');
    expect(s.threats.sort()).toEqual(['ballistic_missiles', 'drones']);
  });
});

describe('cross-check with vadimklimenko.com', () => {
  const crossRaion = (enabled: boolean, at: string | null) => ({
    'київська область': { active: false, level: null, changedAt: null },
    'броварський район': { active: enabled, level: enabled ? ('yellow' as const) : null, changedAt: at },
  });

  it('parses the real feed: states and districts by name', () => {
    const x = fromKlymenko(klymenko);
    expect(x['київська область']).toBeDefined();
    expect(x['броварський район']).toEqual({ active: true, level: 'yellow', changedAt: '2026-11-21T01:48:09.031Z' });
  });

  it('drops a stale primary alert that ended later (21 Nov: 04:53 alert, all-clear 06:45)', () => {
    const list: ActiveList = { ...siren('2026-11-21T02:53:14.10Z'), cross: crossRaion(false, '2026-11-21T04:45:51.000Z') };
    const s = alertStatus(list, ids, names, FRESH);
    expect(s.active).toBe(false);
    expect(s.corrected).toBe(true);
  });

  it('keeps a new primary alert that started after the last all-clear', () => {
    const list: ActiveList = { ...siren('2026-11-21T05:11:26.290694Z'), cross: crossRaion(false, '2026-11-21T04:45:51.000Z') };
    const s = alertStatus(list, ids, names, FRESH);
    expect(s.active).toBe(true);
    expect(s.level).toBe('yellow');
    expect(s.corrected).toBe(false);
  });

  it('shows an alert the primary missed', () => {
    const list: ActiveList = { ...fromSiren([]), cross: crossRaion(true, '2026-11-21T05:11:26.290Z') };
    const s = alertStatus(list, ids, names, FRESH);
    expect(s.active).toBe(true);
    expect(s.scope).toBe('raion');
    expect(s.since).toBe('2026-11-21T05:11:26.290Z');
    expect(s.corrected).toBe(true);
  });

  it('keeps a hromada-only alert that started after the raion all-clear', () => {
    const list: ActiveList = { ...siren('2026-11-21T05:30:00Z', [ids.hromada]), cross: crossRaion(false, '2026-11-21T04:45:51.000Z') };
    const s = alertStatus(list, ids, names, FRESH);
    expect(s.active).toBe(true);
    expect(s.scope).toBe('hromada');
  });

  it('when the cross-check has no time for an all-clear, trusts the alert', () => {
    const list: ActiveList = { ...siren('2026-11-21T02:53:14Z'), cross: crossRaion(false, null) };
    expect(alertStatus(list, ids, names, FRESH).active).toBe(true);
  });

  it.each<[string, ActiveAlert[], { active: boolean; types: string[]; corrected: boolean }]>([
    ['T12 A an all-clear ends the older air alert, not an older artillery alert', [alert('air', '2026-11-21T02:53:14Z'), alert('artillery', '2026-11-21T02:00:00Z')], { active: true, types: ['artillery'], corrected: true }],
    ['T12 B an all-clear ends no air alert that started after it', [alert('artillery', '2026-11-21T02:00:00Z'), alert('air', '2026-11-21T05:30:00Z')], { active: true, types: ['air', 'artillery'], corrected: false }],
  ])('%s', (name, alerts, want) => {
    const s = alertStatus({ source: 'siren', alerts, cross: crossRaion(false, '2026-11-21T04:45:51.000Z') }, ids, names, FRESH);
    expect({ active: s.active, types: [...s.types].sort(), corrected: s.corrected }, name).toEqual(want);
  });

  it.each<[string, string, { since: string; corrected: boolean; crossConfirmed?: boolean }]>([
    ['C12 healthy siren: an older Klymenko start does not replace the stored alert', '2026-11-21T05:30:00Z', { since: '2026-11-21T03:50:00Z', corrected: false, crossConfirmed: true }],
    ['C12 inside the 10 s lag: a Klymenko start newer than the stored one replaces it', '2026-11-21T05:11:31.290Z', { since: '2026-11-21T05:11:26.290Z', corrected: true }],
    ['C12 past the 10 s lag: the stored alert stays', '2026-11-21T05:11:41.290Z', { since: '2026-11-21T03:50:00Z', corrected: false }],
  ])('%s', (name, primaryAt, want) => {
    const s = alertStatus({ ...siren('2026-11-21T03:50:00Z', [ids.raion]), cross: crossRaion(true, '2026-11-21T05:11:26.290Z') }, noHromada, names, Date.parse(primaryAt));
    expect({ since: s.since, corrected: s.corrected, crossConfirmed: s.crossConfirmed }, name).toMatchObject(want);
  });

  it('C12 (a) only a non-air alert stored: Klymenko adds its air alert, the artillery one stays and is not its', () => {
    const s = alertStatus({ source: 'siren', alerts: [alert('artillery', '2026-11-21T02:00:00Z')], cross: crossRaion(true, '2026-11-21T05:11:26.290Z') }, noHromada, names, FRESH);
    expect({ types: [...s.types].sort(), corrected: s.corrected, crossConfirmed: s.crossConfirmed }).toEqual({ types: ['air', 'artillery'], corrected: true, crossConfirmed: false });
  });

  it('works without the cross-check (feed down)', () => {
    const s = alertStatus(siren('2026-11-21T02:53:14Z'), ids, names, FRESH);
    expect(s.active).toBe(true);
    expect(s.crossChecked).toBe(false);
  });
});

describe('loadAlerts: each source cached on its own', () => {
  type Loaded = { list: ActiveList; fetchedAt: number; crossAt?: number; stale: boolean };
  const TTL = 10_000; // TTL.alerts in index.ts
  type Reply = () => Response;
  const down = (status: number): Reply => () => new Response('', { status });
  const json = (body: unknown, headers: Record<string, string> = {}): Reply => () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  // the 21 Nov all-clear in the watched raion (06:45 Kyiv), after the 04:53 Kyiv alert start
  type KlymenkoEntry = { enabled: boolean; type: string; enabled_at: string | null; disabled_at: string | null; alert_level: string | null };
  type KlymenkoState = KlymenkoEntry & { districts: Partial<Record<string, KlymenkoEntry>> };
  const klymenkoEdited = (edit: (kyivOblast: KlymenkoState) => void) => {
    const j = structuredClone(klymenko) as unknown as { states: Record<string, KlymenkoState> };
    edit(j.states['Київська область']);
    return j;
  };
  const klymenkoClear = (edit?: (kyivOblast: KlymenkoState) => void) =>
    klymenkoEdited((k) => {
      k.districts[RAION] = { enabled: false, type: 'district', enabled_at: null, disabled_at: '2026-11-21T04:45:51.000Z', alert_level: null };
      edit?.(k);
    });
  // the captured raion alert starts at 01:48, before the stored siren start; C12 needs a Klymenko start after it
  const klymenkoRedRaion = () => klymenkoEdited((k) => Object.assign(k.districts[RAION]!, { alert_level: 'red', enabled_at: '2026-11-21T05:11:26.290Z' }));

  function fakeDb(rows: Record<string, string>): D1Database {
    return {
      prepare: () => ({
        run: async () => ({}),
        bind: (...a: unknown[]) => ({
          all: async () => ({ results: a.filter((k): k is string => typeof k === 'string' && k in rows).map((k) => ({ k, v: rows[k], updated: 0 })) }),
          run: async () => {
            rows[a[0] as string] = a[1] as string;
            return {};
          },
        }),
      }),
    } as unknown as D1Database;
  }

  function stubFetch(sirenReply: Reply, klymenkoReply: Reply) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        const host = new URL(u).host;
        if (host === 'siren.pp.ua') return sirenReply();
        if (host === 'vadimklimenko.com') return klymenkoReply();
        throw new Error(`unexpected upstream call: ${u}`);
      }),
    );
  }

  const seed = (at: number, value: ActiveList) => ({ 'feed:alerts:active': JSON.stringify({ at, value }) });

  async function load(rows: Record<string, string>, watch: WatchIds = ids) {
    const m = await import('../src/adapters/alerts');
    const r: Loaded = await m.loadAlerts(fakeDb(rows), undefined, TTL);
    const s = alertStatus(r.list, watch, names, r.fetchedAt);
    return { r, s, c: m.confirmedAt(s, r) };
  }

  const view = ({ r, s, c }: Awaited<ReturnType<typeof load>>, T0: number) => {
    const age = (t: number) => (t === T0 ? 'stored' : t > T0 ? 'new' : `other ${t}`);
    return { active: s.active, scope: s.scope, since: s.since, level: s.level, types: s.types, corrected: s.corrected, crossChecked: s.crossChecked, stale: r.stale, fetchedAt: age(r.fetchedAt), confirmed: age(c) };
  };

  beforeEach(() => vi.resetModules()); // feed.ts mem/failUntil and kv.ts schemaReady are module state
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const olderAndNewerAir = (): ActiveList => ({ source: 'siren', alerts: [alert('air', '2026-11-21T02:53:14.10Z'), alert('air', '2026-11-21T05:30:00Z')] });
  const oblastActive = (k: KlymenkoState) => Object.assign(k, { enabled: true, enabled_at: '2026-11-21T05:40:00.000Z', alert_level: 'yellow' });

  it.each<[string, () => ActiveList, Reply, Partial<ReturnType<typeof view>>, WatchIds?]>([
    ['T1 siren down, Klymenko all-clear newer than the alert → all-clear, primary-aged (a watched hromada is out of its sight)', () => siren('2026-11-21T02:53:14.10Z'), json(klymenkoClear()), { active: false, corrected: true, stale: true, fetchedAt: 'stored', confirmed: 'stored' }],
    ['T11 siren down, no hromada watched, Klymenko clear on oblast and raion → the all-clear counts as confirmed', () => siren('2026-11-21T02:53:14.10Z'), json(klymenkoClear()), { active: false, corrected: true, stale: true, fetchedAt: 'stored', confirmed: 'new' }, noHromada],
    ['T10 siren down, Klymenko sees the raion alert → the alert counts as confirmed', () => fromSiren([]), json(klymenko), { active: true, corrected: true, stale: true, fetchedAt: 'stored', confirmed: 'new' }],
    ['T2/T13 siren down keeps a hromada-only alert the cross-check cannot see, primary-aged', () => siren('2026-11-21T05:30:00Z', [ids.hromada]), json(klymenkoClear()), { active: true, scope: 'hromada', stale: true, fetchedAt: 'stored', confirmed: 'stored' }],
    ['T3 siren down, Klymenko answers with no entries → stored alert kept', () => siren('2026-11-21T02:53:14.10Z'), json({ version: 10, states: {} }), { active: true, stale: true, fetchedAt: 'stored', confirmed: 'stored' }],
    ['T4 both down → stored alert served stale with its stored time', () => siren('2026-11-21T02:53:14.10Z'), down(500), { active: true, crossChecked: false, stale: true, fetchedAt: 'stored', confirmed: 'stored' }],
    ["T7 both down, a 0.5.0 row's embedded cross-check is not reused", () => ({ ...fromSiren([]), cross: fromKlymenko(klymenko) }), down(500), { active: false, crossChecked: false, stale: true, fetchedAt: 'stored', confirmed: 'stored' }],
    ['T14 an alert that started after the raion all-clear stays, primary-aged', () => siren('2026-11-21T05:30:00Z'), json(klymenkoClear()), { active: true, corrected: false, confirmed: 'stored' }],
    ['T15 no hromada watched, raion entry missing → the all-clear stays primary-aged', () => fromSiren([]), json(klymenkoClear((k) => delete k.districts[RAION])), { active: false, confirmed: 'stored' }, noHromada],
    ['T16 the raion all-clear ends only the older air alert; the newer one stays, primary-aged', olderAndNewerAir, json(klymenkoClear()), { active: true, types: ['air'], corrected: true, confirmed: 'stored' }, noHromada],
    ['T16 same, Klymenko also sees the oblast alert, but the kept raion alert is not its → primary-aged', olderAndNewerAir, json(klymenkoClear(oblastActive)), { active: true, scope: 'oblast', types: ['air'], corrected: true, confirmed: 'stored' }, noHromada],
  ])('%s', async (name, stored, klymenkoReply, want, watch) => {
    const T0 = Date.now() - 60_000;
    stubFetch(down(522), klymenkoReply);
    expect(view(await load(seed(T0, stored()), watch), T0), name).toMatchObject(want);
  });

  it('T5 both down and nothing stored → rejects (the route answers 500, the block shows «Невідомо»)', async () => {
    stubFetch(down(522), down(500));
    await expect(load({}), 'no stored row must not invent a state').rejects.toThrow(/siren\.pp\.ua: HTTP 522/);
  });

  it.each<[string, Record<string, string>, Partial<ReturnType<typeof view>>]>([
    ['STALE is a siren failure, not a confirmation', { 'x-cache-status': 'STALE' }, { active: true, stale: true, fetchedAt: 'stored' }],
    ['lowercase stale is a siren failure too', { 'x-cache-status': 'stale' }, { active: true, stale: true, fetchedAt: 'stored' }],
    ['HIT is a confirmation', { 'x-cache-status': 'HIT' }, { active: false, stale: false, fetchedAt: 'new' }],
    ['no cache header is a confirmation', {}, { active: false, stale: false, fetchedAt: 'new' }],
    ['UPDATING is a siren failure too (a stale copy served during an update)', { 'x-cache-status': 'UPDATING' }, { active: true, stale: true, fetchedAt: 'stored' }],
  ])('T6 siren proxy copy, Klymenko down: %s', async (name, headers, want) => {
    const T0 = Date.now() - 60_000;
    stubFetch(json(sirenNoWatched, headers), down(500));
    expect(view(await load(seed(T0, siren('2026-11-21T02:53:14.10Z'))), T0), name).toMatchObject(want);
  });

  it('T9 siren fresh, Klymenko down: a stored cross-check past its TTL adds no alert', async () => {
    const T0 = Date.now() - 60_000;
    stubFetch(json(sirenNoWatched, { 'x-cache-status': 'HIT' }), down(500));
    const got = await load({ 'feed:alerts:cross': JSON.stringify({ at: T0, value: fromKlymenko(klymenko) }) });
    expect(view(got, T0), 'the stored cross-check shows the watched raion under alert').toMatchObject({ active: false, crossChecked: false, stale: false });
  });

  it('C11 both down: a stored cross row newer than the primary still counts, at its own time', async () => {
    const T0 = Date.now() - 60_000;
    const Tc = Date.now() - 15_000;
    stubFetch(down(522), down(429));
    const got = await load({ ...seed(T0, fromSiren([])), 'feed:alerts:cross': JSON.stringify({ at: Tc, value: fromKlymenko(klymenko) }) });
    expect(view(got, T0), 'Klymenko saw the watched raion under alert 15 s ago').toMatchObject({ active: true, crossChecked: true, stale: true, fetchedAt: 'stored' });
    expect(got.c, 'confirmed at the cross row time').toBe(Tc);
  });

  it.each<[string, () => ActiveList, Partial<ReturnType<typeof view>>]>([
    ['C12 siren down: Klymenko started a new alert after siren last confirmed → its start and level', () => siren('2026-11-21T03:50:00Z', [ids.raion]), { active: true, since: '2026-11-21T05:11:26.290Z', level: 'red', corrected: true, confirmed: 'new' }],
    ['C12 siren down, hromada watched: the shown start rests on the stored hromada hit → primary-aged', () => siren('2026-11-21T03:50:00Z'), { active: true, since: '2026-11-21T03:50:00Z', confirmed: 'stored' }],
  ])('%s', async (name, stored, want) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T05:12:30Z'));
    const T0 = Date.parse('2026-11-21T05:00:00Z');
    stubFetch(down(522), json(klymenkoRedRaion()));
    expect(view(await load(seed(T0, stored())), T0), name).toMatchObject(want);
  });

  it('T8 a healthy load writes rollback-safe rows: alerts stays an array, the cross-check has its own row', async () => {
    stubFetch(json(sirenBody('2026-11-21T02:53:14.10Z')), json(klymenkoClear()));
    const rows: Record<string, string> = {};
    const { r, s } = await load(rows);
    expect({ active: s.active, corrected: s.corrected, stale: r.stale }, 'healthy siren + Klymenko all-clear').toEqual({ active: false, corrected: true, stale: false });
    const primary = JSON.parse(rows['feed:alerts:active'] ?? 'null');
    expect(Array.isArray(primary?.value?.alerts), 'a 0.5.0 Worker after rollback calls value.alerts.filter').toBe(true);
    expect(rows['feed:alerts:cross'], `D1 keys written: ${Object.keys(rows).join(', ')}`).toBeDefined();
  });
});
