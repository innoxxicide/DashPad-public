// Everything on screen is shown in Kyiv time, whatever the device time zone is.
import { useEffect, useState } from 'preact/hooks';

export const TZ = 'Europe/Kyiv';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface KyivParts {
  y: number;
  m: number; // 1..12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  wd: number; // 1 = Monday … 7 = Sunday
  date: string; // YYYY-MM-DD
}

export function kyiv(ms = Date.now()): KyivParts {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, hh: Number(p.hour) % 24, mm: Number(p.minute), ss: Number(p.second), wd: WD[p.weekday] ?? 1, date: `${p.year}-${p.month}-${p.day}` };
}

export const pad = (n: number) => String(n).padStart(2, '0');

export function hhmm(ms: number): string {
  const p = kyiv(ms);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

/** "1 год 05 хв", "25 хв". */
export function duration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h} год ${pad(m % 60)} хв` : `${m} хв`;
}

export function capitalize(s: string): string {
  return s ? s[0].toLocaleUpperCase('uk') + s.slice(1) : s;
}

/** Re-render every `stepMs` (aligned to the wall clock). */
export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      t = setTimeout(tick, stepMs - (Date.now() % stepMs) + 5);
    };
    t = setTimeout(tick, stepMs - (Date.now() % stepMs) + 5);
    return () => clearTimeout(t);
  }, [stepMs]);
  return now;
}

/** How old data is, for "оновлено" captions. */
export function ageText(at: number | null, now: number): string {
  if (!at) return 'немає даних';
  const min = (now - at) / 60000;
  if (min < 1.5) return 'щойно';
  if (min < 60) return `${Math.round(min)} хв тому`;
  return `о ${hhmm(at)}`;
}
