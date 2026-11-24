// Open-Meteo forecast → normalized weather. Free, no key, CC BY 4.0 (attribution shown in the dashboard).
import { getJson } from '../lib/feed';

export interface WeatherCurrent {
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
  wind: number; // m/s
  gust: number; // m/s
  windDir: number; // degrees
}
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
  lat: number;
  lon: number;
  current: WeatherCurrent;
  daily: WeatherDay[]; // daily[0] = today, then 7 days ahead
  source: 'open-meteo';
}

// WMO 4677 codes used by Open-Meteo → Ukrainian text + icon id (the dashboard maps ids to SVGs).
export const WMO: Record<number, { text: string; icon: string }> = {
  0: { text: 'Ясно', icon: 'clear' },
  1: { text: 'Переважно ясно', icon: 'mostly-clear' },
  2: { text: 'Мінлива хмарність', icon: 'partly-cloudy' },
  3: { text: 'Хмарно', icon: 'overcast' },
  45: { text: 'Туман', icon: 'fog' },
  48: { text: 'Туман з памороззю', icon: 'fog' },
  51: { text: 'Слабка мряка', icon: 'drizzle' },
  53: { text: 'Мряка', icon: 'drizzle' },
  55: { text: 'Сильна мряка', icon: 'drizzle' },
  56: { text: 'Слабка крижана мряка', icon: 'sleet' },
  57: { text: 'Крижана мряка', icon: 'sleet' },
  61: { text: 'Слабкий дощ', icon: 'rain' },
  63: { text: 'Дощ', icon: 'rain' },
  65: { text: 'Сильний дощ', icon: 'rain-heavy' },
  66: { text: 'Слабкий крижаний дощ', icon: 'sleet' },
  67: { text: 'Крижаний дощ', icon: 'sleet' },
  71: { text: 'Слабкий сніг', icon: 'snow' },
  73: { text: 'Сніг', icon: 'snow' },
  75: { text: 'Сильний сніг', icon: 'snow-heavy' },
  77: { text: 'Снігова крупа', icon: 'snow' },
  80: { text: 'Слабка злива', icon: 'showers' },
  81: { text: 'Злива', icon: 'showers' },
  82: { text: 'Сильна злива', icon: 'rain-heavy' },
  85: { text: 'Слабкий снігопад', icon: 'snow' },
  86: { text: 'Снігопад', icon: 'snow-heavy' },
  95: { text: 'Гроза', icon: 'thunder' },
  96: { text: 'Гроза з градом', icon: 'thunder-hail' },
  99: { text: 'Гроза з сильним градом', icon: 'thunder-hail' },
};
const NIGHT_VARIANT = new Set(['clear', 'mostly-clear', 'partly-cloudy']);

export function wmo(code: number, isDay = true): { text: string; icon: string } {
  const w = WMO[code] ?? { text: '—', icon: 'unknown' };
  return { text: w.text, icon: !isDay && NIGHT_VARIANT.has(w.icon) ? `${w.icon}-night` : w.icon };
}

const CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset';

export function forecastUrl(lat: number, lon: number): string {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current: CURRENT,
    daily: DAILY,
    timezone: 'Europe/Kyiv',
    forecast_days: '8',
    wind_speed_unit: 'ms',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeWeather(j: any, lat: number, lon: number): Weather {
  const c = j.current;
  const isDay = c.is_day === 1;
  const d = j.daily;
  return {
    lat,
    lon,
    current: {
      time: c.time,
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      precip: c.precipitation,
      precipProb: c.precipitation_probability ?? null,
      code: c.weather_code,
      ...wmo(c.weather_code, isDay),
      isDay,
      wind: c.wind_speed_10m,
      gust: c.wind_gusts_10m,
      windDir: c.wind_direction_10m,
    },
    daily: (d.time as string[]).map((date, i) => ({
      date,
      code: d.weather_code[i],
      ...wmo(d.weather_code[i]),
      tmax: d.temperature_2m_max[i],
      tmin: d.temperature_2m_min[i],
      precipProb: d.precipitation_probability_max?.[i] ?? null,
      precipSum: d.precipitation_sum[i],
      windMax: d.wind_speed_10m_max[i],
      sunrise: d.sunrise[i],
      sunset: d.sunset[i],
    })),
    source: 'open-meteo',
  };
}

export async function loadWeather(lat: number, lon: number): Promise<Weather> {
  return normalizeWeather(await getJson(forecastUrl(lat, lon)), lat, lon);
}
