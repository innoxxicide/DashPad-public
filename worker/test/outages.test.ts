import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dtekFixture from './fixtures/dtek-krem-homenum.json';
import svitloFixture from './fixtures/svitlo.json';
import { dtekGroups, housesFrom, normalizeDtek, normalizeSvitlo, pickAnchor, svitloRegion, withToday, type DtekSnapshot } from '../src/adapters/outages';
import app from '../src/index';
import { kyivLocalToMs, parseDtekStamp } from '../src/lib/time';
import { testEnv, useTimingSafeEqualShim, type Row, type TestEnv } from './harness';

const snap: DtekSnapshot = { fact: dtekFixture.fact as DtekSnapshot['fact'], showTableFact: true };
const range = (slots: string[], state: string) =>
  slots.flatMap((s, i) => (s === state ? [i] : [])).map((i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

describe('DTEK normalizer', () => {
  it('lists the 12 Kyiv-oblast groups', () => {
    expect(dtekGroups(snap)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']);
  });

  it('maps hour values to half-hour slots (group 2.2: off 10:30–14:30)', () => {
    const [day] = normalizeDtek(snap, '2.2');
    expect(day.date).toBe('2026-11-19');
    expect(day.slots).toHaveLength(48);
    expect(day.status).toBe('schedule');
    // hour 11 = "second" → 10:30 off; 12–14 = "no"; 15 = "first" → 14:00 off, 14:30 on
    expect(range(day.slots, 'off')).toEqual(['10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00']);
    expect(day.slots.filter((s) => s === 'unknown')).toHaveLength(0);
  });

  it('marks a missing group as unknown, never as "on"', () => {
    const [day] = normalizeDtek(snap, '9.9');
    expect(day.status).toBe('unknown');
    expect(new Set(day.slots)).toEqual(new Set(['unknown']));
  });

  it('marks a hidden schedule', () => {
    const [day] = normalizeDtek({ ...snap, showTableFact: false }, '2.2');
    expect(day.status).toBe('hidden');
  });

  it('handles an empty fact (DTEK sends [] when nothing is published)', () => {
    expect(normalizeDtek({ fact: { data: [] }, showTableFact: true }, '2.2')).toEqual([]);
  });

  it('extracts houses with their groups', () => {
    const houses = housesFrom(dtekFixture as never);
    expect(houses.length).toBeGreaterThan(0);
    expect(houses[0].groups).toEqual(['5.1']);
  });

  it('picks a city street as the anchor address', () => {
    expect(pickAnchor({ 'с. Х': ['Без вулиці'], 'м. Яготин': ['Без вулиці', 'вул. Карпенка-Карого'] })).toEqual({ city: 'м. Яготин', street: 'вул. Карпенка-Карого' });
  });
});

describe('svitlo.live normalizer', () => {
  const region = svitloRegion(svitloFixture, 'kiivska-oblast');

  it('reads the region and the emergency flag', () => {
    expect(region.dateToday).toBe('2026-11-19');
    expect(region.emergency).toBe(false);
  });

  it('agrees with DTEK for group 2.2', () => {
    const [sv] = normalizeSvitlo(region, '2.2');
    const [dt] = normalizeDtek(snap, '2.2');
    expect(sv.date).toBe(dt.date);
    expect(sv.slots).toEqual(dt.slots);
  });

  it('throws for an unknown region', () => {
    expect(() => svitloRegion(svitloFixture, 'nowhere')).toThrow(/not found/);
  });
});

describe('withToday', () => {
  it('adds an unknown "today" when the source has no data for it', () => {
    const now = kyivLocalToMs(2026, 11, 20, 10, 0);
    const days = withToday([{ date: '2026-11-19', status: 'schedule', slots: Array(48).fill('on') }], now);
    expect(days.map((d) => [d.date, d.status])).toEqual([['2026-11-20', 'unknown']]);
  });
});

describe('outage routes', () => {
  let rows: Record<string, Row>;
  let env: TestEnv;
  useTimingSafeEqualShim();
  beforeEach(() => {
    rows = { 'feed:dtek-streets:www.dtek-krem.com.ua': { v: JSON.stringify({ at: Date.now(), value: { Тестове: ['вул. Перша'], Пусте: null } }), updated: Date.now() } };
    env = testEnv(rows);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests'); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const get = (path: string) => app.request(path, { headers: { Authorization: 'Bearer r' } }, env);

  it.each(['/api/outages?region=toString', '/api/outages/streets?region=constructor', '/api/outages/houses?region=toString&city=a&street=b'])(
    'inherited region routes: %s → 400',
    async (path) => {
      const r = await get(path);
      expect(r.status, `${path}: an Object.prototype name must be an unknown region, got ${r.status} ${await r.text()}`).toBe(400);
    },
  );

  it.each([
    ['constructor', 404, undefined],
    ['Пусте', 404, undefined],
    ['Тестове', 200, ['вул. Перша']],
  ])('streets rejects inherited or empty city: city=%s → %i', async (city, status, streets) => {
    const r = await get(`/api/outages/streets?region=kyiv-oblast&city=${encodeURIComponent(city)}`);
    const body = (await r.json()) as { streets?: string[] };
    expect(r.status, `city=${city}: got ${r.status} ${JSON.stringify(body)}`).toBe(status);
    expect(body.streets, `city=${city}: streets`).toEqual(streets);
  });
});

describe('Kyiv time', () => {
  it('parses DTEK stamps in winter (EET) and summer (EEST)', () => {
    expect(new Date(parseDtekStamp('19.11.2026 19:32')!).toISOString()).toBe('2026-11-19T17:32:00.000Z');
    expect(new Date(parseDtekStamp('01.07.2026 12:00')!).toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });
});
