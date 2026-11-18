import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const applicationDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: applicationDirectory,
  // Relative asset URLs, so the build works when served from app://renderer/.
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    emptyOutDir: true,
    outDir: path.join(applicationDirectory, 'dist', 'renderer'),
    sourcemap: true,
  },
});
