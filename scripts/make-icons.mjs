// Draws the CityHQ logo (the HQ seal in front of a city skyline) and writes every icon size.
// Run with Electron, which renders the drawing exactly as a browser would:
//   npm run icons
// Small sizes leave the city out, because at 16 or 24 pixels it only blurs the seal.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, '..', 'build');
const PUBLIC = path.join(here, '..', 'web', 'public');

export const COLORS = { tile: '#17121f', mark: '#8066A8', city: '#3f3356' };
const STROKE = 3.8;
const BUILDINGS = [[7, 36, 6], [13.5, 26, 6], [20, 31, 5], [25.5, 19, 6], [32, 24, 5], [37.5, 16, 6], [44, 27, 5.5], [50, 33, 7]];
// The ring and its swoosh tail are one line: it comes round the bottom and sweeps out to the right.
const Q = 'M34.95 46.74A17 17 0 0 0 29.05 13.26A17 17 0 0 0 34.95 46.74Q42 45.4 49.5 43.2';

function letterH(color, grow = 0) {
  const bar = (x, y, w, h) => `<rect x="${x - grow}" y="${y - grow}" width="${w + 2 * grow}" height="${h + 2 * grow}" rx="${1.8 + grow}" fill="${color}"/>`;
  return bar(25.6, 23, 3.6, 14) + bar(34.8, 23, 3.6, 14) + bar(25.6, 28.2, 12.8, 3.6);
}

/** The logo as SVG. `city: false` gives the plain seal used at small sizes. */
export function logoSvg({ city = true } = {}) {
  const { tile, mark } = COLORS;
  const stroke = city ? STROKE : 4.4;
  const buildings = city
    ? BUILDINGS.map(([x, top, w]) => `<rect x="${x}" y="${top}" width="${w}" height="${48 - top}" rx="0.8" fill="${COLORS.city}"/>`).join('')
    : '';
  // A thin gap in the tile colour keeps the seal crisp where it crosses the buildings.
  const gaps = city
    ? `<path d="${Q}" fill="none" stroke="${tile}" stroke-width="${stroke + 3.2}" stroke-linecap="round" stroke-linejoin="round"/>${letterH(tile, 1.3)}`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`
    + `<rect width="64" height="64" rx="14" fill="${tile}"/>${buildings}${gaps}`
    + `<path d="${Q}" fill="none" stroke="${mark}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
    + `${letterH(mark)}`
    + `<rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.3" fill="none" stroke="${mark}" stroke-opacity="${city ? 0.45 : 0.6}" stroke-width="1.5"/>`
    + '</svg>';
}

/** Renders each [svg, size] to PNG bytes in a hidden browser window. */
async function renderAll(jobs) {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const results = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (const [svg, size] of ${JSON.stringify(jobs)}) {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      canvas.getContext('2d').drawImage(img, 0, 0, size, size);
      out.push(canvas.toDataURL('image/png').split(',')[1]);
    }
    return out;
  })()`);
  win.destroy();
  return results.map((b64) => Buffer.from(b64, 'base64'));
}

/** An .ico holding PNG images, which Windows reads from Vista onwards. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(([size, data]) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(([, d]) => d)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const full = logoSvg({ city: true });
    const small = logoSvg({ city: false });
    const pick = (size) => (size <= 24 ? small : full);
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const files = [
      ['build/icon.png', full, 256],
      ['build/tray-16.png', small, 16],
      ['build/tray-32.png', small, 32],
      ['web/public/icon-192.png', full, 192],
      ['web/public/icon-512.png', full, 512],
      ['web/public/favicon.png', small, 64],
    ];
    const pngs = await renderAll([...files.map(([, svg, size]) => [svg, size]), ...icoSizes.map((s) => [pick(s), s])]);
    mkdirSync(BUILD, { recursive: true });
    mkdirSync(PUBLIC, { recursive: true });
    files.forEach(([rel], i) => writeFileSync(path.join(here, '..', rel), pngs[i]));
    writeFileSync(path.join(BUILD, 'icon.ico'), ico(icoSizes.map((s, i) => [s, pngs[files.length + i]])));
    writeFileSync(path.join(BUILD, 'icon.svg'), full);
    writeFileSync(path.join(PUBLIC, 'logo.svg'), full);
    writeFileSync(path.join(PUBLIC, 'logo-small.svg'), small);
    console.log(`Icons written: ${files.length} images, icon.ico with ${icoSizes.length} sizes, and the SVGs`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
