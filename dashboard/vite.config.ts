import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// Build id: embedded in the bundle and written to /version.json. The running page polls version.json
// and reloads itself when a new build is deployed.
const BUILD = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

function versionFile(): Plugin {
  return {
    name: 'dashpad-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) });
    },
  };
}

// In dev, set VITE_API to the deployed Worker URL (CORS is open on /api/*).
export default defineConfig({
  plugins: [preact(), versionFile()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
