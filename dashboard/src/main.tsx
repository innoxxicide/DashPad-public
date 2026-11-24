import '@fontsource-variable/inter-tight';
import './styles.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { KEY } from './api';
import { Dashboard, NoKey } from './app';
import { BriefPage } from './brief/BriefPage';
import { SettingsPage } from './settings/SettingsPage';

function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  if (!KEY) return <NoKey />;
  if (hash === '#settings') return <SettingsPage />;
  // The brief covers a still-mounted dashboard: a remount would reload the «Ход работ» frame (a white flash on return).
  return (
    <>
      <Dashboard />
      {hash === '#brief' ? <BriefPage /> : null}
    </>
  );
}

render(<Root />, document.getElementById('app')!);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
