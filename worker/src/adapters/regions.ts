// Region tree oblast → raion → hromada (siren.pp.ua, same ids as alerts.in.ua). Used by the settings picker
// and to name the regions in the alert status.
import { getJson } from '../lib/feed';

export type RegionType = 'oblast' | 'raion' | 'hromada';
export interface Region {
  id: string;
  name: string;
  type: RegionType;
  children?: Region[];
}

const TYPE: Record<string, RegionType> = { State: 'oblast', District: 'raion', Community: 'hromada' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function simplify(n: any): Region {
  const r: Region = { id: String(n.regionId), name: n.regionName, type: TYPE[n.regionType] ?? 'hromada' };
  if (Array.isArray(n.regionChildIds) && n.regionChildIds.length) {
    r.children = n.regionChildIds.map(simplify).sort((a: Region, b: Region) => a.name.localeCompare(b.name, 'uk'));
  }
  return r;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeRegions(j: any): Region[] {
  return (j.states as unknown[]).map(simplify).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

export function regionNames(tree: Region[]): Map<string, Region> {
  const out = new Map<string, Region>();
  const walk = (list: Region[]) => list.forEach((r) => (out.set(r.id, r), r.children && walk(r.children)));
  walk(tree);
  return out;
}

export async function loadRegions(): Promise<Region[]> {
  return normalizeRegions(await getJson('https://siren.pp.ua/api/v3/regions', {}, 5_000));
}
