// Full-screen standup brief (#brief): the newest edition from /api/brief in a scripts-free frame, with its age and a kept zoom.
import { useMemo, useState } from 'preact/hooks';
import { usePoll } from '../api';
import { hhmm, kyiv, pad, useNow } from '../time';

interface Brief {
  html: string;
  generatedAt: number;
}
interface BriefResponse {
  brief: Brief | null;
}

function isBriefResponse(x: unknown): x is BriefResponse {
  if (typeof x !== 'object' || x === null || !('brief' in x)) return false;
  const b = x.brief;
  if (b === null) return true;
  if (typeof b !== 'object') return false;
  const { html, generatedAt } = b as Record<string, unknown>;
  return typeof html === 'string' && html.length > 0 && typeof generatedAt === 'number' && Number.isFinite(generatedAt);
}

const ZOOMS = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const ZOOM_DEFAULT = 1.5;
const ZOOM_KEY = 'dashpad.briefZoom';

function readZoom(): number {
  try {
    const z = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(z) ? z : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT;
  }
}

function writeZoom(z: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(z));
  } catch {
    /* storage blocked: the zoom is not kept */
  }
}

// The wrapper must stay first: a CSP meta applies only to the elements after it.
const WRAP =
  `<!doctype html><html data-theme="dark"><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
  `<style>html{background:#111214;color-scheme:dark}*{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}` +
  `a,area{pointer-events:none!important}.copy,iframe,frame,object,embed{display:none!important}</style>`;

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];

function ageLine(generatedAt: number, now: number): { text: string; old: boolean } {
  const t = Math.min(generatedAt, now);
  const day = kyiv(t);
  const today = kyiv(now);
  if (day.date === today.date) return { text: `Бриф зібрано сьогодні о ${hhmm(t)}`, old: false };
  // The calendar day before, not now − 24 h: on the two DST days that lands on the wrong date.
  const yesterday = new Date(Date.UTC(today.y, today.m - 1, today.d - 1)).toISOString().slice(0, 10);
  const when = day.date === yesterday ? 'вчора' : `${WEEKDAYS[day.wd - 1]}, ${pad(day.d)}.${pad(day.m)}`;
  return { text: `Бриф зібрано ${when} о ${hhmm(t)} · не сьогоднішній`, old: true };
}

function ZoomGroup({ z, setZ }: { z: number; setZ: (z: number) => void }) {
  const i = ZOOMS.indexOf(z);
  const go = (d: number) => {
    const next = ZOOMS[i + d];
    if (next === undefined) return;
    setZ(next);
    writeZoom(next);
  };
  return (
    <div class="brief-zoom">
      <button type="button" aria-label="Зменшити масштаб" disabled={i <= 0} onClick={() => go(-1)}>−</button>
      <span>{Math.round(z * 100)}%</span>
      <button type="button" aria-label="Збільшити масштаб" disabled={i >= ZOOMS.length - 1} onClick={() => go(1)}>+</button>
    </div>
  );
}

function BriefState({ empty, loading }: { empty: boolean; loading: boolean }) {
  if (empty) {
    return (
      <div class="brief-empty">
        <p>Брифу ще немає.</p>
        <p>Він з'явиться тут, щойно ПК його надішле.</p>
      </div>
    );
  }
  return <div class="brief-empty">{loading ? <p>Завантаження…</p> : <p class="warn">Не вдалося завантажити бриф.</p>}</div>;
}

export function BriefPage() {
  const poll = usePoll<unknown>('/api/brief', 60_000);
  const now = useNow(60_000);
  const [z, setZ] = useState(readZoom);
  const res = isBriefResponse(poll.data) ? poll.data : null;
  const brief = res?.brief ?? null;
  const html = brief?.html ?? '';
  const doc = useMemo(() => (html ? WRAP + html : ''), [html]);
  const age = brief ? ageLine(brief.generatedAt, now) : null;
  return (
    <div class="brief">
      <header class="brief-bar">
        <a href="#" class="st-back">← До дашборда</a>
        <span class={age?.old ? 'brief-age warn' : 'brief-age'}>{age?.text ?? ''}</span>
        {brief ? <ZoomGroup z={z} setZ={setZ} /> : null}
      </header>
      <div class="brief-view">
        {brief ? (
          // never add allow-scripts: with allow-same-origin the brief could read dashpad.key
          <iframe sandbox="" srcdoc={doc} title="Бриф" style={{ '--z': String(z) }} />
        ) : (
          <BriefState empty={res !== null && poll.error === null} loading={poll.data === null && poll.error === null} />
        )}
      </div>
    </div>
  );
}
