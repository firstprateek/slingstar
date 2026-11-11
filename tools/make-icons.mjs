// Renders icons/icon.svg to icons/icon-180.png, icon-192.png and icon-512.png by screenshotting it
// in Playwright WebKit (PLAN.md §6). `node tools/make-icons.mjs`
//
// The PNGs are exact-size, fully opaque RGB (no alpha channel): iOS fills transparent icon
// pixels with black, and an opaque file avoids any surprise.
import { webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'icons');
const SIZES = [180, 192, 512];
const BG = [5, 6, 15];   // #05060f behind the SVG, in case of any transparent edge

// ------------------------------------------------------------------ minimal PNG codec
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Decode an 8-bit RGB/RGBA non-interlaced PNG to RGBA. */
function decodePng(buf) {
  let off = 8, width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG (depth ${depth}, colour ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp; const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0; const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0; let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += bpp) {
    rgba[i * 4] = px[j]; rgba[i * 4 + 1] = px[j + 1]; rgba[i * 4 + 2] = px[j + 2]; rgba[i * 4 + 3] = bpp === 4 ? px[j + 3] : 255;
  }
  return { width, height, rgba };
}
/** Encode RGBA as opaque 8-bit RGB, compositing any alpha over BG. */
function encodeRgb(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1); raw[o] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4; const a = rgba[i + 3] / 255;
      for (let c = 0; c < 3; c++) raw[o + 1 + x * 3 + c] = Math.round(rgba[i + c] * a + BG[c] * (1 - a));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ render
const svg = fs.readFileSync(path.join(ICONS, 'icon.svg'), 'utf8');
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const browser = await webkit.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#05060f;overflow:hidden}img{display:block;width:${size}px;height:${size}px}</style></head><body><img id="i" src="${dataUrl}"></body></html>`);
    await page.waitForFunction(() => { const i = /** @type {HTMLImageElement} */ (document.getElementById('i')); return i.complete && i.naturalWidth > 0; });
    await page.evaluate(() => /** @type {HTMLImageElement} */ (document.getElementById('i')).decode().catch(() => {}));
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
    const { width, height, rgba } = decodePng(shot);
    if (width !== size || height !== size) throw new Error(`icon-${size}: got ${width}x${height}`);
    const out = path.join(ICONS, `icon-${size}.png`);
    fs.writeFileSync(out, encodeRgb(width, height, rgba));
    console.log(`wrote ${path.relative(ROOT, out)} (${width}x${height}, RGB, ${fs.statSync(out).size} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
