import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeWeather, wmo } from '../src/adapters/weather';
import app from '../src/index';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings';
import { testEnv, useTimingSafeEqualShim, type Row, type TestEnv } from './harness';

const sample = {
  current: {
    time: '2026-11-19T14:15', temperature_2m: 11.5, relative_humidity_2m: 68, apparent_temperature: 8.8, precipitation: 0,
    precipitation_probability: 0, weather_code: 2, wind_speed_10m: 3.18, wind_gusts_10m: 8.9, wind_direction_10m: 257, is_day: 0,
  },
  daily: {
    time: ['2026-11-19', '2026-11-20'], weather_code: [80, 63], temperature_2m_max: [11.6, 8], temperature_2m_min: [6.3, 6.3],
    precipitation_probability_max: [100, 100], precipitation_sum: [2, 15.8], wind_speed_10m_max: [3.76, 5.1],
    sunrise: ['2026-11-19T07:18', '2026-11-20T07:20'], sunset: ['2026-11-19T16:07', '2026-11-20T16:06'],
  },
};

describe('weather', () => {
  it('normalizes Open-Meteo with Ukrainian text and night icons', () => {
    const w = normalizeWeather(sample, 50.45, 30.52);
    expect(w.current.text).toBe('Мінлива хмарність');
    expect(w.current.icon).toBe('partly-cloudy-night');
    expect(w.daily.map((d) => d.text)).toEqual(['Слабка злива', 'Дощ']);
    expect(w.daily[1].tmax).toBe(8);
  });

  it('never fails on an unknown code', () => {
    expect(wmo(123)).toEqual({ text: '—', icon: 'unknown' });
  });
});

describe('settings', () => {
  it('merges a partial patch', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { alerts: { oblast: '14', raion: '73' }, outages: { region: 'kyiv-oblast', group: '2.2' } });
    expect(s.alerts).toEqual({ oblast: '14', raion: '73' });
    expect(s.outages.group).toBe('2.2');
    expect(s.weather).toEqual(DEFAULT_SETTINGS.weather);
  });

  it('keeps the stale-chain threshold and validates it', () => {
    expect(DEFAULT_SETTINGS.progress.staleHours).toBe(72);
    expect(mergeSettings(DEFAULT_SETTINGS, { progress: { staleHours: 48 } }).progress.staleHours).toBe(48);
    expect(() => mergeSettings(DEFAULT_SETTINGS, { progress: { staleHours: 0 } })).toThrow();
  });

  it('rejects bad values', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { outages: { region: 'mars' } })).toThrow();
    expect(() => mergeSettings(DEFAULT_SETTINGS, { display: { nightFrom: '25:00' } })).toThrow();
    expect(() => mergeSettings(DEFAULT_SETTINGS, { alerts: { oblast: 'abc' } })).toThrow();
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])('rejects inherited region names: %s', (region) => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { outages: { region } }), `an Object.prototype name "${region}" must not pass as a region`).toThrow(/outages\.region/);
  });

  it('rejects a non-string region', () => {
    expect(() => mergeSettings(DEFAULT_SETTINGS, { outages: { region: ['kyiv'] } }), 'an array coerces to "kyiv" as a key and must not pass as a region').toThrow(/outages\.region/);
  });

  const short = { city: 'м. Яготин', street: 'вул. Карпенка-Карого', house: '12' };
  const long = { city: 'а'.repeat(5000), street: 'б'.repeat(5000), house: '1'.repeat(5000) };
  it.each([
    ['5000-char strings are cut to 120 chars', long, { city: 'а'.repeat(120), street: 'б'.repeat(120), house: '1'.repeat(120) }],
    ['a short address is stored unchanged', short, short],
  ])('address cap: %s', (name, address, want) => {
    const s = mergeSettings(DEFAULT_SETTINGS, { outages: { region: 'kyiv-oblast', group: '1.1', address } });
    expect(s.outages.address, name).toEqual(want);
  });
});

describe('settings route', () => {
  let rows: Record<string, Row>;
  let env: TestEnv;
  useTimingSafeEqualShim();
  beforeEach(() => {
    rows = {};
    env = testEnv(rows);
  });

  const put = (body: unknown) =>
    app.request('/api/settings', { method: 'PUT', headers: { Authorization: 'Bearer r', 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, env);
  const weatherBodyOf = (length: number) => {
    const [head, tail] = ['{"weather":{"name":"', '","lat":50,"lon":30}}'];
    return head + 'я'.repeat(length - head.length - tail.length) + tail;
  };

  it('settings bad json: a non-JSON PUT → 400 and the stored settings stay', async () => {
    expect((await put({ display: { dayBrightness: 55 } })).status, 'seed PUT accepted').toBe(200);
    const r = await put('{"display":');
    expect(r.status, `non-JSON body: got ${r.status} ${await r.text()}`).toBe(400);
    const g = await app.request('/api/settings', { headers: { Authorization: 'Bearer r' } }, env);
    expect(((await g.json()) as { display: { dayBrightness: number } }).display.dayBrightness, 'GET after the rejected PUT keeps the seeded value').toBe(55);
  });

  it.each([
    [16_000, false],
    [16_001, true],
  ])('settings body cap counts UTF-16 code units: a %i-char Cyrillic body → 413 is %s', async (length, capped) => {
    const body = weatherBodyOf(length);
    expect(body.length, 'the built body has the intended length').toBe(length);
    const r = await put(body);
    expect(r.status, `${length} chars: got ${r.status} ${await r.text()}`).toBe(capped ? 413 : 200);
  });

  it.each([
    ['a 20 000-char weather name → 413, nothing stored', { weather: { name: 'x'.repeat(20000), lat: 50, lon: 30 } }, 413, null],
    ['the APK display patch → 200, stored', { display: { dayBrightness: 55 } }, 200, 55],
  ])('settings body cap: %s', async (name, body, status, stored) => {
    const r = await put(body);
    expect(r.status, `${name}: got ${r.status} ${await r.text()}`).toBe(status);
    const row = rows.settings ? (JSON.parse(rows.settings.v) as { display: { dayBrightness: number } }) : null;
    expect(row?.display.dayBrightness ?? null, `${name}: stored dayBrightness`).toBe(stored);
  });
});
