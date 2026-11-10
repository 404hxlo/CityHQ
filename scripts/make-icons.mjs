// Draws the app icon (a "Q" dial on a sodium-orange tile) with no image tools needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(here, '..', 'build');
const PUBLIC = path.join(here, '..', 'web', 'public');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const smooth = (edge, d, aa) => Math.min(1, Math.max(0, (edge - d) / aa + 0.5));

/** Coverage of tile, ring and tail at a point; coordinates are 0..1. */
function shade(x, y, aa) {
  const cx = x - 0.5;
  const cy = y - 0.5;
  const q = 0.5 - 0.2;
  const dx = Math.max(Math.abs(cx) - q, 0);
  const dy = Math.max(Math.abs(cy) - q, 0);
  const tile = smooth(0, Math.hypot(dx, dy) - 0.2, aa);

  const r = Math.hypot(cx, cy + 0.015);
  const ring = smooth(0.062, Math.abs(r - 0.235), aa);

  // Tail: a thick segment from the ring toward the lower right.
  const ax = 0.075; const ay = 0.09; const bx = 0.27; const by = 0.285;
  const t = Math.min(1, Math.max(0, ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  const tail = smooth(0.062, Math.hypot(cx - ax - t * (bx - ax), cy - ay - t * (by - ay)), aa);

  const mark = Math.max(ring, tail);
  const tileColor = [255, 138, 61];
  const markColor = [20, 22, 25];
  return [
    Math.round(tileColor[0] + (markColor[0] - tileColor[0]) * mark),
    Math.round(tileColor[1] + (markColor[1] - tileColor[1]) * mark),
    Math.round(tileColor[2] + (markColor[2] - tileColor[2]) * mark),
    Math.round(255 * tile),
  ];
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const aa = 1 / size;
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = shade((x + 0.5) / size, (y + 0.5) / size, aa);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map((s) => [s, png(s)]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(([s, data]) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(([, d]) => d)]);
}

mkdirSync(BUILD, { recursive: true });
mkdirSync(PUBLIC, { recursive: true });
writeFileSync(path.join(BUILD, 'icon.png'), png(256));
writeFileSync(path.join(BUILD, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(path.join(PUBLIC, 'icon-192.png'), png(192));
writeFileSync(path.join(PUBLIC, 'icon-512.png'), png(512));
writeFileSync(path.join(PUBLIC, 'favicon.png'), png(64));
console.log('Icons written');
