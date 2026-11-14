import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const ROOT = import.meta.dirname;

/** The package a bundled file comes from ("react", "@codemirror/view"...), or null for CityHQ's own code. */
export function packageOf(id) {
  const clean = String(id).replace(/^\0/, '').split('?')[0].replaceAll('\\', '/');
  if (/^vite\/(modulepreload-polyfill|preload-helper)/.test(clean)) return 'vite';
  const at = clean.lastIndexOf('/node_modules/');
  if (at === -1) return null;
  const parts = clean.slice(at + '/node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

const NOTICES_HEADER = [
  'CityHQ\'s screens include the software below, each with its licence.',
  '',
  'Electron and Chromium\'s own notices are in LICENSE and LICENSES.chromium.html, next to CityHQ.exe.',
  'The libraries CityHQ\'s own server part uses are in resources\\app\\node_modules, each with its licence file.',
  '',
].join('\n');

/**
 * THIRD-PARTY-NOTICES.txt beside the screens: every package whose code or fonts are built into them,
 * with its licence text, as those licences ask (MIT and ISC for the code, the OFL for the fonts).
 */
function thirdPartyNotices() {
  return {
    name: 'cityhq-third-party-notices',
    apply: 'build',
    generateBundle() {
      const names = new Set();
      for (const id of this.getModuleIds()) {
        const name = packageOf(id);
        if (name) names.add(name);
      }
      const sections = [...names].sort().map((name) => {
        const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const file = existsSync(dir) ? readdirSync(dir).find((n) => /^(licen[cs]e|copying)/i.test(n)) : null;
        const text = file ? readFileSync(path.join(dir, file), 'utf8').trim() : `Licensed under ${pkg.license || 'its own terms'}: https://www.npmjs.com/package/${name}`;
        return ['='.repeat(78), `${name} ${pkg.version} (${pkg.license || 'see below'})`, '-'.repeat(78), text, ''].join('\n');
      });
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: [NOTICES_HEADER, ...sections].join('\n') });
    },
  };
}

export default defineConfig({
  root: path.resolve(ROOT, 'web'),
  plugins: [react(), thirdPartyNotices()],
  build: {
    outDir: path.resolve(ROOT, 'dist'),
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
