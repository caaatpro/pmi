// Web UI of pmi-server (docs/PMI/WEB_UI.md): React + Mantine, built into
// dist/server/central/ui and served under /ui/ by src/server/central/ui.ts.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: path.resolve(here, '../../../../dist/server/central/ui'),
    emptyOutDir: true,
    sourcemap: false,
    // Everything is a file under /ui/assets; nothing inline (the CSP allows only 'self').
    assetsInlineLimit: 0,
    // One bundle (~170 KB gzipped) for an internal tool; splitting would not pay off.
    chunkSizeWarningLimit: 800,
  },
});
