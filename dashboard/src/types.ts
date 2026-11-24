// Shapes returned by the Worker (see worker/src/adapters/*).
export interface WeatherDay {
  date: string;
  code: number;
  text: string;
  icon: string;
  tmax: number;
  tmin: number;
  precipProb: number | null;
  precipSum: number;
  windMax: number;
  sunrise: string;
  sunset: string;
}
export interface Weather {
  name: string | null;
  current: {
    time: string;
    temp: number;
    feels: number;
    humidity: number;
    precip: number;
    precipProb: number | null;
    code: number;
    text: string;
    icon: string;
    isDay: boolean;
    wind: number;
    gust: number;
    windDir: number;
  };
  daily: WeatherDay[];
  fetchedAt: number;
  stale: boolean;
}

export type AlertLevel = 'red' | 'yellow' | null;
export interface Alerts {
  active: boolean;
  level: AlertLevel;
  scope: 'oblast' | 'raion' | 'hromada' | null;
  since: string | null;
  types: string[];
  threats: string[];
  matches: { regionId: string; name: string; type: string; level: AlertLevel; since: string | null }[];
  watched: { regionId: string; name: string; scope: 'oblast' | 'raion' | 'hromada' }[];
  source: string;
  crossChecked?: boolean;
  corrected?: boolean;
  primaryStale?: boolean;
  ageMs?: number; // Worker-side age of the data at response time
  fetchedAt: number;
  stale: boolean;
}

export type SlotState = 'on' | 'off' | 'maybe' | 'unknown';
export interface OutageDay {
  date: string;
  status: 'schedule' | 'no_outages' | 'hidden' | 'unknown';
  slots: SlotState[];
}
export interface Outages {
  provider: 'dtek' | 'svitlo.live' | 'none';
  region: string;
  regionName: string;
  group: string | null;
  groups: string[];
  days: OutageDay[];
  emergency: boolean | null;
  sourceUpdatedAt: number | null;
  fetchedAt: number | null;
  stale: boolean;
  errors: string[];
}

export interface Region {
  id: string;
  name: string;
  type: 'oblast' | 'raion' | 'hromada';
  children?: Region[];
}

export interface Settings {
  weather: { name: string; lat: number; lon: number };
  alerts: { oblast: string; raion?: string; hromada?: string };
  outages: { region: string; group?: string; address?: { city: string; street: string; house: string } };
  display: { dayBrightness: number; nightBrightness: number; nightFrom: string; nightTo: string; batteryScreenOffPct: number };
  progress: { staleHours: number };
  updatedAt?: number;
}
