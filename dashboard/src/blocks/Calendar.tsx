import { kyiv } from '../time';

const WEEK = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'НД'];
const monthFmt = new Intl.DateTimeFormat('uk-UA', { month: 'long', timeZone: 'UTC' });

/** ISO-8601 week number. */
function isoWeek(y: number, m: number, d: number): number {
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
}

export function Calendar({ now }: { now: number }) {
  const t = kyiv(now);
  const first = new Date(Date.UTC(t.y, t.m - 1, 1));
  const daysInMonth = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first offset
  const prevDays = new Date(Date.UTC(t.y, t.m - 1, 0)).getUTCDate();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;

  const cells = Array.from({ length: total }, (_, i) => {
    const n = i - lead + 1;
    const inMonth = n >= 1 && n <= daysInMonth;
    const day = inMonth ? n : n < 1 ? prevDays + n : n - daysInMonth;
    const cls = ['cal-day', inMonth ? '' : 'cal-out', i % 7 >= 5 ? 'cal-weekend' : '', inMonth && n === t.d ? 'cal-today' : ''].filter(Boolean).join(' ');
    return (
      <div class="cal-cell" key={i}>
        <span class={cls}>{day}</span>
      </div>
    );
  });

  return (
    <section class="calendar rule-b" aria-label="Календар">
      <div class="cal-head">
        <span class="label">{monthFmt.format(first).toLocaleUpperCase('uk')}</span>
        <span class="label ghost">ТИЖДЕНЬ {isoWeek(t.y, t.m, t.d)}</span>
      </div>
      <div class="cal-grid">
        {WEEK.map((w) => (
          <div class="cal-wd" key={w}>
            {w}
          </div>
        ))}
        {cells}
      </div>
    </section>
  );
}
