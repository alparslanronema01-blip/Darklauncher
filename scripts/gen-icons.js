'use strict';

// Generates build/icon.png (512px) and build/icon.ico (multi-size, PNG-compressed)
// with zero dependencies. Pure Node PNG/ICO writer.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// pixels: Uint8Array RGBA, width == height == size
function writePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA

  // Add filter byte 0 to each scanline
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- drawing

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function makeIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const na = a / 255;
    const oa = px[i + 3] / 255;
    const outA = na + oa * (1 - na);
    if (outA <= 0) return;
    px[i] = clamp((r * na + px[i] * oa * (1 - na)) / outA);
    px[i + 1] = clamp((g * na + px[i + 1] * oa * (1 - na)) / outA);
    px[i + 2] = clamp((b * na + px[i + 2] * oa * (1 - na)) / outA);
    px[i + 3] = clamp(outA * 255);
  };

  const bg = hex('#161a23');
  const purple = hex('#8b5cf6');
  const deep = hex('#4c1d95');
  const cyan = hex('#22d3ee');

  // Rounded-square mask
  const R = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, R), size - R);
    const cy = Math.min(Math.max(y, R), size - R);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= R * R;
  };

  // Background with diagonal gradient
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue;
      const t = (x + y) / (2 * size);
      const r = bg[0] + (deep[0] - bg[0]) * t;
      const g = bg[1] + (deep[1] - bg[1]) * t;
      const b = bg[2] + (deep[2] - bg[2]) * t;
      set(x, y, r, g, b, 255);
    }
  }

  // Crescent "dark moon": big accent circle minus offset bg circle
  const cx = size * 0.5, cy = size * 0.5, r1 = size * 0.30;
  const ox = size * 0.42, oy = size * 0.40, r2 = size * 0.26; // bite offset toward top-left
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d1 = (x - cx) ** 2 + (y - cy) ** 2;
      const d2 = (x - ox) ** 2 + (y - oy) ** 2;
      if (d1 <= r1 * r1 && d2 > r2 * r2) {
        const t = Math.sqrt(d1) / r1;
        const r = purple[0] + (cyan[0] - purple[0]) * t * 0.5;
        const g = purple[1] + (cyan[1] - purple[1]) * t * 0.5;
        const b = purple[2] + (cyan[2] - purple[2]) * t * 0.5;
        set(x, y, r, g, b, 255);
      }
    }
  }

  // Glow dots (stars)
  const stars = [
    [0.78, 0.24, 0.035], [0.70, 0.70, 0.025], [0.24, 0.72, 0.03], [0.30, 0.22, 0.02]
  ];
  for (const [fx, fy, fr] of stars) {
    const sx = fx * size, sy = fy * size, sr = fr * size;
    for (let y = Math.floor(sy - sr) - 1; y <= sy + sr + 1; y++) {
      for (let x = Math.floor(sx - sr) - 1; x <= sx + sr + 1; x++) {
        const d = Math.sqrt((x - sx) ** 2 + (y - sy) ** 2);
        if (d <= sr) set(x, y, cyan[0], cyan[1], cyan[2], 230);
      }
    }
  }

  return px;
}

// ---------------------------------------------------------------- ICO writer (PNG-compressed entries)

function writeIco(sizes) {
  const pngs = sizes.map((s) => ({ s, png: writePng(s, makeIcon(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { s, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;         // width
    e[1] = s >= 256 ? 0 : s;         // height
    e[2] = 0;                         // palette
    e[3] = 0;                         // reserved
    e.writeUInt16LE(1, 4);            // color planes
    e.writeUInt16LE(32, 6);           // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }

  return Buffer.concat([header, ...entries, ...pngs.map(p => p.png)]);
}

// ---------------------------------------------------------------- main

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const iconPng = writePng(512, makeIcon(512));
fs.writeFileSync(path.join(buildDir, 'icon.png'), iconPng);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), writeIco([16, 24, 32, 48, 64, 128, 256]));

console.log('Icons written to build/icon.png and build/icon.ico');
