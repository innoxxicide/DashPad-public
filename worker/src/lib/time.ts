// Europe/Kyiv date helpers (Workers and Node both ship full ICU).
export const TZ = 'Europe/Kyiv';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });

/** 'YYYY-MM-DD' of the given instant in Kyiv. */
export function kyivDate(ms: number): string {
  return dateFmt.format(ms);
}

/** UTC offset of Kyiv at the given instant, in minutes (120 or 180). */
export function kyivOffsetMin(ms: number): number {
  const name = offFmt.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+2';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Kyiv wall-clock time → epoch ms. */
export function kyivLocalToMs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - kyivOffsetMin(guess - 2 * 3600_000) * 60_000;
  const off2 = kyivOffsetMin(ms);
  ms = guess - off2 * 60_000;
  return ms;
}

/** DTEK stamps look like "19.11.2026 19:32" (Kyiv time). */
export function parseDtekStamp(s: string | undefined): number | undefined {
  const m = s?.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
  if (!m) return undefined;
  return kyivLocalToMs(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
}
