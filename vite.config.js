import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    // Keep every asset as a file so the strict content security policy applies cleanly.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5273,
    proxy: { '/api': 'http://127.0.0.1:40125' },
  },
});
