'use strict';

// Turns the raw artwork PNG (build/logo-source.png) into the launcher's
// square logo: build/logo-512.png. Zero dependencies — includes a small
// PNG decoder for the exact format the artwork uses (8-bit RGBA, filter 0).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- PNG decode

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file');
  let off = 8;
  let ihdr = null;
  let idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.depth !== 8) throw new Error(`Unsupported bit depth ${ihdr.depth} (need 8)`);
  if (ihdr.colorType !== 6) throw new Error(`Unsupported color type ${ihdr.colorType} (need 6 = RGBA)`);
  if (ihdr.interlace !== 0) throw new Error('Interlaced PNG not supported');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * 4;
  const px = new Uint8Array(width * height * 4);

  // Reverse the per-scanline PNG filters (0-4) on 8-bit RGBA (bpp = 4).
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;   // left
      const b = prev[i];                    // up
      const c = i >= 4 ? prev[i - 4] : 0;   // up-left
      let v = cur[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      else if (f !== 0) throw new Error(`Unsupported scanline filter ${f}`);
      cur[i] = v & 0xff;
    }
    cur.copy(px, y * stride);
    const t = prev; prev.set(cur); cur.fill(0); void t;
  }
  return { width, height, px };
}

// ---------------------------------------------------------------- resampling

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// Bilinear sample from src (w*h RGBA) into a w2 x h2 target.
function resize(src, w, h, w2, h2) {
  const out = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / h2 - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w2; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / w2 - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const o = (y * w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const b = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = clamp255(a + (b - a) * fy);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG encode

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

function writePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA

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

// ---------------------------------------------------------------- logo compose

const SIZE = 512;
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const BACKDROP = hex('#0b0d12');   // var(--bg)
const ACCENT2 = hex('#22d3ee');    // var(--accent-2)

const srcPath = path.join(__dirname, '..', 'build', 'logo-source.png');
if (!fs.existsSync(srcPath)) {
  console.log('build/logo-source.png not found — keeping existing icons (run gen-icons.js for the default set).');
  process.exit(0);
}
const src = decodePng(fs.readFileSync(srcPath));

// Square crop. The moon + figure sit in the upper-middle of the artwork,
// so crop from the top: 347x605 -> 347x347 starting at y=90 keeps the
// full moon and the silhouette centered.
const side = Math.min(src.width, src.height);
const cropY = Math.round((src.height - side) * 0.28);
const cropped = new Uint8Array(side * side * 4);
for (let y = 0; y < side; y++) {
  const from = ((cropY + y) * src.width + 0) * 4;
  cropped.set(src.px.subarray(from, from + side * 4), y * side * 4);
}

// Upscale to working size.
const art = resize(cropped, side, side, SIZE, SIZE);

const px = new Uint8Array(SIZE * SIZE * 4);
const R = SIZE * 0.22; // rounded-corner radius (matches the old icon)
const inRounded = (x, y) => {
  const cx = Math.min(Math.max(x, R), SIZE - R);
  const cy = Math.min(Math.max(y, R), SIZE - R);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
};

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inRounded(x, y)) continue;
    const i = (y * SIZE + x) * 4;

    // Backdrop + artwork, artwork slightly dimmed so UI accents stay dominant.
    let r = BACKDROP[0] + (art[i] - BACKDROP[0]) * 0.92;
    let g = BACKDROP[1] + (art[i + 1] - BACKDROP[1]) * 0.92;
    let b = BACKDROP[2] + (art[i + 2] - BACKDROP[2]) * 0.92;
    let a = art[i + 3] > 0 ? 255 : 255; // opaque tile

    // Soft cyan inner glow on the moon (upper-center region).
    const dxg = x - SIZE * 0.5, dyg = y - SIZE * 0.40;
    const dg = Math.sqrt(dxg * dxg + dyg * dyg);
    if (dg < SIZE * 0.30) {
      const t = 0.10 * (1 - dg / (SIZE * 0.30));
      r += (ACCENT2[0] - r) * t;
      g += (ACCENT2[1] - g) * t;
      b += (ACCENT2[2] - b) * t;
    }

    px[i] = clamp255(r); px[i + 1] = clamp255(g); px[i + 2] = clamp255(b); px[i + 3] = a;
  }
}

const out = path.join(__dirname, '..', 'build', 'logo-512.png');
fs.writeFileSync(out, writePng(SIZE, px));
console.log(`Logo written: ${out} (${SIZE}x${SIZE}, crop ${side}x${side}+0,${cropY})`);

// ------------------------------------------------------------ derived files

// Downscale the composed logo to any size (bilinear).
function logoAt(s) { return resize(px, SIZE, SIZE, s, s); }

// ICO writer. Entries <=64px use BMP/DIB (required by Explorer), large
// ones use PNG compression.
function dibEntry(size, pixels) {
  const w = size, h = size;
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dstRow = h - 1 - y; // DIB rows are bottom-up
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = (dstRow * w + x) * 4;
      xor[di] = pixels[si + 2];     // B
      xor[di + 1] = pixels[si + 1]; // G
      xor[di + 2] = pixels[si];     // R
      xor[di + 3] = pixels[si + 3]; // A
    }
  }
  const andStride = Math.ceil(w / 32) * 4;
  const and = Buffer.alloc(andStride * h); // all-opaque; alpha channel governs
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(w, 4);
  hdr.writeInt32LE(h * 2, 8); // XOR + AND height
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([hdr, xor, and]);
}

function writeIco(sizes) {
  const pngs = sizes.map((s) => ({
    s,
    data: s >= 128 ? writePng(s, logoAt(s)) : dibEntry(s, logoAt(s))
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { s, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.writeFileSync(path.join(buildDir, 'icon.png'), writePng(512, px));
const icoBuf = writeIco([16, 24, 32, 48, 64, 128, 256]);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuf);
// Distinct filename for the desktop shortcut: Windows caches icons by path,
// so a fresh path forces Explorer to re-render instead of serving the old
// cached artwork.
fs.writeFileSync(path.join(buildDir, 'darklauncher-icon.ico'), icoBuf);
try { fs.unlinkSync(path.join(buildDir, 'shortcut-icon.ico')); } catch (_) { /* old rev */ }
fs.writeFileSync(path.join(buildDir, 'logo-32.png'), writePng(32, logoAt(32)));

// Titlebar chip lives next to the renderer files.
fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'logo-titlebar.png'), writePng(32, logoAt(32)));
console.log('icon.png / icon.ico / logo-32.png / logo-titlebar.png updated from artwork');
