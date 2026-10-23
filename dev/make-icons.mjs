/*
 * Generates the extension icons (no external dependencies).
 * Run with: node dev/make-icons.mjs
 *
 * Deliberately generic: an ascending bar ladder on a neutral slate panel.
 * No motorsport red, no slanted speed bars, no third-party logo shapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../icons/', import.meta.url));

const COLORS = {
  bg: [15, 23, 42, 255],
  panel: [30, 41, 59, 255],
  muted: [100, 116, 139, 255],
  accent: [45, 212, 191, 255]
};

function inRoundRect(x, y, left, top, width, height, r) {
  // returns true if point is inside the rounded rectangle
  var right = left + width;
  var bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;
  var cx = Math.min(Math.max(x, left + r), right - r);
  var cy = Math.min(Math.max(y, top + r), bottom - r);
  var dx = x - cx;
  var dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function draw(size) {
  const SS = 4; // supersampling factor
  const s = size * SS;
  const pixels = new Uint8Array(size * size * 4);

  // ascending quality bars, bottom-aligned
  const bars = [
    { left: 0.20, height: 0.16, color: COLORS.muted },
    { left: 0.37, height: 0.26, color: COLORS.muted },
    { left: 0.54, height: 0.36, color: COLORS.muted },
    { left: 0.71, height: 0.48, color: COLORS.accent }
  ];
  const barWidth = 0.11;
  const barBottom = 0.80;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) / s;
          const py = (y * SS + sy + 0.5) / s;

          let color = null;

          if (inRoundRect(px, py, 0, 0, 1, 1, 0.24)) {
            const inset = 0.10;
            color = inRoundRect(px, py, inset, inset, 1 - inset * 2, 1 - inset * 2, 0.17)
              ? COLORS.panel
              : COLORS.bg;

            for (const bar of bars) {
              const top = barBottom - bar.height;
              if (inRoundRect(px, py, bar.left, top, barWidth, bar.height, barWidth * 0.35)) {
                color = bar.color;
              }
            }
          }

          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += color[3];
          }
        }
      }

      const n = SS * SS;
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(r / n);
      pixels[i + 1] = Math.round(g / n);
      pixels[i + 2] = Math.round(b / n);
      pixels[i + 3] = Math.round(a / n);
    }
  }

  return pixels;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log('wrote', file);
}
