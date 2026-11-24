// Talking to the DashPad Worker: device key, polling with a localStorage copy for offline starts.
import { useEffect, useRef, useState } from 'preact/hooks';

const KEY_STORAGE = 'dashpad.key';
const params = new URLSearchParams(location.search);

/** API origin: same origin in production; VITE_API in `npm run dev`. */
export const API_BASE = (import.meta.env.VITE_API as string | undefined) ?? '';

function readKey(): string {
  const fromUrl = params.get('k');
  try {
    if (fromUrl) localStorage.setItem(KEY_STORAGE, fromUrl);
    return fromUrl ?? localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return fromUrl ?? '';
  }
}
export const KEY = readKey();
export const LAYOUT = params.get('layout') === 'left' ? 'left' : 'split';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(API_BASE + path, {
    ...init,
    cache: 'no-store',
    // a request that hangs must not freeze the block: usePoll skips new polls while one is in flight
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${KEY}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      msg = JSON.parse(text).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as T;
}

/** Ask every poller to refetch now (after settings change, network back, …). */
export function refreshAll(): void {
  window.dispatchEvent(new Event('dashpad:refresh'));
}

export interface Polled<T> {
  data: T | null;
  at: number | null; // when `data` was received (ms)
  error: string | null; // last error, cleared on success
}

function cacheGet<T>(path: string): { at: number; data: T } | null {
  try {
    const s = localStorage.getItem('dashpad.cache:' + path);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function cachePut(path: string, data: unknown): void {
  try {
    localStorage.setItem('dashpad.cache:' + path, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full or blocked: fine */
  }
}

/** Fetch `path` now and every `intervalMs`; start from the cached copy so the screen is never empty. */
export function usePoll<T>(path: string, intervalMs: number): Polled<T> {
  const [state, setState] = useState<Polled<T>>(() => {
    const c = cacheGet<T>(path);
    return { data: c?.data ?? null, at: c?.at ?? null, error: null };
  });
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const data = await api<T>(path);
        if (!alive) return;
        cachePut(path, data);
        setState({ data, at: Date.now(), error: null });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: (e as Error).message }));
      } finally {
        busy.current = false;
      }
    };
    load();
    const t = setInterval(load, intervalMs);
    window.addEventListener('dashpad:refresh', load);
    window.addEventListener('online', load);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('dashpad:refresh', load);
      window.removeEventListener('online', load);
    };
  }, [path, intervalMs]);

  return state;
}
