#!/usr/bin/env node
/**
 * Generates the placeholder art referenced by the seeded catalogue:
 *   backend/public/gifts/*.{png,json}     (schema.sql gift seed rows)
 *   backend/public/gifts/sounds/*.wav     (the same rows' sound_url)
 *   backend/public/avatars/*.png          (seed.sql demo hosts)
 *   backend/public/welcome.json           (room entry effect)
 *   backend/public/effects/*.json         (loopable room effects)
 *   backend/public/themes/<slug>/wallpaper.png  (room themes)
 *   backend/public/badges/level-<n>.png         (fallback art; migration 0018 re-points the
 *                                                ladder at the imported seals in badges/trace/)
 *
 * Those rows store root-relative URLs (`/gifts/rose.png`), which `express.static`
 * serves from the API origin, so nothing 404s on a fresh VPS until real art lands.
 * Replace this directory with your own assets (or an uploads bucket / CDN) for
 * production — the icon shapes here are drawn procedurally, so the script needs
 * no image library and produces byte-identical output on every run.
 *
 * Gift/welcome/effect animations are Lottie JSON built by scripts/lottie-kit.cjs.
 * Theme slugs mirror the seed INSERTs of migration 0015; those rows are the registry the
 * API serves, and an administrator edits them from the panel — this script only ships art.
 *
 *   node scripts/generate-placeholder-assets.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { GIFT_SCENES, EFFECT_SCENES, welcomeScene, validate } = require('./lottie-kit.cjs');

const SIZE = 256; // output edge, px
const SS = 4; // supersample factor (antialiasing)
const OUT_ROOT = path.resolve(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// PNG encoding (8-bit RGBA, filter 0 or 2) — only needs zlib
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([head, name, data, tail]);
}

function encodePng(width, height, rgba, filter = 'none') {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  // Buffer.copy reads from the receiver, so rgba is the source here.
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    if (filter !== 'up' || y === 0) {
      rgba.copy(raw, row + 1, y * stride, (y + 1) * stride);
      continue;
    }
    // Filter 2 (Up): a smooth gradient becomes a near-zero residual, which
    // deflates by an order of magnitude more than the raw ramp does.
    raw[row] = 2;
    const above = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) raw[row + 1 + x] = (rgba[y * stride + x] - rgba[above + x]) & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Rasterizer: straight colors in, premultiplied-alpha float buffer stored
// ---------------------------------------------------------------------------
function hex(value, alpha = 1) {
  const v = value.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), alpha];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

class Raster {
  constructor(size = SIZE, scale = SS) {
    this.size = size;
    this.scale = scale;
    this.w = size * scale;
    this.h = size * scale;
    this.d = new Float32Array(this.w * this.h * 4); // premultiplied RGB + alpha
  }

  pixel(x, y, c, erase) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    if (erase) {
      this.d[i] = this.d[i + 1] = this.d[i + 2] = this.d[i + 3] = 0;
      return;
    }
    if (c[3] <= 0) return;
    const keep = 1 - c[3];
    this.d[i] = c[0] * c[3] + this.d[i] * keep;
    this.d[i + 1] = c[1] * c[3] + this.d[i + 1] * keep;
    this.d[i + 2] = c[2] * c[3] + this.d[i + 2] * keep;
    this.d[i + 3] = c[3] + this.d[i + 3] * keep;
  }

  /** Even-odd scanline polygon fill. Points are in `size` units. */
  poly(points, color, erase = false) {
    const s = this.scale;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of points) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const top = Math.max(0, Math.floor(minY * s));
    const bottom = Math.min(this.h - 1, Math.ceil(maxY * s));
    for (let y = top; y <= bottom; y += 1) {
      const yc = (y + 0.5) / s;
      const xs = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        if (y1 > yc !== y2 > yc) xs.push((x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1)) * s);
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.round(xs[k]));
        const x1 = Math.min(this.w - 1, Math.round(xs[k + 1]));
        for (let x = x0; x <= x1; x += 1) this.pixel(x, y, color, erase);
      }
    }
  }

  ellipse(cx, cy, rx, ry, rot = 0, color, segments = 56) {
    const pts = [];
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    for (let i = 0; i < segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      pts.push([cx + x * cos - y * sin, cy + x * sin + y * cos]);
    }
    this.poly(pts, color);
  }

  circle(cx, cy, r, color) {
    this.ellipse(cx, cy, r, r, 0, color);
  }

  /** Ring/band: outer and inner contours in one even-odd polygon. */
  annulus(cx, cy, outer, inner, color) {
    const ring = (r) => {
      const pts = [];
      for (let i = 0; i < 72; i += 1) {
        const a = (i / 72) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      return pts;
    };
    this.poly(ring(outer).concat(ring(inner)), color);
  }

  rect(x, y, w, h, radius, color) {
    const r = Math.min(radius, w / 2, h / 2);
    const pts = [];
    const corner = (cx, cy, from) => {
      for (let i = 1; i < 9; i += 1) {
        const a = from + (i / 8) * (Math.PI / 2);
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    };
    pts.push([x + r, y]);
    corner(x + w - r, y + r, -Math.PI / 2);
    pts.push([x + w, y + h - r]);
    corner(x + w - r, y + h - r, 0);
    pts.push([x + r, y + h]);
    corner(x + r, y + h - r, Math.PI / 2);
    pts.push([x, y + r]);
    corner(x + r, y + r, Math.PI);
    this.poly(pts, color);
  }

  /** Vertical gradient clipped to a circle, drawn row by row. */
  gradientDisc(cx, cy, r, topColor, bottomColor) {
    for (let y = Math.floor((cy - r) * this.scale); y <= Math.ceil((cy + r) * this.scale); y += 1) {
      if (y < 0 || y >= this.h) continue;
      const yc = (y + 0.5) / this.scale;
      const dy = yc - cy;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const color = mix(topColor, bottomColor, (yc - (cy - r)) / (2 * r));
      for (let x = Math.max(0, Math.floor((cx - half) * this.scale)); x <= Math.min(this.w - 1, Math.ceil((cx + half) * this.scale)); x += 1) {
        this.pixel(x, y, color, false);
      }
    }
  }

  clipToCircle(cx, cy, r) {
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        const dx = (x + 0.5) / this.scale - cx;
        const dy = (y + 0.5) / this.scale - cy;
        if (dx * dx + dy * dy > r * r) this.pixel(x, y, null, true);
      }
    }
  }

  toRgba() {
    const { size, scale } = this;
    const out = Buffer.alloc(size * size * 4);
    const n = scale * scale;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const i = ((y * scale + dy) * this.w + (x * scale + dx)) * 4;
            a += this.d[i + 3];
            r += this.d[i];
            g += this.d[i + 1];
            b += this.d[i + 2];
          }
        }
        const alpha = a / n;
        const o = (y * size + x) * 4;
        out[o] = alpha > 0 ? Math.min(255, Math.round(r / n / alpha)) : 0;
        out[o + 1] = alpha > 0 ? Math.min(255, Math.round(g / n / alpha)) : 0;
        out[o + 2] = alpha > 0 ? Math.min(255, Math.round(b / n / alpha)) : 0;
        out[o + 3] = Math.round(alpha * 255);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Gift icons
// ---------------------------------------------------------------------------
const INK = '#241a2e';

function rose(c) {
  c.rect(120, 148, 16, 86, 8, hex('#2f7d4f'));
  c.ellipse(92, 190, 28, 12, -0.5, hex('#3f9a63'));
  c.ellipse(178, 202, 24, 11, 0.45, hex('#3f9a63'));
  c.circle(128, 92, 54, hex('#7e1432'));
  c.circle(128, 92, 43, hex('#b62b56'));
  c.circle(128, 92, 31, hex('#dd4d78'));
  c.circle(128, 92, 19, hex('#ff85ac'));
  c.circle(128, 92, 8, hex('#ffd0e0'));
}

function icecream(c) {
  c.poly([[128, 248], [72, 122], [184, 122]], hex('#cf8f4e'));
  c.poly([[104, 178], [152, 178], [158, 188], [98, 188]], hex('#b3762f'));
  c.circle(102, 112, 35, hex('#79e0c0'));
  c.circle(154, 112, 33, hex('#ff9ab8'));
  c.circle(128, 78, 31, hex('#ffe3a3'));
  c.rect(126, 30, 4, 16, 2, hex('#7a4a2a'));
  c.circle(128, 48, 13, hex('#ff4f68'));
  c.circle(124, 44, 4, hex('#ffffff', 0.6));
}

function perfume(c) {
  c.rect(104, 40, 48, 34, 9, hex('#e6b64c'));
  c.rect(116, 70, 24, 26, 5, hex('#c3d0e8'));
  c.rect(68, 92, 120, 128, 24, hex('#a8d8f5', 0.96));
  c.rect(82, 132, 92, 76, 16, hex('#4aa3e0'));
  c.ellipse(92, 116, 8, 26, 0, hex('#ffffff', 0.45));
  c.circle(128, 168, 22, hex('#fdf6e9'));
  c.circle(128, 168, 12, hex('#ffd166'));
}

function teddy(c) {
  c.circle(70, 66, 27, hex('#8d5a2f'));
  c.circle(186, 66, 27, hex('#8d5a2f'));
  c.circle(70, 66, 14, hex('#d3a06b'));
  c.circle(186, 66, 14, hex('#d3a06b'));
  c.circle(128, 198, 50, hex('#a9713f'));
  c.ellipse(128, 208, 27, 30, 0, hex('#dcb283'));
  c.circle(78, 188, 18, hex('#8d5a2f'));
  c.circle(178, 188, 18, hex('#8d5a2f'));
  c.circle(128, 112, 55, hex('#a9713f'));
  c.ellipse(128, 134, 27, 20, 0, hex('#dcb283'));
  c.circle(107, 102, 7, hex(INK));
  c.circle(149, 102, 7, hex(INK));
  c.ellipse(128, 126, 9, 7, 0, hex('#3a2418'));
  c.ellipse(104, 166, 15, 10, 0, hex('#ff4f68'));
  c.ellipse(152, 166, 15, 10, 0, hex('#ff4f68'));
  c.circle(128, 166, 11, hex('#e03a56'));
}

function ring(c) {
  c.annulus(128, 172, 60, 40, hex('#e9b949'));
  c.annulus(128, 172, 60, 54, hex('#fbe4a5'));
  c.poly([[108, 116], [148, 116], [142, 136], [114, 136]], hex('#d9a63a'));
  c.poly([[104, 72], [152, 72], [168, 88], [88, 88]], hex('#eafaff'));
  c.poly([[88, 88], [168, 88], [128, 128]], hex('#8fd4f2'));
  c.poly([[128, 52], [152, 72], [128, 88], [104, 72]], hex('#c6efff'));
  c.poly([[198, 34], [203, 52], [220, 58], [203, 64], [198, 82], [193, 64], [176, 58], [193, 52]], hex('#ffffff', 0.85));
}

function rocket(c) {
  c.poly([[106, 192], [128, 250], [150, 192]], hex('#ffb443'));
  c.poly([[118, 194], [128, 230], [138, 194]], hex('#ff6b4a'));
  c.poly([[96, 138], [56, 208], [96, 194]], hex('#ff5470'));
  c.poly([[160, 138], [200, 208], [160, 194]], hex('#ff5470'));
  c.ellipse(128, 126, 40, 86, 0, hex('#eef3fb'));
  c.poly([[128, 30], [162, 92], [94, 92]], hex('#ff5470'));
  c.rect(90, 168, 76, 16, 8, hex('#c3d0e8'));
  c.circle(128, 128, 23, hex('#2a3f63'));
  c.circle(128, 128, 16, hex('#63c8f5'));
  c.ellipse(122, 122, 5, 7, -0.6, hex('#ffffff', 0.7));
}

function car(c) {
  c.ellipse(128, 234, 104, 12, 0, hex('#000000', 0.22));
  c.poly([[22, 198], [30, 156], [90, 148], [152, 148], [200, 156], [236, 198], [228, 212], [30, 212]], hex('#e33b52'));
  c.poly([[80, 150], [98, 108], [168, 108], [186, 150]], hex('#c62d42'));
  c.poly([[98, 146], [112, 116], [156, 116], [170, 146]], hex('#9fe4ff'));
  c.poly([[40, 180], [214, 180], [214, 188], [40, 188]], hex('#ffffff', 0.28));
  c.circle(78, 208, 28, hex('#1a1a22'));
  c.circle(186, 208, 28, hex('#1a1a22'));
  c.circle(78, 208, 13, hex('#b9c2d4'));
  c.circle(186, 208, 13, hex('#b9c2d4'));
  c.circle(230, 172, 8, hex('#ffe08a'));
  c.circle(28, 174, 6, hex('#ff9a3d'));
}

function castle(c) {
  c.ellipse(128, 236, 112, 12, 0, hex('#000000', 0.2));
  c.rect(28, 96, 44, 136, 4, hex('#9aa7c2'));
  c.rect(184, 96, 44, 136, 4, hex('#9aa7c2'));
  c.rect(70, 124, 116, 108, 4, hex('#b6c1d8'));
  for (const x of [28, 44, 60]) c.rect(x, 84, 12, 16, 2, hex('#9aa7c2'));
  for (const x of [184, 200, 216]) c.rect(x, 84, 12, 16, 2, hex('#9aa7c2'));
  for (const x of [70, 92, 114, 136, 158]) c.rect(x, 112, 14, 16, 2, hex('#b6c1d8'));
  c.rect(110, 172, 36, 60, 16, hex('#4a3b6a'));
  c.rect(44, 122, 12, 20, 5, hex('#2a3350'));
  c.rect(200, 122, 12, 20, 5, hex('#2a3350'));
  c.rect(122, 140, 12, 18, 5, hex('#2a3350'));
  c.rect(125, 38, 6, 54, 3, hex('#7a8496'));
  c.poly([[131, 42], [178, 56], [131, 70]], hex('#ff5470'));
}

function crown(c) {
  c.poly([[44, 178], [44, 82], [92, 128], [128, 56], [164, 128], [212, 82], [212, 178]], hex('#f0bc55'));
  c.poly([[44, 178], [44, 104], [92, 142], [128, 82], [164, 142], [212, 104], [212, 178]], hex('#ffd984', 0.7));
  c.rect(40, 168, 176, 46, 12, hex('#e0a63c'));
  c.rect(40, 168, 176, 14, 7, hex('#f8d98b'));
  c.circle(44, 76, 9, hex('#fff3d0'));
  c.circle(128, 50, 10, hex('#fff3d0'));
  c.circle(212, 76, 9, hex('#fff3d0'));
  c.circle(92, 190, 10, hex('#ff4f68'));
  c.circle(128, 190, 12, hex('#4f8cff'));
  c.circle(164, 190, 10, hex('#3ec98f'));
}

/** N-pointed star outline in `size` units — used by the star and firework art. */
function starPoly(cx, cy, tips, innerR, outerR, rotDeg = -90) {
  const total = tips * 2;
  const offset = (rotDeg * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i < total; i += 1) {
    const a = (i / total) * Math.PI * 2 + offset;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function heart(c) {
  c.circle(98, 92, 46, hex('#a3122f'));
  c.circle(158, 92, 46, hex('#a3122f'));
  c.poly([[52, 104], [204, 104], [128, 220]], hex('#a3122f'));
  c.circle(100, 90, 34, hex('#e0264c'));
  c.circle(156, 90, 34, hex('#e0264c'));
  c.poly([[70, 104], [186, 104], [128, 198]], hex('#e0264c'));
  c.circle(104, 84, 17, hex('#ff85ac'));
  c.circle(152, 86, 11, hex('#ff85ac'));
  c.ellipse(94, 72, 8, 13, -0.5, hex('#ffd0e0'));
}

function star(c) {
  c.poly(starPoly(128, 134, 5, 52, 108), hex('#e0a63c'));
  c.poly(starPoly(128, 134, 5, 40, 88), hex('#ffd166'));
  c.poly(starPoly(128, 132, 5, 24, 56), hex('#fff3c4'));
  c.circle(128, 124, 15, hex('#ffffff', 0.72));
  c.poly(starPoly(208, 56, 4, 5, 19), hex('#ffffff', 0.85));
  c.poly(starPoly(48, 198, 4, 4, 14), hex('#ffffff', 0.65));
}

function balloon(c) {
  c.ellipse(128, 106, 58, 70, 0, hex('#d4345a'));
  c.ellipse(128, 104, 50, 62, 0, hex('#ff5470'));
  c.ellipse(106, 82, 13, 23, -0.5, hex('#ffffff', 0.48));
  c.poly([[116, 172], [140, 172], [128, 194]], hex('#d4345a'));
  // A string is a curve the polygon filler cannot express, so it is sampled.
  for (let i = 0; i < 16; i += 1) {
    const t = i / 15;
    c.circle(128 + Math.sin(t * 5.2) * 17, 196 + t * 50, 2.4, hex('#c3d0e8'));
  }
}

function lollipop(c) {
  c.rect(122, 148, 12, 98, 6, hex('#fdf6e9'));
  c.circle(128, 104, 66, hex('#e0264c'));
  c.annulus(128, 104, 62, 50, hex('#fdf6e9'));
  c.annulus(128, 104, 44, 32, hex('#fdf6e9'));
  c.annulus(128, 104, 26, 16, hex('#fdf6e9'));
  c.circle(128, 104, 9, hex('#ff85ac'));
  c.ellipse(102, 74, 9, 17, -0.6, hex('#ffffff', 0.42));
}

function cake(c) {
  c.rect(60, 152, 136, 74, 12, hex('#8d5a2f'));
  c.rect(64, 156, 128, 38, 10, hex('#f6d7a8'));
  c.rect(64, 188, 128, 34, 10, hex('#ff9ab8'));
  c.ellipse(128, 152, 68, 16, 0, hex('#fdf6e9'));
  for (const x of [76, 102, 128, 154, 180]) c.circle(x, 162, 9, hex('#fdf6e9'));
  for (const x of [100, 156]) {
    c.rect(x - 5, 104, 10, 44, 5, hex('#7ee0f5'));
    c.ellipse(x, 90, 8, 15, 0, hex('#ffb443'));
    c.ellipse(x, 92, 4, 8, 0, hex('#fff3c4'));
  }
  for (const [x, col] of [[76, '#ff4f68'], [128, '#4f8cff'], [180, '#3ec98f']]) c.circle(x, 174, 8, hex(col));
}

function fireworks(c) {
  const shell = (cx, cy, r, color, rays) => {
    for (let i = 0; i < rays; i += 1) {
      const a = (i / rays) * Math.PI * 2;
      c.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 7, hex(color));
      c.circle(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, 4.5, hex(color));
    }
    c.circle(cx, cy, 11, hex('#ffffff', 0.88));
  };
  shell(104, 96, 62, '#ff5470', 12);
  shell(180, 146, 46, '#4f8cff', 10);
  shell(70, 176, 34, '#fbbf24', 8);
  c.poly(starPoly(200, 52, 4, 6, 22), hex('#ffffff', 0.8));
  c.poly(starPoly(46, 52, 4, 5, 16), hex('#ffffff', 0.6));
  for (const x of [104, 128, 152]) c.rect(x, 226, 7, 24, 3, hex('#7a8496'));
}

function jet(c) {
  c.rect(44, 122, 162, 42, 21, hex('#dfe7f5'));
  c.ellipse(206, 143, 22, 21, 0, hex('#eafaff'));
  c.poly([[46, 128], [18, 60], [68, 120]], hex('#c3d0e8'));
  c.poly([[104, 150], [62, 214], [152, 166]], hex('#b6c1d8'));
  c.poly([[100, 130], [152, 106], [158, 130]], hex('#4f8cff'));
  for (let i = 0; i < 6; i += 1) c.circle(76 + i * 20, 136, 6, hex('#2a3350'));
  c.rect(84, 158, 46, 16, 8, hex('#8fa2c0'));
  for (let i = 0; i < 5; i += 1) c.circle(42 - i * 9, 143, 5 - i * 0.6, hex('#ffffff', 0.5 - i * 0.08));
}

const GIFTS = [
  { slug: 'heart', name: 'True Heart', draw: heart },
  { slug: 'rose', name: 'Rose', draw: rose },
  { slug: 'star', name: 'Lucky Star', draw: star },
  { slug: 'icecream', name: 'Ice Cream', draw: icecream },
  { slug: 'balloon', name: 'Balloon', draw: balloon },
  { slug: 'perfume', name: 'Perfume', draw: perfume },
  { slug: 'lollipop', name: 'Lollipop', draw: lollipop },
  { slug: 'teddy', name: 'Teddy', draw: teddy },
  { slug: 'ring', name: 'Ring', draw: ring },
  { slug: 'cake', name: 'Happy Cake', draw: cake },
  { slug: 'rocket', name: 'Rocket', draw: rocket },
  { slug: 'fireworks', name: 'Fireworks', draw: fireworks },
  { slug: 'car', name: 'Sports Car', draw: car },
  { slug: 'castle', name: 'Castle', draw: castle },
  { slug: 'crown', name: 'King Crown', draw: crown },
  { slug: 'jet', name: 'Private Jet', draw: jet },
];

const AVATARS = [
  { slug: 'host-nova', name: 'Nova', top: '#7c3aed', bottom: '#f472b6', glow: '#fbbf24' },
  { slug: 'host-echo', name: 'Echo', top: '#0ea5e9', bottom: '#14b8a6', glow: '#a7f3d0' },
];

// ---------------------------------------------------------------------------
// Room themes. These slugs are the seeded defaults migration 0015 inserts into `room_themes`;
// the rows (editable from the panel) are what the API serves, and wallpapers point at them.
// ---------------------------------------------------------------------------
// Wallpapers are background art the client upscales; 540x960 keeps a smooth
// gradient clean without shipping (or regenerating) a 2 MP bitmap per theme.
const WALL_W = 540;
const WALL_H = 960;

const THEMES = [
  { slug: 'aurora', name: 'Aurora', top: '#0b1030', bottom: '#052b3d', blobs: ['#3ddc97', '#7c3aed', '#38bdf8'], accent: '#3ddc97', veil: 0.34 },
  { slug: 'nebula', name: 'Nebula', top: '#150b2e', bottom: '#2b0a3d', blobs: ['#f472b6', '#7c3aed', '#22d3ee'], accent: '#f472b6', veil: 0.3 },
  { slug: 'sunset-glass', name: 'Sunset Glass', top: '#2a1030', bottom: '#4a1b2e', blobs: ['#ff85ac', '#fbbf24', '#ff5470'], accent: '#fbbf24', veil: 0.3 },
  { slug: 'midnight-ocean', name: 'Midnight Ocean', top: '#030a1c', bottom: '#0a2440', blobs: ['#1d4ed8', '#22d3ee', '#a78bfa'], accent: '#38bdf8', veil: 0.42 },
];

// Glow placement is fixed so every theme shares one composition and the output
// stays byte-identical between runs.
const GLOW_LAYOUT = [
  { cx: 0.22, cy: 0.16, sigma: 0.36, gain: 0.55 },
  { cx: 0.8, cy: 0.44, sigma: 0.3, gain: 0.45 },
  { cx: 0.46, cy: 0.88, sigma: 0.42, gain: 0.34 },
];

/**
 * Vertical gradient + additive radial glows + edge veil, in 720x1280. Cheap to
 * regenerate, small on the wire, and bright enough to keep white seat chips and
 * dark scrim text legible over it.
 */
function wallpaperPng(theme) {
  const from = hex(theme.top);
  const to = hex(theme.bottom);
  const lights = theme.blobs.map((color) => hex(color));
  const rgba = Buffer.alloc(WALL_W * WALL_H * 4);
  for (let y = 0; y < WALL_H; y += 1) {
    const fy = y / (WALL_H - 1);
    const base = mix(from, to, fy);
    for (let x = 0; x < WALL_W; x += 1) {
      const fx = x / (WALL_W - 1);
      // Deterministic 2x2 hash keeps the gradient from banding without the
      // per-pixel noise that would defeat the Up filter's residual.
      const dither = (((((x >> 1) * 7 + (y >> 1) * 13) % 5) - 2) * 0.9);
      let r = base[0] + dither;
      let g = base[1] + dither;
      let b = base[2] + dither;
      for (let i = 0; i < lights.length; i += 1) {
        const lay = GLOW_LAYOUT[i];
        const dx = fx - lay.cx;
        const dy = fy - lay.cy;
        const weight = Math.exp(-(dx * dx + dy * dy) / (2 * lay.sigma * lay.sigma)) * lay.gain;
        const light = lights[i];
        r += light[0] * weight;
        g += light[1] * weight;
        b += light[2] * weight;
      }
      const dxv = fx - 0.5;
      const dyv = fy - 0.5;
      const veil = 1 - theme.veil * (dxv * dxv + dyv * dyv) * 2.4;
      const o = (y * WALL_W + x) * 4;
      rgba[o] = Math.max(0, Math.min(255, Math.round(r * veil)));
      rgba[o + 1] = Math.max(0, Math.min(255, Math.round(g * veil)));
      rgba[o + 2] = Math.max(0, Math.min(255, Math.round(b * veil)));
      rgba[o + 3] = 255;
    }
  }
  return encodePng(WALL_W, WALL_H, rgba, 'up');
}

// ---------------------------------------------------------------------------
// WAV encoding (16-bit signed PCM, mono) — a RIFF header plus samples, so the
// gift sounds need no audio codec dependency and MediaPlayer plays them as-is.
// ---------------------------------------------------------------------------
const RATE = 44100;

function encodeWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM, not a compressed format
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Trim the first and last few ms so a sample boundary is never a click. */
function applyFade(samples) {
  const attack = Math.round(RATE * 0.003);
  const release = Math.round(RATE * 0.02);
  for (let i = 0; i < samples.length; i += 1) {
    if (i < attack) samples[i] *= i / attack;
    if (i > samples.length - release) samples[i] *= (samples.length - i) / release;
  }
  return samples;
}

/** Seeded LCG — the generator has to stay byte-identical across runs. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/** Two-strike bell for the small gifts. */
function chimeWav() {
  const notes = [[1318.5, 0], [1760, 110]];
  const samples = new Float32Array(Math.round(RATE * 0.7));
  for (const [hz, offsetMs] of notes) {
    const start = Math.round((offsetMs / 1000) * RATE);
    for (let i = start; i < samples.length; i += 1) {
      const t = (i - start) / RATE;
      const env = Math.exp(-7 * t);
      // The detuned partial is what makes this a bell instead of a beep.
      samples[i] += env * (Math.sin(2 * Math.PI * hz * t) + 0.45 * Math.sin(2 * Math.PI * hz * 2.76 * t)) * 0.3;
    }
  }
  return encodeWav(applyFade(samples));
}

/** Rising noise sweep for the rocket and car. */
function whooshWav() {
  const rnd = prng(20260101);
  const n = Math.round(RATE * 0.85);
  const samples = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const p = i / n;
    // One-pole filter that opens mid-sweep: the timbre rises, then falls away.
    const k = 0.015 + 0.34 * 4 * p * (1 - p);
    lp += k * (rnd() - lp);
    samples[i] = lp * Math.pow(Math.sin(Math.PI * p), 1.4) * 2.2;
  }
  return encodeWav(applyFade(samples));
}

/** Root-fifth-octave brass fanfare for the castle and crown. */
function fanfareWav() {
  const notes = [
    [523.25, 0, 200],
    [784, 150, 220],
    [1046.5, 320, 430],
  ];
  const samples = new Float32Array(Math.round(RATE * 0.82));
  for (const [hz, offsetMs, durMs] of notes) {
    const start = Math.round((offsetMs / 1000) * RATE);
    const end = Math.min(samples.length, start + Math.round((durMs / 1000) * RATE));
    for (let i = start; i < end; i += 1) {
      const t = (i - start) / RATE;
      const dur = durMs / 1000;
      const env = Math.min(1, t / 0.02) * Math.exp(-2.2 * (t / dur));
      const wave = Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t);
      samples[i] += env * wave * 0.22;
    }
  }
  return encodeWav(applyFade(samples));
}

// ---------------------------------------------------------------------------
// Write everything
// ---------------------------------------------------------------------------
function write(rel, data) {
  const target = path.join(OUT_ROOT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return `${rel} (${(data.length / 1024).toFixed(1)} KB)`;
}

/**
 * An all-transparent raster still encodes to a *valid* PNG, so a rasterizer bug
 * would silently ship empty icons. Count real pixels before writing.
 */
function writeIcon(rel, canvas) {
  const rgba = canvas.toRgba();
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 16) opaque += 1;
  if (opaque < 1500) throw new Error(`${rel} painted only ${opaque} pixels — icon came out empty`);
  return write(rel, encodePng(canvas.size, canvas.size, rgba));
}

const written = [];

/**
 * A Lottie file that fails to parse shows as an empty overlay, which is
 * invisible in review, so every scene is structurally asserted first.
 * Written unindented: these are machine-read keyframe tables, and pretty
 * printing roughly doubles what every room member downloads per gift.
 */
function writeAnimation(rel, animated) {
  const problems = validate(animated);
  if (problems.length) throw new Error(`${rel} is not a valid Lottie:\n  ${problems.join('\n  ')}`);
  return write(rel, Buffer.from(JSON.stringify(animated), 'utf8'));
}

for (const gift of GIFTS) {
  const stage = GIFT_SCENES[gift.slug];
  if (!stage) throw new Error(`gift "${gift.slug}" has no Lottie scene`);
  const canvas = new Raster();
  gift.draw(canvas);
  written.push(writeIcon(path.join('gifts', `${gift.slug}.png`), canvas));
  written.push(writeAnimation(path.join('gifts', `${gift.slug}.json`), stage()));
}

// Catalogue sounds, referenced by gifts.sound_url and played by the gift overlay.
written.push(write(path.join('gifts', 'sounds', 'chime.wav'), chimeWav()));
written.push(write(path.join('gifts', 'sounds', 'whoosh.wav'), whooshWav()));
written.push(write(path.join('gifts', 'sounds', 'fanfare.wav'), fanfareWav()));

written.push(writeAnimation('welcome.json', welcomeScene()));
const EFFECT_URLS = Object.keys(EFFECT_SCENES);
for (const slug of EFFECT_URLS) {
  written.push(writeAnimation(path.join('effects', `${slug}.json`), EFFECT_SCENES[slug]()));
}

for (const theme of THEMES) {
  written.push(write(path.join('themes', theme.slug, 'wallpaper.png'), wallpaperPng(theme)));
}

// ---------------------------------------------------------------------------
// Level badges. The 21 rungs migration 0017 seeds into `rank_levels` carry one of these in
// `badge_url`. Only the colour ramp and the shape are baked here — the name, the XP floor and
// custom uploaded art are all rows an operator edits, and nothing in this file needs to know them.
// ---------------------------------------------------------------------------
const BADGE_RAMP = [
  '#9aa5b1', '#a9714b', '#b07a52', '#b8835a', '#a8b0ba', '#b3bbc4', '#c0c7cf', '#d9a53c',
  '#e2b04a', '#ecbc58', '#7fd3c8', '#8adbd0', '#96e2d8', '#7ea8ff', '#8bb2ff', '#98bdff',
  '#c98cff', '#d49bff', '#dfabff', '#ff8f9e', '#ff6b3d',
];

/**
 * A shield in the rung's colour with 1-3 pips, so a ladder of 21 rungs still reads as a family:
 * the ramp carries the tier and the pip count carries the step within it. 24dp on a phone is the
 * size that matters, so the silhouette is chunky and the rim is 8 units wide.
 */
function badgeCanvas(level, accent) {
  const c = new Raster();
  const base = hex(accent);
  const body = mix(base, [12, 14, 20, 1], 0.72);
  const pip = mix(base, [255, 255, 255, 1], 0.55);
  const shield = [
    [128, 14], [218, 66], [204, 168], [128, 242], [52, 168], [38, 66],
  ];
  const inset = shield.map(([x, y]) => [128 + (x - 128) * 0.84, 132 + (y - 132) * 0.84]);
  c.poly(shield, base); // rim
  c.poly(inset, body); // body
  c.circle(128, 92, 52, hex(accent, 0.2)); // glow behind the pips
  // One to three pips per family of three rungs, so Bronze II reads as "the second step" beside
  // Bronze I. The two top rungs have no family, so they take the full three and the ramp colour
  // (pink, then ember) is what separates them.
  const pips = level === 0 ? 1 : level >= 19 ? 3 : ((level - 1) % 3) + 1;
  const gap = 36;
  const first = 128 - ((pips - 1) * gap) / 2;
  for (let i = 0; i < pips; i += 1) c.circle(first + i * gap, 138, 13, pip);
  return c;
}

for (let level = 0; level < BADGE_RAMP.length; level += 1) {
  written.push(writeIcon(path.join('badges', `level-${level}.png`), badgeCanvas(level, BADGE_RAMP[level])));
}

// A record of what this script drew. Nothing reads it at runtime any more — migration 0015
// copied these values into `room_themes` / `visual_effects`, and that is the live registry.
const manifest = {
  generatedBy: 'scripts/generate-placeholder-assets.cjs',
  welcome: '/welcome.json',
  effects: EFFECT_URLS.map((slug) => `/effects/${slug}.json`),
  themes: THEMES.map((theme) => ({
    slug: theme.slug,
    name: theme.name,
    accent: theme.accent,
    wallpaper: `/themes/${theme.slug}/wallpaper.png`,
  })),
};
written.push(write(path.join('themes', 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')));

for (const host of AVATARS) {
  const c = new Raster();
  c.gradientDisc(128, 128, 128, hex(host.top), hex(host.bottom));
  c.circle(128, 96, 74, hex(host.glow, 0.22));
  c.circle(128, 110, 44, hex('#ffffff', 0.94));
  c.ellipse(128, 236, 74, 60, 0, hex('#ffffff', 0.94));
  c.clipToCircle(128, 128, 126);
  c.annulus(128, 128, 126, 118, hex('#ffffff', 0.35));
  written.push(writeIcon(path.join('avatars', `${host.slug}.png`), c));
}

console.log(`wrote ${written.length} files under ${OUT_ROOT}`);
for (const entry of written) console.log(`  ${entry}`);
