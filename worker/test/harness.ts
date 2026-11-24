import { timingSafeEqual } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';

export type Row = { v: string; updated: number };
export type TestEnv = { DB: D1Database; PROGRESS_WRITE_KEY: string; DASHPAD_READ_KEY: string };

function fakeDb(rows: Record<string, Row>): D1Database {
  const stmt = (...a: unknown[]) => ({
    all: async () => ({ results: a.filter((k): k is string => typeof k === 'string' && k in rows).map((k) => ({ k, ...rows[k] })) }),
    run: async () => {
      rows[a[0] as string] = { v: a[1] as string, updated: a[2] as number };
      return {};
    },
  });
  return {
    prepare: () => ({ run: async () => ({}), bind: stmt }),
  } as unknown as D1Database;
}

/** Worker env over `rows`: write key 'w', read key 'r'. */
export const testEnv = (rows: Record<string, Row>): TestEnv => ({ DB: fakeDb(rows), PROGRESS_WRITE_KEY: 'w', DASHPAD_READ_KEY: 'r' });

/** timingSafeEqual is a Workers-only WebCrypto extension; without it every keyed request is a 500 in Node. */
export function useTimingSafeEqualShim(): void {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
  let shimmed = false;
  beforeAll(() => {
    if (subtle.timingSafeEqual) return;
    Object.defineProperty(subtle, 'timingSafeEqual', { configurable: true, value: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(Buffer.from(a), Buffer.from(b)) });
    shimmed = true;
  });
  afterAll(() => {
    if (shimmed) delete subtle.timingSafeEqual;
  });
}
