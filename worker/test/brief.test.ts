import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import { testEnv, useTimingSafeEqualShim, type Row, type TestEnv } from './harness';

const MAX_BRIEF = 256_000;
const T = 1763891089000;
const HTML_A = '<title>Стендап — понеділок</title><h1>Бриф А</h1><p>Перевірка кирилиці: ґ є і ї</p>';
const HTML_B = '<title>Стендап</title><h1>Бриф Б</h1>';

describe('brief route', () => {
  let rows: Record<string, Row>;
  let env: TestEnv;
  useTimingSafeEqualShim();
  beforeEach(() => {
    rows = {};
    env = testEnv(rows);
  });

  const auth = (key: string | null): Record<string, string> => (key === null ? {} : { Authorization: `Bearer ${key}` });
  const get = (key: string | null = 'r') => app.request('/api/brief', { headers: auth(key) }, env);
  const post = (body: unknown, key: string | null = 'w') =>
    app.request('/api/brief', { method: 'POST', headers: { ...auth(key), 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }, env);
  const read = async () => {
    const r = await get();
    return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
  };

  it('brief route: GET with nothing stored answers 200 {brief:null} with Cache-Control no-store', async () => {
    const r = await get();
    const body = r.status === 200 ? await r.json() : await r.text();
    expect(r.status, `empty storage must answer 200 (the dashboard api() throws on non-2xx); body ${JSON.stringify(body)}`).toBe(200);
    expect(body, 'empty storage shape').toEqual({ brief: null });
    expect(r.headers.get('Cache-Control'), 'GET /api/brief must not be cached').toBe('no-store');
  });

  it.each([
    ['GET without a key', () => get(null)],
    ['GET with a wrong key', () => get('x')],
    ['GET with the write key', () => get('w')],
    ['POST without a key', () => post({ html: HTML_A, generatedAt: T }, null)],
    ['POST with the read key', () => post({ html: HTML_A, generatedAt: T }, 'r')],
  ])('brief route: %s → 403 and nothing stored', async (name, send) => {
    const r = await send();
    expect(r.status, `${name}: expected 403, got ${r.status} ${await r.text()}`).toBe(403);
    expect(Object.keys(rows), `${name}: a refused request must not write a kv row`).toEqual([]);
  });

  it('brief route: POST valid then GET round-trips html and generatedAt unchanged', async () => {
    const p = await post({ html: HTML_A, generatedAt: T });
    expect(p.status, `POST valid: expected 200, got ${p.status}`).toBe(200);
    expect(await p.json(), 'POST valid answer').toEqual({ ok: true });
    const g = await read();
    expect(g, 'GET after one accepted POST').toEqual({ status: 200, body: { brief: { html: HTML_A, generatedAt: T } } });
  });

  it.each([
    ['equal', T],
    ['older', T - 1],
  ])('brief route: an %s generatedAt is ignored with 200 and the stored edition stays', async (name, t2) => {
    expect((await post({ html: HTML_A, generatedAt: T })).status, 'first POST accepted').toBe(200);
    const p = await post({ html: HTML_B, generatedAt: t2 });
    expect(p.status, `${name} generatedAt: the publisher retries any non-200, so it must be 200, got ${p.status}`).toBe(200);
    expect(await p.json(), `${name} generatedAt answer`).toEqual({ ok: true, ignored: true });
    expect(await read(), `${name} generatedAt must not replace the stored edition`).toEqual({ status: 200, body: { brief: { html: HTML_A, generatedAt: T } } });
  });

  it('brief route: a newer generatedAt replaces the stored edition', async () => {
    expect((await post({ html: HTML_A, generatedAt: T })).status, 'first POST accepted').toBe(200);
    const p = await post({ html: HTML_B, generatedAt: T + 1 });
    expect(p.status, `newer POST: expected 200, got ${p.status}`).toBe(200);
    expect(await p.json(), 'newer POST answer').toEqual({ ok: true });
    expect(await read(), 'GET after a newer POST returns the newer edition').toEqual({ status: 200, body: { brief: { html: HTML_B, generatedAt: T + 1 } } });
  });

  it('brief route: a generatedAt over 10 min ahead of the Worker clock is rejected and the stored edition stays', async () => {
    expect((await post({ html: HTML_A, generatedAt: T })).status, 'first POST accepted').toBe(200);
    const p = await post({ html: HTML_B, generatedAt: Date.now() + 11 * 60_000 });
    expect(p.status, `future generatedAt: a stored future stamp would block every later edition, got ${p.status}`).toBe(400);
    expect(await read(), 'a future stamp must not replace the stored edition').toEqual({ status: 200, body: { brief: { html: HTML_A, generatedAt: T } } });
  });

  it('brief route: a generatedAt within the 10 min clock-skew slack is accepted and stored', async () => {
    const t = Date.now() + 9 * 60_000;
    const p = await post({ html: HTML_B, generatedAt: t });
    expect(p.status, `9 min ahead is PC clock skew, must be accepted, got ${p.status}`).toBe(200);
    expect(await read(), 'a stamp within the slack is stored').toEqual({ status: 200, body: { brief: { html: HTML_B, generatedAt: t } } });
  });

  it.each([
    ['bad json', '{"html":', 400],
    ['html missing', { generatedAt: T }, 400],
    ['html empty', { html: '', generatedAt: T }, 400],
    ['html whitespace only', { html: ' \n\t ', generatedAt: T }, 400],
    ['html a number', { html: 42, generatedAt: T }, 400],
    ['generatedAt missing', { html: HTML_A }, 400],
    ['generatedAt a string', { html: HTML_A, generatedAt: String(T) }, 400],
    ['generatedAt null', { html: HTML_A, generatedAt: null }, 400],
    ['generatedAt in seconds', { html: HTML_A, generatedAt: 1763891089 }, 400],
    ['html of MAX_BRIEF + 1 chars', { html: 'x'.repeat(MAX_BRIEF + 1), generatedAt: T }, 413],
  ])('brief route: POST with %s is rejected and GET stays {brief:null}', async (name, body, status) => {
    const p = await post(body);
    expect(p.status, `${name}: expected ${status}, got ${p.status} ${await p.text()}`).toBe(status);
    expect(await read(), `${name}: a rejected POST must leave storage empty`).toEqual({ status: 200, body: { brief: null } });
  });
});
