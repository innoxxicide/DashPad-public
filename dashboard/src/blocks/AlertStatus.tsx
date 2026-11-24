import type { Polled } from '../api';
import { ageText, duration, hhmm } from '../time';
import type { Alerts } from '../types';

const THREATS: Record<string, string> = {
  ballistic_missiles: 'балістика',
  cruise_missiles: 'крилаті ракети',
  unspecified_missiles: 'ракети',
  drones: 'дрони',
  guided_aerial_bombs: 'КАБи',
  tactic_aircraft_activity: 'тактична авіація',
  strategic_aircraft_activity: 'стратегічна авіація',
  mig31k_departure: 'зліт МіГ-31К',
  air_defense: 'робота ППО',
};
const TYPES: Record<string, string> = {
  air: 'Повітряна',
  artillery: 'Артобстріл',
  urban_fights: 'Вуличні бої',
  chemical: 'Хімічна загроза',
  nuclear: 'Радіаційна загроза',
};

// ageMs is on the Worker clock and a.at on ours, so clock skew cannot make old data look new.
function dataAt(a: Polled<Alerts>): number | null {
  const d = a.data;
  if (!a.at || !d) return a.at;
  const age = d.ageMs ?? NaN;
  if (Number.isFinite(age)) return a.at - Math.max(0, age);
  return Number.isFinite(d.fetchedAt) ? Math.min(d.fetchedAt, a.at) : a.at;
}

// Polled every 15 s: no confirmation of the shown state for 90 s means old. A confirmation >5 s
// ahead of our clock (offline start after a drain) is old too and shows its time, never «щойно».
function oldLabel(at: number | null, now: number): string | null {
  if (at && at - now > 5_000) return `дані о ${hhmm(at)}`;
  return !at || now - at > 90_000 ? `дані ${ageText(at, now)}` : null;
}

export function AlertStatus({ a, now }: { a: Polled<Alerts>; now: number }) {
  const d = a.data;
  const stale = oldLabel(dataAt(a), now);
  const old = stale !== null;
  const place = d?.watched.find((w) => w.scope === 'raion')?.name ?? d?.watched[0]?.name ?? '';

  let cls = 'alert-unknown';
  let main = <span>Невідомо</span>;
  let side: string | null = a.error ? "немає зв'язку" : null;
  let sub: string | null = null;

  if (d && !d.active) {
    cls = 'alert-clear';
    main = (
      <span>
        Немає <span class="faint">· {place}</span>
      </span>
    );
    side = stale;
  } else if (d) {
    const level = d.level ?? 'red';
    cls = `alert-${level}`;
    const kind = d.types.includes('air') || !d.types.length ? TYPES.air : TYPES[d.types[0]] ?? 'Тривога';
    const where = d.matches.map((m) => m.name).filter((v, i, arr) => arr.indexOf(v) === i);
    main = (
      <span>
        {kind}
        {level === 'yellow' ? ' (жовта)' : ''} · {where.join(', ') || place}
      </span>
    );
    const since = d.since ? Date.parse(d.since) : null;
    side = stale ?? (since ? `з ${hhmm(since)} · ${duration((now - since) / 60000)}` : null);
    const threats = d.threats.map((t) => THREATS[t]).filter(Boolean);
    sub = threats.length ? threats.join(', ') : null;
  }

  return (
    <section class={`alert rule-b ${cls}${old ? ' is-old' : ''}`} aria-live={d?.active ? 'assertive' : 'polite'} aria-label="Повітряна тривога">
      <span class="label">ТРИВОГА</span>
      <div class="alert-main">
        <span class="alert-mark" />
        {main}
      </div>
      <span class="alert-side">{side}</span>
      {sub ? <span class="alert-sub">{sub}</span> : null}
    </section>
  );
}
