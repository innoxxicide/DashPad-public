import { useEffect, useRef } from 'preact/hooks';
import { API_BASE, KEY, LAYOUT, refreshAll, usePoll } from './api';
import { AlertStatus } from './blocks/AlertStatus';
import { Calendar } from './blocks/Calendar';
import { Clock } from './blocks/Clock';
import { OutageSchedule } from './blocks/Outages';
import { WeatherNow, WeatherWeek } from './blocks/Weather';
import { kyiv, useNow } from './time';
import type { Alerts, Outages, Settings, Weather } from './types';

const SEC = 1000;
const MIN = 60 * SEC;
declare const __BUILD__: string;

/** Reload when a new build is deployed, and once a night (fresh WebView memory). */
function useSelfRefresh(now: number) {
  const started = useRef(Date.now());
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch('/version.json', { cache: 'no-store' });
        if (r.ok && (await r.json()).build !== __BUILD__) location.reload();
      } catch {
        /* offline */
      }
    };
    const t = setInterval(check, 10 * MIN);
    return () => clearInterval(t);
  }, []);
  const t = kyiv(now);
  if (t.hh === 4 && t.mm === 0 && Date.now() - started.current > 2 * 60 * MIN) location.reload();
}

/** Refetch everything when the settings change (from the ⚙ panel or a phone). */
function useSettingsWatch() {
  const s = usePoll<Settings>('/api/settings', 2 * MIN);
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    const v = s.data?.updatedAt;
    if (seen.current !== undefined && v !== seen.current) refreshAll();
    seen.current = v;
  }, [s.data?.updatedAt]);
}

export function Dashboard() {
  const now = useNow(SEC);
  const weather = usePoll<Weather>('/api/weather', 15 * MIN);
  const alerts = usePoll<Alerts>('/api/alerts', 15 * SEC);
  const outages = usePoll<Outages>('/api/outages', 5 * MIN);
  useSettingsWatch();
  useSelfRefresh(now);

  const left = (
    <main class="left">
      <Clock now={now} />
      <Calendar now={now} />
      <WeatherNow w={weather} now={now} />
      <WeatherWeek w={weather} />
      <AlertStatus a={alerts} now={now} />
      <OutageSchedule o={outages} now={now} />
    </main>
  );
  if (LAYOUT === 'left') return <div class="screen single">{left}</div>;
  return (
    <div class="screen split">
      {left}
      {/* The Android ⚙ panel reloads the right half by the selector `iframe.right`. */}
      <iframe class="right" src={`${API_BASE}/progress?k=${encodeURIComponent(KEY)}`} title="Ход работ" />
    </div>
  );
}

export function NoKey() {
  return (
    <main class="nokey">
      <h1>DashPad</h1>
      <p>Відкрийте сторінку з ключем пристрою: <code>/?k=…</code></p>
    </main>
  );
}
