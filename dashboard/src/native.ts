// Bridge to the DashPad Android app (window.DashPadNative, absent in a normal browser).
import { useEffect, useState } from 'preact/hooks';

export interface NativeBattery {
  level: number; // 0..100
  charging: boolean;
  offAt?: number; // screen-off threshold, %; absent from an older APK
}

declare global {
  interface Window {
    DashPadNative?: { battery(): string; version(): string };
  }
}

function read(): NativeBattery | null {
  try {
    const raw = window.DashPadNative?.battery();
    return raw ? (JSON.parse(raw) as NativeBattery) : null;
  } catch {
    return null;
  }
}

/** Tablet battery, updated on power changes ('dashpad:battery' from the app) and every 30 s. */
export function useBattery(): NativeBattery | null {
  const [b, setB] = useState<NativeBattery | null>(read);
  useEffect(() => {
    const update = () => setB(read());
    const t = setInterval(update, 30_000);
    window.addEventListener('dashpad:battery', update);
    return () => {
      clearInterval(t);
      window.removeEventListener('dashpad:battery', update);
    };
  }, []);
  return b;
}
