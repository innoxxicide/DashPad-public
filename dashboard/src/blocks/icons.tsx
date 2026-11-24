// Thin line weather icons (24×24 grid, stroke = currentColor), Swiss style. Ids come from the Worker
// (worker/src/adapters/weather.ts); night variants end with "-night".
import type { JSX } from 'preact';

const CLOUD = 'M7 15h10a4 4 0 0 0 .4-7.98A6 6 0 0 0 5.9 6.3 4.4 4.4 0 0 0 7 15z';
const CLOUD_SMALL = 'M9 17h8.5a3.5 3.5 0 0 0 .35-6.98A5 5 0 0 0 8.2 9.6 3.7 3.7 0 0 0 9 17z';
const MOON = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z';
const SMALL_MOON = 'M13 9.6A4.6 4.6 0 0 1 7.4 4a4.6 4.6 0 1 0 5.6 5.6z';

const Sun = ({ cx = 12, cy = 12, r = 4, ray = 3 }: { cx?: number; cy?: number; r?: number; ray?: number }) => (
  <g>
    <circle cx={cx} cy={cy} r={r} />
    {Array.from({ length: 8 }, (_, i) => {
      const a = (i * Math.PI) / 4;
      const r1 = r + 2.2, r2 = r + 2.2 + ray;
      return <line key={i} x1={cx + Math.cos(a) * r1} y1={cy + Math.sin(a) * r1} x2={cx + Math.cos(a) * r2} y2={cy + Math.sin(a) * r2} />;
    })}
  </g>
);
const Drops = ({ n, long = 3 }: { n: number; long?: number }) => {
  const xs = n === 4 ? [7, 10.5, 14, 17.5] : [8.5, 12.5, 16.5];
  return <path d={xs.map((x) => `M${x} 17.5l-1 ${long}`).join('')} />;
};
const Dots = ({ xs, ys }: { xs: number[]; ys: number[] }) => (
  <path d={xs.map((x, i) => `M${x} ${ys[i % ys.length]}h.01`).join('')} stroke-width="2.4" />
);
const Bolt = () => <path d="M12.5 15l-2 3.5h3l-2 3.5" />;

const ICONS: Record<string, () => JSX.Element> = {
  clear: () => <Sun />,
  'clear-night': () => <path d={MOON} />,
  'mostly-clear': () => (
    <>
      <Sun cx={10} cy={10} r={3.6} ray={2.4} />
      <path d={CLOUD_SMALL} transform="translate(3 3.5) scale(.8)" />
    </>
  ),
  'mostly-clear-night': () => (
    <>
      <path d={SMALL_MOON} transform="translate(1 1) scale(1.25)" />
      <path d={CLOUD_SMALL} transform="translate(3 3.5) scale(.8)" />
    </>
  ),
  'partly-cloudy': () => (
    <>
      <Sun cx={8} cy={8} r={3} ray={2} />
      <path d={CLOUD_SMALL} />
    </>
  ),
  'partly-cloudy-night': () => (
    <>
      <path d={SMALL_MOON} />
      <path d={CLOUD_SMALL} />
    </>
  ),
  overcast: () => (
    <>
      <path d={CLOUD} transform="translate(0 2)" />
      <path d="M8.5 6.2A5 5 0 0 1 17.6 5" />
    </>
  ),
  fog: () => (
    <>
      <path d={CLOUD} transform="translate(0 -1)" />
      <path d="M5 18h14M7 21h10" />
    </>
  ),
  drizzle: () => (
    <>
      <path d={CLOUD} />
      <Dots xs={[8.5, 12.5, 16.5]} ys={[19, 20.5]} />
    </>
  ),
  rain: () => (
    <>
      <path d={CLOUD} />
      <Drops n={3} />
    </>
  ),
  'rain-heavy': () => (
    <>
      <path d={CLOUD} />
      <Drops n={4} long={4} />
    </>
  ),
  showers: () => (
    <>
      <Sun cx={7} cy={7} r={2.6} ray={1.6} />
      <path d={CLOUD_SMALL} transform="translate(-1 -2)" />
      <path d="M10 17.5l-1 3M14 17.5l-1 3" />
    </>
  ),
  sleet: () => (
    <>
      <path d={CLOUD} />
      <path d="M9 17.5l-1 3M15 17.5l-1 3" />
      <Dots xs={[12]} ys={[20]} />
    </>
  ),
  snow: () => (
    <>
      <path d={CLOUD} />
      <Dots xs={[8.5, 12.5, 16.5]} ys={[19, 21]} />
    </>
  ),
  'snow-heavy': () => (
    <>
      <path d={CLOUD} />
      <Dots xs={[7, 10, 13, 16, 19]} ys={[18.5, 21]} />
    </>
  ),
  thunder: () => (
    <>
      <path d={CLOUD} />
      <Bolt />
    </>
  ),
  'thunder-hail': () => (
    <>
      <path d={CLOUD} />
      <Bolt />
      <Dots xs={[7.5, 17]} ys={[20]} />
    </>
  ),
  unknown: () => <path d={CLOUD} stroke-dasharray="2 2" />,
};

export function WeatherIcon({ id, size = 48, title, weight = 1.2 }: { id: string; size?: number; title?: string; weight?: number }) {
  const draw = ICONS[id] ?? ICONS.unknown;
  return (
    <svg
      class="wicon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width={weight}
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label={title ?? id}
    >
      {draw()}
    </svg>
  );
}
