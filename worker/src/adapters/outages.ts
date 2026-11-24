// Scheduled power outages. Primary: DTEK /ua/ajax (same JSON as the official page; Yii2 CSRF flow,
// see docs/research-apis.md §3.2). Fallback: svitlo.live. Normalized to 48 half-hour slots per day.
import { getJson, UA } from '../lib/feed';
import { kyivDate, parseDtekStamp } from '../lib/time';

export type SlotState = 'on' | 'off' | 'maybe' | 'unknown';
export type DayStatus = 'schedule' | 'no_outages' | 'hidden' | 'unknown';
export interface OutageDay {
  date: string; // YYYY-MM-DD, Kyiv
  status: DayStatus;
  slots: SlotState[]; // 48 × 30 min, 00:00 … 23:30
}
export interface OutageFeed {
  provider: 'dtek' | 'svitlo.live' | 'none';
  region: string;
  regionName: string;
  group: string | null;
  days: OutageDay[]; // today first, tomorrow when published
  emergency: boolean | null; // "аварійні відключення, графік не діє" (from svitlo.live)
  sourceUpdatedAt: number | null;
  fetchedAt: number | null;
  stale: boolean;
  errors: string[];
}

export interface RegionConfig {
  name: string;
  dtekHost: string;
  svitloCpu: string;
}
// Null prototype: a region id from a request ("toString", "__proto__") must not resolve to an inherited member.
export const OUTAGE_REGIONS: Record<string, RegionConfig> = Object.assign(Object.create(null), {
  'kyiv-oblast': { name: 'Київська область (ДТЕК КРЕМ)', dtekHost: 'www.dtek-krem.com.ua', svitloCpu: 'kiivska-oblast' },
  kyiv: { name: 'Київ (ДТЕК КЕМ)', dtekHost: 'www.dtek-kem.com.ua', svitloCpu: 'kyiv' },
  'dnipro-oblast': { name: 'Дніпропетровська область (ДТЕК ДнЕМ)', dtekHost: 'www.dtek-dnem.com.ua', svitloCpu: 'dnipropetrovska-oblast' },
  'odesa-oblast': { name: 'Одеська область (ДТЕК ОЕМ)', dtekHost: 'www.dtek-oem.com.ua', svitloCpu: 'odeska-oblast' },
});

const unknownDay = (date: string): OutageDay => ({ date, status: 'unknown', slots: Array<SlotState>(48).fill('unknown') });

function dayStatus(slots: SlotState[]): DayStatus {
  if (slots.every((s) => s === 'unknown')) return 'unknown';
  return slots.every((s) => s === 'on') ? 'no_outages' : 'schedule';
}

// ---------------- DTEK ----------------
const HOUR: Record<string, [SlotState, SlotState]> = {
  yes: ['on', 'on'],
  no: ['off', 'off'],
  first: ['off', 'on'],
  second: ['on', 'off'],
  maybe: ['maybe', 'maybe'],
  mfirst: ['maybe', 'on'],
  msecond: ['on', 'maybe'],
};

export interface DtekFact {
  data: Record<string, Record<string, Record<string, string>>> | []; // dayUnix → "GPV2.2" → hour "1".."24" → value
  update?: string;
  today?: number;
}
export interface DtekSnapshot {
  fact: DtekFact;
  showTableFact: boolean;
}

export function normalizeDtek(snap: DtekSnapshot, group: string): OutageDay[] {
  const data = Array.isArray(snap.fact.data) ? {} : snap.fact.data;
  return Object.keys(data)
    .sort()
    .map((dayUnix) => {
      const date = kyivDate(Number(dayUnix) * 1000);
      const hours = data[dayUnix][`GPV${group}`];
      if (!snap.showTableFact) return { ...unknownDay(date), status: 'hidden' as const };
      if (!hours) return unknownDay(date);
      const slots: SlotState[] = [];
      for (let h = 1; h <= 24; h++) slots.push(...(HOUR[hours[String(h)]] ?? (['unknown', 'unknown'] as [SlotState, SlotState])));
      return { date, status: dayStatus(slots), slots };
    });
}

export function dtekGroups(snap: DtekSnapshot): string[] {
  const data = Array.isArray(snap.fact.data) ? {} : snap.fact.data;
  const first = Object.values(data)[0] ?? {};
  return Object.keys(first).map((g) => g.replace(/^GPV/, '')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

class DtekChallenge extends Error {}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}
function maskToken(token: string): string {
  const raw = new TextEncoder().encode(token);
  const m = crypto.getRandomValues(new Uint8Array(raw.length));
  const out = new Uint8Array(raw.length * 2);
  out.set(m, 0);
  for (let i = 0; i < raw.length; i++) out[raw.length + i] = raw[i] ^ m[i];
  return b64url(out);
}

async function dtekSession(host: string) {
  const base = `https://${host}`;
  const jar = new Map<string, string>();
  async function post(form: Record<string, string>, token?: string) {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: base,
      Referer: `${base}/ua/shutdowns`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (token) headers['X-CSRF-Token'] = token;
    const res = await fetch(`${base}/ua/ajax`, { method: 'POST', headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, text, challenge: text.includes('_Incapsula_Resource') };
  }
  const r0 = await post({ method: 'getHomeNum' });
  if (r0.challenge) throw new DtekChallenge('challenge on bootstrap');
  const name = [...jar.keys()].find((k) => k.startsWith('_csrf'));
  const m = name ? decodeURIComponent(jar.get(name)!).match(/i:1;s:\d+:"([^"]+)"/) : null;
  if (!m) throw new Error(`${host}: no CSRF cookie (HTTP ${r0.status})`);
  const token = m[1];
  return async (form: Record<string, string>) => {
    const r = await post(form, maskToken(token));
    if (r.challenge) throw new DtekChallenge(`challenge on ${form.method}`);
    if (r.status !== 200) throw new Error(`${host} ${form.method}: HTTP ${r.status}`);
    return JSON.parse(r.text);
  };
}

/** One DTEK call with a fresh session; one retry if Imperva answers with a challenge page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dtekCall(host: string, form: Record<string, string>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const call = await dtekSession(host);
      return await call(form);
    } catch (e) {
      if (attempt >= 1 || !(e instanceof DtekChallenge)) throw new Error(`${host}: ${(e as Error).message}`);
    }
  }
}

export async function dtekStreets(host: string): Promise<Record<string, string[]>> {
  const j = await dtekCall(host, { method: 'getStreets' });
  if (!j.result || !j.streets) throw new Error(`${host}: getStreets returned no streets`);
  return j.streets;
}

export function pickAnchor(streets: Record<string, string[]>): { city: string; street: string } {
  for (const [city, list] of Object.entries(streets)) {
    const street = list.find((s) => s !== 'Без вулиці');
    if (city.startsWith('м. ') && street) return { city, street };
  }
  const [city, list] = Object.entries(streets)[0];
  return { city, street: list[0] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dtekHomeNum(host: string, city: string, street: string): Promise<any> {
  const j = await dtekCall(host, {
    method: 'getHomeNum',
    'data[0][name]': 'city',
    'data[0][value]': city,
    'data[1][name]': 'street',
    'data[1][value]': street,
    'data[2][name]': 'updateFact',
    'data[2][value]': '01.01.2000 00:00', // an old version forces the full fact/preset payload
  });
  if (!j.result) throw new Error(`${host}: getHomeNum result=false`);
  return j;
}

export async function loadDtekSnapshot(host: string, anchor: { city: string; street: string }): Promise<DtekSnapshot> {
  const j = await dtekHomeNum(host, anchor.city, anchor.street);
  if (!j.fact) throw new Error(`${host}: no fact in getHomeNum`);
  return { fact: { data: j.fact.data, update: j.fact.update, today: j.fact.today }, showTableFact: j.showTableFact !== false };
}

export function housesFrom(j: { data?: Record<string, { sub_type_reason?: string[]; sub_type?: string; start_date?: string; end_date?: string }> }) {
  return Object.entries(j.data ?? {})
    .map(([house, h]) => ({
      house,
      groups: (h.sub_type_reason ?? []).map((g) => g.replace(/^GPV/, '')),
      outage: h.sub_type ? { reason: h.sub_type, start: h.start_date || null, end: h.end_date || null } : null,
    }))
    .sort((a, b) => a.house.localeCompare(b.house, 'uk', { numeric: true }));
}

// ---------------- svitlo.live ----------------
export interface SvitloRegion {
  dateToday: string;
  dateTomorrow: string;
  emergency: boolean;
  schedule: Record<string, Record<string, Record<string, number>>>; // group → date → "HH:MM" → 1 on / 2 off
  snapshotAt: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function svitloRegion(raw: any, cpu: string): SvitloRegion {
  const body = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (body.regions as any[]).find((x) => x.cpu === cpu);
  if (!r) throw new Error(`svitlo.live: region ${cpu} not found`);
  return { dateToday: body.date_today, dateTomorrow: body.date_tomorrow, emergency: !!r.emergency, schedule: r.schedule ?? {}, snapshotAt: Number(raw.timestamp) || 0 };
}

export function normalizeSvitlo(r: SvitloRegion, group: string): OutageDay[] {
  const byDate = r.schedule[group] ?? {};
  return [r.dateToday, r.dateTomorrow]
    .filter((d) => byDate[d])
    .map((date) => {
      const slots: SlotState[] = [];
      for (let i = 0; i < 48; i++) {
        const key = `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
        const v = byDate[date][key];
        slots.push(v === 1 ? 'on' : v === 2 ? 'off' : 'unknown');
      }
      return { date, status: dayStatus(slots), slots };
    });
}

export async function loadSvitlo(cpu: string): Promise<SvitloRegion> {
  return svitloRegion(await getJson('https://dtek-api.svitlo-proxy.workers.dev/', {}, 20_000), cpu);
}

/** Make sure "today" is the first day; anything older is dropped. Missing data stays "unknown", never "on". */
export function withToday(days: OutageDay[], now = Date.now()): OutageDay[] {
  const today = kyivDate(now);
  const kept = days.filter((d) => d.date >= today);
  if (!kept.some((d) => d.date === today)) kept.unshift(unknownDay(today));
  return kept.sort((a, b) => a.date.localeCompare(b.date));
}

export { parseDtekStamp };
