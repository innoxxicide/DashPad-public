import type { Polled } from '../api';
import { ageText, duration, hhmm, kyiv, pad } from '../time';
import type { OutageDay, Outages, SlotState } from '../types';

const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const slotTime = (i: number) => `${pad(Math.floor(i / 2) % 24)}:${i % 2 ? '30' : '00'}`;
const isOff = (s: SlotState) => s === 'off';

interface NowNext {
  state: SlotState;
  verb: string | null; // "увімкнуть о 16:30" / "вимкнуть о 18:00 завтра"
  inMin: number | null; // minutes until that change
  note: string | null; // extra hint, e.g. possible outage earlier
}

/** Current state and the next change, looking into tomorrow when it is published. */
function nowAndNext(days: OutageDay[], now: number): NowNext | null {
  const t = kyiv(now);
  const today = days.find((d) => d.date === t.date);
  if (!today || today.status === 'unknown' || today.status === 'hidden') return null;
  const tomorrow = days.find((d) => d.date > t.date);
  const slots = [...today.slots, ...(tomorrow && tomorrow.status !== 'unknown' ? tomorrow.slots : [])];
  const i = t.hh * 2 + (t.mm >= 30 ? 1 : 0);
  const state = slots[i];
  const minsNow = t.hh * 60 + t.mm;
  const find = (pred: (s: SlotState) => boolean) => {
    for (let j = i + 1; j < slots.length; j++) if (pred(slots[j])) return j;
    return -1;
  };
  const at = (j: number) => `${slotTime(j)}${j >= 48 ? ' завтра' : ''}`;
  if (isOff(state)) {
    const j = find((s) => !isOff(s));
    return j < 0 ? { state, verb: null, inMin: null, note: 'до кінця відомого графіка' } : { state, verb: `увімкнуть о ${at(j)}`, inMin: j * 30 - minsNow, note: null };
  }
  const j = find(isOff);
  const m = find((s) => s === 'maybe');
  if (j < 0) return { state, verb: null, inMin: null, note: tomorrow ? 'відключень не заплановано сьогодні й завтра' : 'відключень до кінця дня не заплановано' };
  return { state, verb: `вимкнуть о ${at(j)}`, inMin: j * 30 - minsNow, note: m >= 0 && m < j ? `можливо раніше, з ${slotTime(m)}` : null };
}

function Ruler({ day, now, small }: { day: OutageDay; now?: number; small?: boolean }) {
  const t = now ? kyiv(now) : null;
  const pos = t ? ((t.hh * 60 + t.mm) / 1440) * 100 : null;
  return (
    <div class={`ruler${small ? ' ruler-small' : ''}`}>
      <div class="ruler-base" />
      <div class="ruler-cells">
        {day.slots.map((s, i) => (
          <i key={i} class={`r-${s}`} title={`${slotTime(i)}–${slotTime(i + 1)}`} />
        ))}
      </div>
      {pos != null ? <div class="ruler-now" style={{ left: `${pos}%` }} /> : null}
    </div>
  );
}

const WORD: Record<SlotState, string> = { on: 'Є', off: 'Немає', maybe: 'Можливо', unknown: 'Немає даних' };

export function OutageSchedule({ o, now }: { o: Polled<Outages>; now: number }) {
  const d = o.data;
  if (!d) return <section class="outages muted">Графік відключень завантажується…</section>;
  const t = kyiv(now);
  const today = d.days.find((x) => x.date === t.date) ?? { date: t.date, status: 'unknown' as const, slots: Array<SlotState>(48).fill('unknown') };
  const tomorrow = d.days.find((x) => x.date > t.date && x.status !== 'unknown');
  const nn = d.group ? nowAndNext(d.days, now) : null;
  const old = !o.at || now - o.at > 30 * 60_000 || d.stale;
  const src = d.provider === 'dtek' ? 'ДТЕК' : d.provider === 'svitlo.live' ? 'svitlo.live' : 'джерела недоступні';

  let status;
  if (!d.group) status = <span class="faint">оберіть чергу в налаштуваннях</span>;
  else if (nn) {
    status = (
      <span>
        <b class={`st-${nn.state}`}>{WORD[nn.state]}</b>
        {nn.verb ? ` · ${nn.verb}` : nn.note ? ` · ${nn.note}` : ''}
      </span>
    );
  } else status = <span class="faint">{today.status === 'hidden' ? 'ДТЕК зараз не публікує графік' : 'графік на сьогодні ще не опубліковано'}</span>;

  const left = nn?.inMin != null ? (nn.state === 'off' ? `ще ${duration(nn.inMin)}` : `через ${duration(nn.inMin)}`) : '';

  return (
    <section class="outages" aria-label="Графік відключень">
      <div class="row3">
        <span class="label">СВІТЛО</span>
        <div class="ot-status">{status}</div>
        <span class="ot-group">{d.group ? `черга ${d.group}` : ''}</span>
      </div>
      {d.emergency ? <div class="ot-emergency">Діють аварійні відключення — графік може не виконуватись</div> : null}
      <Ruler day={today} now={now} />
      <div class="ticks">
        {TICKS.map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {h}
          </span>
        ))}
      </div>
      {tomorrow ? (
        <div class="ot-tomorrow">
          <span class="label">ЗАВТРА</span>
          <Ruler day={tomorrow} small />
        </div>
      ) : null}
      <div class="ot-foot">
        <span class={old ? 'warn' : ''}>
          {src}
          {d.sourceUpdatedAt ? ` · графік від ${hhmm(d.sourceUpdatedAt)}` : ''}
          {old ? ` · дані ${ageText(o.at, now)}` : ''}
        </span>
        <span>{nn?.note && nn.verb ? nn.note : left}</span>
      </div>
    </section>
  );
}
