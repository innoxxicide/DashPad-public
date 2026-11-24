import { type NativeBattery, useBattery } from '../native';
import { kyiv, pad, TZ } from '../time';

const weekdayFmt = new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, weekday: 'long' });
const dayMonthFmt = new Intl.DateTimeFormat('uk-UA', { timeZone: TZ, day: 'numeric', month: 'long' });

function screenOffText(b: NativeBattery): string | null {
  if (typeof b.offAt !== 'number' || b.level > b.offAt + 10) return null;
  return b.level <= b.offAt ? 'ЕКРАН СКОРО ЗГАСНЕ' : `ЕКРАН ЗГАСНЕ ПРИ ${b.offAt}%`;
}

export function Clock({ now }: { now: number }) {
  const p = kyiv(now);
  const battery = useBattery();
  const onBattery = battery && !battery.charging ? battery : null;
  const offText = onBattery ? screenOffText(onBattery) : null;
  return (
    <header class="clock" aria-label="Годинник">
      <div class="clock-time">
        {pad(p.hh)}
        <span class="clock-colon">:</span>
        {pad(p.mm)}
      </div>
      <div class="clock-date">
        <span class="label">{weekdayFmt.format(now).toLocaleUpperCase('uk')}</span>
        <span class="clock-day">{dayMonthFmt.format(now)}</span>
        {onBattery ? <span class="label warn">НА БАТАРЕЇ · {onBattery.level}%</span> : <span class="label faint">{p.y}</span>}
        {offText ? <span class="label warn">{offText}</span> : null}
      </div>
    </header>
  );
}
