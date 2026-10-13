// Logodan (saat kadranı) Windows simgesi ve README görseli üretir; bağımlılık gerektirmez.
//   node scripts/make-icon.mjs  →  assets/icon.ico, ../../docs/images/logo.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const BG = [0x17, 0x1a, 0x21];
const RING = [0x66, 0xc0, 0xf4];
const HANDS = [0x90, 0xba, 0x3c];

/** Logo, 32x32 birimlik koordinatlarda (favicon.svg ile aynı). Kenar yumuşatma için alt örnekleme yapılır. */
function render(size) {
  const ss = 4;
  const px = new Uint8Array(size * size * 4);
  const scale = 32 / size;
  const distToSegment = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  const inRoundRect = (x, y) => {
    const r = 7;
    const cx = Math.min(Math.max(x, r), 32 - r), cy = Math.min(Math.max(y, r), 32 - r);
    return Math.hypot(x - cx, y - cy) <= r;
  };
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          if (!inRoundRect(x, y)) continue;
          let color = BG;
          if (Math.abs(Math.hypot(x - 16, y - 16) - 9.5) <= 1.25) color = RING;
          const hand = Math.min(distToSegment(x, y, 16, 10.5, 16, 16), distToSegment(x, y, 16, 16, 19.6, 18.4));
          if (hand <= 1.25) color = HANDS;
          r += color[0]; g += color[1]; b += color[2]; a += 255;
        }
      }
      const n = ss * ss, i = (py * size + pxl) * 4;
      const covered = a / 255 || 1;
      px[i] = r / covered; px[i + 1] = g / covered; px[i + 2] = b / covered; px[i + 3] = a / n;
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size) {
  const pixels = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG gömülü ICO (Vista ve sonrası) */
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

mkdirSync(join(root, '../assets'), { recursive: true });
writeFileSync(join(root, '../assets/icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
mkdirSync(join(root, '../../../docs/images'), { recursive: true });
writeFileSync(join(root, '../../../docs/images/logo.png'), png(256));
console.log('✓ assets/icon.ico, docs/images/logo.png');
