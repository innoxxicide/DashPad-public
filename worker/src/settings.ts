// Dashboard settings, stored in D1 (kv "settings"). Editable from the tablet's ⚙ panel or /settings.
import { OUTAGE_REGIONS } from './adapters/outages';

export interface Settings {
  weather: { name: string; lat: number; lon: number };
  alerts: { oblast: string; raion?: string; hromada?: string };
  outages: { region: string; group?: string; address?: { city: string; street: string; house: string } };
  display: {
    dayBrightness: number; // 0..100
    nightBrightness: number; // 0..100
    nightFrom: string; // "HH:MM"
    nightTo: string; // "HH:MM"
    batteryScreenOffPct: number; // screen off below this battery level when on battery
  };
  progress: {
    staleHours: number; // open chains idle longer than this fold into one line under «Ход работ»
  };
  updatedAt?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  weather: { name: 'Київ', lat: 50.4501, lon: 30.5234 },
  alerts: { oblast: '14' },
  outages: { region: 'kyiv-oblast' },
  display: { dayBrightness: 70, nightBrightness: 10, nightFrom: '23:00', nightTo: '07:00', batteryScreenOffPct: 30 },
  progress: { staleHours: 72 },
};

const isHHMM = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isId = (s: unknown) => typeof s === 'string' && /^\d{1,6}$/.test(s);
const pct = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 100;

/** Merge a partial patch into the current settings; throws on invalid values. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeSettings(cur: Settings, patch: any): Settings {
  const out: Settings = structuredClone(cur);
  if (patch.weather) {
    const w = patch.weather;
    if (typeof w.name !== 'string' || typeof w.lat !== 'number' || typeof w.lon !== 'number' || Math.abs(w.lat) > 90 || Math.abs(w.lon) > 180) throw new Error('weather: name, lat, lon');
    out.weather = { name: w.name.slice(0, 80), lat: w.lat, lon: w.lon };
  }
  if (patch.alerts) {
    const a = patch.alerts;
    if (!isId(a.oblast) || (a.raion != null && !isId(a.raion)) || (a.hromada != null && !isId(a.hromada))) throw new Error('alerts: numeric ids');
    out.alerts = { oblast: a.oblast, ...(a.raion ? { raion: a.raion } : {}), ...(a.hromada ? { hromada: a.hromada } : {}) };
  }
  if (patch.outages) {
    const o = patch.outages;
    if (typeof o.region !== 'string' || !OUTAGE_REGIONS[o.region]) throw new Error(`outages.region: one of ${Object.keys(OUTAGE_REGIONS).join(', ')}`);
    if (o.group != null && !(typeof o.group === 'string' && /^\d{1,2}\.\d$/.test(o.group))) throw new Error('outages.group like "2.2"');
    out.outages = { region: o.region, ...(o.group ? { group: o.group } : {}) };
    if (o.address && typeof o.address.city === 'string' && typeof o.address.street === 'string' && typeof o.address.house === 'string') {
      out.outages.address = { city: o.address.city.slice(0, 120), street: o.address.street.slice(0, 120), house: o.address.house.slice(0, 120) };
    }
  }
  if (patch.display) {
    const d = { ...out.display, ...patch.display };
    if (!pct(d.dayBrightness) || !pct(d.nightBrightness) || !pct(d.batteryScreenOffPct) || !isHHMM(d.nightFrom) || !isHHMM(d.nightTo)) throw new Error('display: brightness 0..100, times HH:MM');
    out.display = { dayBrightness: d.dayBrightness, nightBrightness: d.nightBrightness, nightFrom: d.nightFrom, nightTo: d.nightTo, batteryScreenOffPct: d.batteryScreenOffPct };
  }
  if (patch.progress) {
    const h = patch.progress.staleHours;
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 1 || h > 24 * 60) throw new Error('progress.staleHours: 1..1440');
    out.progress = { staleHours: Math.round(h) };
  }
  out.updatedAt = Date.now();
  return out;
}
