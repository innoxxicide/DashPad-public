import type { Polled } from '../api';
import { ageText } from '../time';
import type { Weather } from '../types';
import { WeatherIcon } from './icons';

const WD = ['НД', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
const deg = (n: number) => `${Math.round(n) === 0 ? 0 : Math.round(n)}°`;
const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘']; // where the wind blows to (windDir = where it comes from)
const windArrow = (dir: number) => arrows[Math.round((((dir % 360) + 360) % 360) / 45) % 8];

export function WeatherNow({ w, now }: { w: Polled<Weather>; now: number }) {
  const d = w.data;
  if (!d) return <section class="weather-now muted">Погода завантажується…</section>;
  const c = d.current;
  const today = d.daily[0];
  const old = !w.at || now - w.at > 45 * 60_000 || d.stale;
  return (
    <>
      <section class="weather-now" aria-label="Погода зараз">
        <WeatherIcon id={c.icon} size={58} title={c.text} weight={1.1} />
        <div class="wn-temp">{deg(c.temp)}</div>
        <div class="wn-text">
          <span class="wn-cond">{c.text}</span>
          <span class="wn-place">
            {d.name ?? ''}
            {today ? ` · удень до ${deg(today.tmax)}, уночі ${deg(today.tmin)}` : ''}
          </span>
        </div>
      </section>
      <div class="wn-details">
        <span><i>відчувається</i> {deg(c.feels)}</span>
        <span>
          <i>вітер</i> {Math.round(c.wind)} м/с {windArrow(c.windDir)}
          {c.gust - c.wind >= 4 ? `, пориви ${Math.round(c.gust)}` : ''}
        </span>
        <span><i>вологість</i> {c.humidity}%</span>
        {today?.precipProb != null && today.precipProb >= 20 ? <span><i>опади</i> {today.precipProb}%</span> : null}
        {old ? <span class="warn">дані {ageText(w.at, now)}</span> : null}
      </div>
    </>
  );
}

export function WeatherWeek({ w }: { w: Polled<Weather> }) {
  const days = w.data?.daily.slice(1, 8) ?? [];
  if (!days.length) return null;
  return (
    <section class="weather-week rule-t rule-b" aria-label="Прогноз на тиждень">
      {days.map((d) => {
        const dt = new Date(d.date + 'T12:00:00Z');
        const weekend = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
        return (
          <div class="ww-day" key={d.date}>
            <span class={`label${weekend ? ' ink2' : ''}`}>
              {WD[dt.getUTCDay()]} <span class="ghost">{dt.getUTCDate()}</span>
            </span>
            <WeatherIcon id={d.icon} size={26} title={d.text} weight={1.3} />
            <span class="ww-t">
              <b>{deg(d.tmax)}</b> <span class="faint">{deg(d.tmin)}</span>
            </span>
          </div>
        );
      })}
    </section>
  );
}
