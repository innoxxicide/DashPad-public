// Settings page (#settings): opened from the tablet's ⚙ panel or from a phone (/?k=…#settings).
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, refreshAll } from '../api';
import type { Outages, Region, Settings } from '../types';

type Patch = Partial<Pick<Settings, 'weather' | 'alerts' | 'outages' | 'display' | 'progress'>>;

function Section({ title, children, note }: { title: string; children: ComponentChildren; note?: string }) {
  return (
    <section class="st-section">
      <h2>{title}</h2>
      {note ? <p class="st-note">{note}</p> : null}
      {children}
    </section>
  );
}

function useSaver(onSaved: (s: Settings) => void) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (patch: Patch) => {
    setMsg({ ok: true, text: 'Зберігаю…' });
    try {
      const s = await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
      onSaved(s);
      refreshAll();
      setMsg({ ok: true, text: 'Збережено' });
    } catch (e) {
      setMsg({ ok: false, text: `Помилка: ${(e as Error).message}` });
    }
  };
  return { msg, save };
}
const Msg = ({ m }: { m: { ok: boolean; text: string } | null }) => (m ? <span class={`st-msg${m.ok ? '' : ' err'}`}>{m.text}</span> : null);

// ---------- weather ----------
interface Geo { id: number; name: string; latitude: number; longitude: number; admin1?: string; admin2?: string }

function WeatherSection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Geo[]>([]);
  const { msg, save } = useSaver(setS);
  useEffect(() => {
    if (q.trim().length < 3) return setFound([]);
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ name: q.trim(), count: '8', language: 'uk', countryCode: 'UA', format: 'json' });
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${p}`);
        setFound(((await r.json()).results ?? []) as Geo[]);
      } catch {
        setFound([]);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Section title="Погода" note={`Зараз: ${s.weather.name} (${s.weather.lat.toFixed(3)}, ${s.weather.lon.toFixed(3)})`}>
      <input class="st-input" placeholder="Почніть вводити назву населеного пункту…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <ul class="st-list">
        {found.map((g) => (
          <li key={g.id}>
            <button onClick={() => (save({ weather: { name: g.name, lat: g.latitude, lon: g.longitude } }), setQ(''), setFound([]))}>
              <b>{g.name}</b> <span>{[g.admin1, g.admin2].filter(Boolean).join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
      <Msg m={msg} />
    </Section>
  );
}

// ---------- alerts ----------
function AlertsSection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [tree, setTree] = useState<Region[]>([]);
  const [oblast, setOblast] = useState(s.alerts.oblast);
  const [raion, setRaion] = useState(s.alerts.raion ?? '');
  const [hromada, setHromada] = useState(s.alerts.hromada ?? '');
  const { msg, save } = useSaver(setS);
  useEffect(() => {
    api<{ regions: Region[] }>('/api/regions').then((r) => setTree(r.regions)).catch(() => {});
  }, []);
  const ob = tree.find((r) => r.id === oblast);
  const ra = ob?.children?.find((r) => r.id === raion);
  return (
    <Section title="Повітряна тривога" note="Тривогу показуємо, якщо вона оголошена для області, району або громади.">
      <label class="st-field">
        Область
        <select value={oblast} onChange={(e) => (setOblast((e.target as HTMLSelectElement).value), setRaion(''), setHromada(''))}>
          {tree.map((r) => (
            <option value={r.id} key={r.id}>{r.name}</option>
          ))}
        </select>
      </label>
      {ob?.children?.length ? (
        <label class="st-field">
          Район
          <select value={raion} onChange={(e) => (setRaion((e.target as HTMLSelectElement).value), setHromada(''))}>
            <option value="">— вся область —</option>
            {ob.children.map((r) => (
              <option value={r.id} key={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
      ) : null}
      {ra?.children?.length ? (
        <label class="st-field">
          Громада
          <select value={hromada} onChange={(e) => setHromada((e.target as HTMLSelectElement).value)}>
            <option value="">— весь район —</option>
            {ra.children.map((r) => (
              <option value={r.id} key={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
      ) : null}
      <div class="st-actions">
        <button class="st-btn" onClick={() => save({ alerts: { oblast, ...(raion ? { raion } : {}), ...(hromada ? { hromada } : {}) } })}>Зберегти</button>
        <Msg m={msg} />
      </div>
    </Section>
  );
}

// ---------- outages ----------
interface House { house: string; groups: string[]; outage: { reason: string } | null }

function OutagesSection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [regions, setRegions] = useState<{ id: string; name: string }[]>([]);
  const [region, setRegion] = useState(s.outages.region);
  const [groups, setGroups] = useState<string[]>([]);
  const [group, setGroup] = useState(s.outages.group ?? '');
  const [cityQ, setCityQ] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [city, setCity] = useState('');
  const [streets, setStreets] = useState<string[]>([]);
  const [street, setStreet] = useState('');
  const [houses, setHouses] = useState<House[] | null>(null);
  const [lookupErr, setLookupErr] = useState('');
  const { msg, save } = useSaver(setS);

  useEffect(() => {
    api<{ id: string; name: string }[]>('/api/outages/regions').then(setRegions).catch(() => {});
  }, []);
  useEffect(() => {
    api<Outages>(`/api/outages?region=${encodeURIComponent(region)}`).then((o) => setGroups(o.groups)).catch(() => setGroups([]));
  }, [region]);
  useEffect(() => {
    if (cityQ.trim().length < 2) return setCities([]);
    const t = setTimeout(() => {
      api<{ settlements: string[] }>(`/api/outages/streets?region=${encodeURIComponent(region)}&q=${encodeURIComponent(cityQ.trim())}`)
        .then((r) => setCities(r.settlements))
        .catch((e) => setLookupErr((e as Error).message));
    }, 350);
    return () => clearTimeout(t);
  }, [cityQ, region]);
  const pickCity = (c: string) => {
    setCity(c);
    setCities([]);
    setCityQ(c);
    setStreet('');
    setHouses(null);
    api<{ streets: string[] }>(`/api/outages/streets?region=${encodeURIComponent(region)}&city=${encodeURIComponent(c)}`)
      .then((r) => setStreets(r.streets))
      .catch((e) => setLookupErr((e as Error).message));
  };
  const pickStreet = (st: string) => {
    setStreet(st);
    setHouses(null);
    setLookupErr('');
    api<{ houses: House[] }>(`/api/outages/houses?region=${encodeURIComponent(region)}&city=${encodeURIComponent(city)}&street=${encodeURIComponent(st)}`)
      .then((r) => setHouses(r.houses))
      .catch((e) => setLookupErr((e as Error).message));
  };
  const byGroup = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const h of houses ?? []) for (const g of h.groups) m.set(g, [...(m.get(g) ?? []), h.house]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  }, [houses]);

  return (
    <Section title="Графік відключень">
      <label class="st-field">
        Регіон
        <select value={region} onChange={(e) => (setRegion((e.target as HTMLSelectElement).value), setGroup(''), setCity(''), setStreets([]), setHouses(null))}>
          {regions.map((r) => (
            <option value={r.id} key={r.id}>{r.name}</option>
          ))}
        </select>
      </label>
      <label class="st-field">
        Черга
        <select value={group} onChange={(e) => setGroup((e.target as HTMLSelectElement).value)}>
          <option value="">— оберіть —</option>
          {groups.map((g) => (
            <option value={g} key={g}>{g}</option>
          ))}
        </select>
      </label>
      <div class="st-actions">
        <button class="st-btn" disabled={!group} onClick={() => save({ outages: { region, group } })}>Зберегти</button>
        <Msg m={msg} />
      </div>
      <details class="st-lookup">
        <summary>Не знаєте свою чергу? Знайдіть за адресою (ДТЕК)</summary>
        <input class="st-input" placeholder="Населений пункт, напр. Бровари" value={cityQ} onInput={(e) => setCityQ((e.target as HTMLInputElement).value)} />
        <ul class="st-list">
          {cities.map((c) => (
            <li key={c}><button onClick={() => pickCity(c)}>{c}</button></li>
          ))}
        </ul>
        {streets.length ? (
          <label class="st-field">
            Вулиця
            <select value={street} onChange={(e) => pickStreet((e.target as HTMLSelectElement).value)}>
              <option value="">— оберіть —</option>
              {streets.map((st) => (
                <option value={st} key={st}>{st}</option>
              ))}
            </select>
          </label>
        ) : null}
        {houses ? (
          <div class="st-houses">
            {byGroup.length ? byGroup.map(([g, list]) => (
              <div key={g}>
                <button class="st-btn small" onClick={() => setGroup(g)}>Черга {g}</button> <span>будинки: {list.join(', ')}</span>
              </div>
            )) : <span>ДТЕК не повернув черг для цієї вулиці</span>}
          </div>
        ) : null}
        {lookupErr ? <span class="st-msg err">{lookupErr}</span> : null}
      </details>
    </Section>
  );
}

// ---------- display ----------
function DisplaySection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [d, setD] = useState(s.display);
  const { msg, save } = useSaver(setS);
  const num = (k: keyof Settings['display']) => (e: Event) => setD({ ...d, [k]: Number((e.target as HTMLInputElement).value) });
  const str = (k: keyof Settings['display']) => (e: Event) => setD({ ...d, [k]: (e.target as HTMLInputElement).value });
  return (
    <Section title="Екран" note="Ці параметри застосовує застосунок на планшеті.">
      <label class="st-field">Яскравість удень: {d.dayBrightness}%<input type="range" min="5" max="100" value={d.dayBrightness} onInput={num('dayBrightness')} /></label>
      <label class="st-field">Яскравість уночі: {d.nightBrightness}%<input type="range" min="0" max="100" value={d.nightBrightness} onInput={num('nightBrightness')} /></label>
      <div class="st-row">
        <label class="st-field">Ніч з<input type="time" value={d.nightFrom} onInput={str('nightFrom')} /></label>
        <label class="st-field">до<input type="time" value={d.nightTo} onInput={str('nightTo')} /></label>
      </div>
      <label class="st-field">Без живлення вимикати екран при заряді нижче: {d.batteryScreenOffPct}%<input type="range" min="0" max="80" step="5" value={d.batteryScreenOffPct} onInput={num('batteryScreenOffPct')} /></label>
      <div class="st-actions">
        <button class="st-btn" onClick={() => save({ display: d })}>Зберегти</button>
        <Msg m={msg} />
      </div>
    </Section>
  );
}

// ---------- «Ход работ» ----------
function ProgressSection({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [hours, setHours] = useState(s.progress?.staleHours ?? 72);
  const { msg, save } = useSaver(setS);
  return (
    <Section title="Ход работ" note="Сторінка зводить «Ход работ» усіх акаунтів цього ПК. Відкриті цепочки без оновлень довше за поріг згортаються в один рядок унизу.">
      <label class="st-field">
        Згортати цепочки без оновлень довше ніж, годин
        <input type="number" min="1" max="1440" step="1" value={hours} onInput={(e) => setHours(Number((e.target as HTMLInputElement).value))} />
      </label>
      <div class="st-actions">
        <button class="st-btn" disabled={!(hours >= 1 && hours <= 1440)} onClick={() => save({ progress: { staleHours: hours } })}>Зберегти</button>
        <Msg m={msg} />
      </div>
    </Section>
  );
}

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Settings>('/api/settings').then(setS).catch((e) => setErr((e as Error).message));
  }, []);
  return (
    <div class="settings">
      <header class="st-header">
        <a href="#" class="st-back">← До дашборда</a>
        <h1>Налаштування</h1>
      </header>
      {err ? <p class="st-msg err">{err}</p> : null}
      {s ? (
        <div class="st-grid">
          <WeatherSection s={s} setS={setS} />
          <AlertsSection s={s} setS={setS} />
          <OutagesSection s={s} setS={setS} />
          <DisplaySection s={s} setS={setS} />
          <ProgressSection s={s} setS={setS} />
        </div>
      ) : !err ? <p class="muted">Завантаження…</p> : null}
      <footer class="st-foot">Погода: Open-Meteo.com (CC BY 4.0) · тривоги: alerts.in.ua / siren.pp.ua · графіки: ДТЕК, svitlo.live</footer>
    </div>
  );
}
