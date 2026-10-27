'use strict';
/**
 * Lottie (bodymovin v5) scene kit for the generated Voiza art.
 *
 * Everything here is vector-only — no embedded images, fonts, expressions or
 * masks — so one JSON plays unchanged in lottie-web (admin panel) and
 * lottie-compose (Android). Star shapes are emitted as explicit vertex paths
 * rather than bodymovin's `sr` polystar, because the Android renderer handles
 * `sh`/`el`/`rc` reliably and polystar support is not guaranteed.
 *
 * Used by generate-placeholder-assets.cjs; not a runtime dependency.
 */

const TAU = Math.PI * 2;
const INK = '#241a2e';
const round2 = (n) => Math.round(n * 100) / 100;
const range = (n) => Array.from({ length: n }, (_, i) => i);

// Bodymovin encodes easing as a cubic bezier per keyframe: the segment leaving a
// keyframe uses that keyframe's `o` handle and the next keyframe's `i` handle,
// matching the CSS timing-function control points.
const CURVE = {
  linear: { o: [0.33, 0.33], i: [0.67, 0.67] },
  in: { o: [0.42, 0], i: [1, 1] },
  out: { o: [0, 0], i: [0.58, 1] },
  inOut: { o: [0.42, 0], i: [0.58, 1] },
  pop: { o: [0.1, 0.9], i: [0.3, 1] },
};

/** '#rgb' | '#rrggbb' -> Lottie's normalised [r,g,b,1]. */
function paint(value) {
  const v = value.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [
    round2(parseInt(full.slice(0, 2), 16) / 255),
    round2(parseInt(full.slice(2, 4), 16) / 255),
    round2(parseInt(full.slice(4, 6), 16) / 255),
    1,
  ];
}

const sv = (k) => ({ a: 0, k });
const isFrames = (v) => Array.isArray(v) && Array.isArray(v[0]);

function handles(pair, dims) {
  return { x: Array(dims).fill(pair[0]), y: Array(dims).fill(pair[1]) };
}

function av(frames) {
  const last = frames.length - 1;
  return {
    a: 1,
    k: frames.map((frame, idx) => {
      const [t, raw, curve] = frame;
      const value = Array.isArray(raw) ? raw : [raw];
      const dims = value.length;
      if (idx === last) return { t, s: value };
      const c = CURVE[curve || 'inOut'];
      return { t, s: value, o: handles(c.o, dims), i: handles(c.i, dims) };
    }),
  };
}

/** `spec` is either a literal value (static) or `[frame, value, curve?]` tuples. */
function val(spec, fallback, mode = null) {
  if (isFrames(spec)) {
    return av(spec.map(([t, v, curve]) => [t, coerce(v, mode), curve]));
  }
  return sv(coerce(spec === undefined ? fallback : spec, mode));
}

/** Keyframe values are always arrays (scalar properties get a 1-element array). */
function coerce(value, mode) {
  if (!Array.isArray(value)) return round2(value);
  const out = value.map(round2);
  if (mode === 'pos' && out.length === 2) out.push(0);
  if (mode === 'scale' && out.length === 2) out.push(100);
  return out;
}

// ---------------------------------------------------------------------------
// Shape items
// ---------------------------------------------------------------------------
function groupTransform(offset = [0, 0]) {
  return {
    ty: 'tr',
    nm: 'transform',
    p: sv(offset.map(round2)),
    a: sv([0, 0]),
    s: sv([100, 100]),
    r: sv(0),
    o: sv(100),
    sk: sv(0),
    sa: sv(0),
  };
}

function group(nm, items, offset = [0, 0]) {
  return { ty: 'gr', nm, it: [...items, groupTransform(offset)] };
}

function ellipse({ name = 'ellipse', size = [100, 100], pos = [0, 0] }) {
  return { ty: 'el', nm: name, p: sv(pos.map(round2)), s: sv(size.map(round2)) };
}

function rect({ name = 'rect', size = [80, 40], pos = [0, 0], roundness = 0 }) {
  return { ty: 'rc', nm: name, p: sv(pos.map(round2)), s: sv(size.map(round2)), r: sv(roundness) };
}

/** Straight-edged path; tangents are zero so both renderers take the same shortcut. */
function polyPath({ name = 'path', points, closed = true }) {
  const v = points.map(([x, y]) => [round2(x), round2(y)]);
  const zero = v.map(() => [0, 0]);
  return {
    ty: 'sh',
    nm: name,
    np: 2,
    bs: closed ? 1 : 2,
    hd: false,
    ks: { a: 0, k: { i: zero, o: zero, v, c: closed } },
  };
}

function starPoints({ points = 5, innerR = 40, outerR = 90, rotation = 0 }) {
  const total = points * 2;
  const offset = (rotation * Math.PI) / 180 - Math.PI / 2;
  return range(total).map((i) => {
    const a = (i / total) * TAU + offset;
    const r = i % 2 === 0 ? outerR : innerR;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
}

function starPath({ name = 'star', points = 5, innerR = 40, outerR = 90, rotation = 0 }) {
  return polyPath({ name, points: starPoints({ points, innerR, outerR, rotation }) });
}

function fill(color, opacity = 100) {
  return { ty: 'fl', nm: 'fill', c: sv(paint(color)), o: sv(opacity), r: 1, bm: 0 };
}

function stroke(color, width = 8, opacity = 100) {
  return { ty: 'st', nm: 'stroke', c: sv(paint(color)), o: sv(opacity), w: sv(width), lc: 2, lj: 2, ml: 1, bm: 0 };
}

// ---------------------------------------------------------------------------
// Layers and compositions
// ---------------------------------------------------------------------------
function layer({ nm, ip = 0, op, bm = 0, shapes, pos, anchor, scale, rot, opacity }) {
  return {
    ddd: 0,
    ind: 1,
    ty: 4,
    nm,
    sr: 1,
    ao: 0,
    ip,
    op,
    st: 0,
    bm,
    ks: {
      o: val(opacity, 100),
      r: val(rot, 0),
      p: val(pos, [150, 150], 'pos'),
      a: val(anchor, [0, 0], 'pos'),
      s: val(scale, [100, 100], 'scale'),
    },
    shapes,
  };
}

function scene({ name, width = 300, height = 300, fps = 30, op, layers }) {
  const ordered = layers.map((item, idx) => ({ ...item, ind: idx + 1 }));
  // `op` is a floor: a scene must be at least as long as its slowest particle,
  // otherwise the tail of the choreography gets cut off at the composition end.
  const length = Math.max(op ?? 0, ...ordered.map((item) => item.op));
  return {
    v: '5.7.4',
    fr: fps,
    ip: 0,
    op: length,
    w: width,
    h: height,
    nm: name,
    ddd: 0,
    assets: [],
    layers: ordered,
  };
}

// ---------------------------------------------------------------------------
// Motion motifs shared by the gift scenes
// ---------------------------------------------------------------------------
function polar([cx, cy], r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

/** Deterministic jitter so repeated runs produce byte-identical JSON. */
function spread(i, count, amplitude) {
  const golden = 0.6180339887;
  return Math.round(((i * golden) % 1) * 2 * amplitude) - amplitude;
}

function burst({ color, center = [150, 150], start = 0, dur = 45, from = 22, to = 130, spin = 140, points = 8 }) {
  const end = start + dur;
  return [
    layer({
      nm: 'burst',
      ip: start,
      op: end + 1,
      pos: center,
      rot: [[start, 0], [end, spin, 'out']],
      scale: [[start, [from, from]], [end, [to, to], 'out']],
      opacity: [[start, 100], [Math.round(start + dur * 0.55), 85], [end, 0, 'in']],
      shapes: [group('star', [starPath({ points, innerR: 46, outerR: 104 }), fill(color)])],
    }),
  ];
}

function pulseRings({ color, count = 3, center = [150, 150], radius = 120, width = 8, start = 0, dur = 40, stagger = 8 }) {
  return range(count).map((i) => {
    const t0 = start + i * stagger;
    const end = t0 + dur;
    return layer({
      nm: `ring ${i + 1}`,
      ip: t0,
      op: end + 1,
      pos: center,
      scale: [[t0, [10, 10]], [end, [100, 100], 'out']],
      opacity: [[t0, 0], [t0 + 3, 90], [end, 0, 'in']],
      shapes: [group('ring', [ellipse({ size: [radius * 2, radius * 2] }), stroke(color, width)])],
    });
  });
}

function orbitDots({
  color = '#ffffff', count = 8, center = [150, 150], inner = 12, outer = 128, size = 22,
  arc = 60, start = 0, dur = 40, stagger = 2, shape = 'disc',
}) {
  return range(count).map((i) => {
    const t0 = start + i * stagger;
    const end = t0 + dur;
    const angle = (i / count) * 360 - 90;
    return layer({
      nm: `orbit ${i + 1}`,
      ip: t0,
      op: end + 1,
      pos: [
        [t0, polar(center, inner, angle)],
        [end, polar(center, outer, angle + arc), 'out'],
      ],
      scale: [
        [t0, [0, 0]],
        [Math.round(t0 + dur * 0.3), [100, 100], 'out'],
        [end, [26, 26], 'in'],
      ],
      opacity: [
        [t0, 0],
        [t0 + 2, 100],
        [Math.round(t0 + dur * 0.7), 88],
        [end, 0, 'in'],
      ],
      shapes: [
        group(
          `dot ${i + 1}`,
          shape === 'star'
            ? [starPath({ points: 4, innerR: size * 0.24, outerR: size * 0.62 }), fill(color)]
            : [ellipse({ size: [size, size] }), fill(color)],
        ),
      ],
    });
  });
}

function riseDots({
  color = '#ffffff', count = 7, center = [150, 170], spread: width = 90, from = 30, to = -150,
  size = 20, start = 0, dur = 45, stagger = 4, shape = 'disc',
}) {
  return range(count).map((i) => {
    const t0 = start + i * stagger;
    const end = t0 + dur;
    const dx = spread(i, count, width / 2);
    const sway = spread(i + 3, count, 16);
    return layer({
      nm: `rise ${i + 1}`,
      ip: t0,
      op: end + 1,
      pos: [
        [t0, [center[0] + dx, center[1] + from]],
        [Math.round(t0 + dur / 2), [center[0] + dx + sway, center[1] + (from + to) / 2], 'inOut'],
        [end, [center[0] + dx, center[1] + to], 'out'],
      ],
      scale: [
        [t0, [0, 0]],
        [Math.round(t0 + dur * 0.25), [100, 100], 'out'],
        [end, [42, 42], 'in'],
      ],
      opacity: [
        [t0, 0],
        [t0 + 3, 100],
        [Math.round(t0 + dur * 0.6), 80],
        [end, 0, 'in'],
      ],
      shapes: [
        group(
          `bit ${i + 1}`,
          shape === 'heart'
            ? [polyPath({ name: 'heart', points: HEART }), fill(color)]
            : [ellipse({ size: [size, size] }), fill(color)],
        ),
      ],
    });
  });
}

function fallBits({
  colors = ['#ff85ac', '#fbbf24', '#3ddc97'], count = 10, center = [150, 0], width = 200,
  top = -30, bottom = 330, size = [22, 30], start = 0, dur = 60, stagger = 4, spin = 300,
}) {
  return range(count).map((i) => {
    const t0 = start + i * stagger;
    const end = t0 + dur;
    const x = center[0] + spread(i, count, width / 2);
    return layer({
      nm: `confetti ${i + 1}`,
      ip: t0,
      op: end + 1,
      pos: [
        [t0, [x, top]],
        [end, [x + spread(i + 5, count, 26), bottom], 'inOut'],
      ],
      rot: [[t0, i % 2 === 0 ? 0 : 45], [end, spin * (i % 2 === 0 ? 1 : -1), 'linear']],
      opacity: [
        [t0, 0],
        [t0 + 4, 100],
        [Math.round(end - dur * 0.2), 95],
        [end, 0, 'in'],
      ],
      shapes: [
        group(
          `flake ${i + 1}`,
          [rect({ size, roundness: 5 }), fill(colors[i % colors.length])],
        ),
      ],
    });
  });
}

function speedBars({ color = '#ffffff', count = 5, start = 0, dur = 26, thickness = 8, opacity = 40, ys }) {
  const rows = ys || range(count).map((i) => 96 + i * (128 / Math.max(1, count - 1)));
  return rows.map((y, i) => {
    const t0 = start + i * 3;
    const end = t0 + dur;
    const length = 90 + (i % 3) * 40;
    return layer({
      nm: `streak ${i + 1}`,
      ip: t0,
      op: end + 1,
      pos: [
        [t0, [340, y]],
        [end, [-length - 40, y], 'linear'],
      ],
      opacity: [
        [t0, 0],
        [Math.round(t0 + dur * 0.2), opacity],
        [Math.round(t0 + dur * 0.7), opacity],
        [end, 0, 'in'],
      ],
      shapes: [
        group(
          `bar ${i + 1}`,
          [rect({ size: [length, thickness], roundness: thickness / 2 }), fill(color, opacity)],
        ),
      ],
    });
  });
}

/** Rotating four-point sparkle with a breathing opacity — reads as a shine loop. */
function shine({ color = '#ffffff', center = [150, 150], dur = 60, size = 60, start = 0 }) {
  return [
    layer({
      nm: 'shine',
      ip: start,
      op: start + dur + 1,
      pos: center,
      rot: [
        [start, 0],
        [Math.round(start + dur / 2), 180, 'linear'],
        [start + dur, 360, 'linear'],
      ],
      scale: [
        [start, [40, 40]],
        [Math.round(start + dur * 0.3), [100, 100], 'inOut'],
        [Math.round(start + dur * 0.6), [46, 46], 'inOut'],
        [start + dur, [92, 92], 'inOut'],
      ],
      opacity: [
        [start, 30],
        [Math.round(start + dur * 0.3), 100],
        [Math.round(start + dur * 0.62), 40],
        [start + dur, 95],
      ],
      shapes: [
        group('sparkle', [starPath({ points: 4, innerR: size * 0.2, outerR: size }), fill(color)]),
      ],
    }),
  ];
}

const HEART = [
  [0, 15], [-13, 3], [-14, -7], [-7, -11], [0, -5], [7, -11], [14, -7], [13, 3],
];

// ---------------------------------------------------------------------------
// Gift scenes — each is a stylised motion echo of the matching PNG icon
// ---------------------------------------------------------------------------
const GIFT_SCENES = {
  rose: () =>
    scene({
      name: 'Rose bloom',
      op: 62,
      layers: [
        layer({
          nm: 'bloom',
          op: 62,
          pos: [150, 122],
          scale: [
            [0, [0, 0]],
            [14, [104, 104], 'pop'],
            [34, [96, 96]],
            [52, [100, 100], 'out'],
          ],
          opacity: [[0, 0], [6, 100]],
          shapes: [
            group('outer', [ellipse({ size: [150, 150] }), fill('#7e1432')]),
            group('mid', [ellipse({ size: [118, 118] }), fill('#b62b56')]),
            group('inner', [ellipse({ size: [82, 82] }), fill('#dd4d78')]),
            group('core', [ellipse({ size: [44, 44] }), fill('#ff85ac')]),
            group('highlight', [ellipse({ size: [18, 18], pos: [-18, -22] }), fill('#ffd0e0')]),
          ],
        }),
        ...pulseRings({ color: '#ff85ac', count: 2, center: [150, 122], radius: 96, width: 6, start: 4, dur: 44, stagger: 14 }),
        ...orbitDots({ color: '#dd4d78', count: 7, center: [150, 122], inner: 48, outer: 148, size: 32, arc: 70, start: 12, dur: 44, stagger: 3 }),
        ...burst({ color: '#ffd0e0', center: [150, 122], start: 34, dur: 26, from: 10, to: 70, points: 6 }),
      ],
    }),

  icecream: () =>
    scene({
      name: 'Ice cream pop',
      op: 66,
      layers: [
        layer({
          nm: 'cone',
          op: 66,
          pos: [150, 210],
          rot: [[0, -7], [12, 6, 'inOut'], [30, -4, 'inOut'], [48, 0, 'out']],
          scale: [[0, [0, 0]], [12, [100, 100], 'pop']],
          shapes: [
            group('cone', [polyPath({ points: [[-42, -34], [42, -34], [0, 62]] }), fill('#cf8f4e')]),
            group('grid', [rect({ size: [68, 12], pos: [0, -30], roundness: 6 }), fill('#b3762f')]),
          ],
        }),
        layer({
          nm: 'scoops',
          op: 66,
          pos: [150, 128],
          scale: [
            [4, [0, 0]],
            [18, [100, 100], 'pop'],
            [40, [97, 97]],
            [58, [102, 102], 'out'],
          ],
          shapes: [
            group('mint', [ellipse({ size: [72, 72], pos: [-32, 6] }), fill('#79e0c0')]),
            group('berry', [ellipse({ size: [68, 68], pos: [32, 8] }), fill('#ff9ab8')]),
            group('cream', [ellipse({ size: [64, 64], pos: [0, -30] }), fill('#ffe3a3')]),
            group('cherry', [ellipse({ size: [26, 26], pos: [0, -66] }), fill('#ff4f68')]),
            group('gloss', [ellipse({ size: [10, 14], pos: [-6, -74] }), fill('#ffffff', 60)]),
          ],
        }),
        ...orbitDots({ color: '#ffffff', count: 9, center: [150, 120], inner: 30, outer: 132, size: 14, arc: 90, start: 16, dur: 44, stagger: 3, shape: 'star' }),
        ...pulseRings({ color: '#79e0c0', count: 2, center: [150, 140], radius: 116, width: 5, start: 8, dur: 42, stagger: 16 }),
      ],
    }),

  perfume: () =>
    scene({
      name: 'Perfume mist',
      op: 68,
      layers: [
        layer({
          nm: 'bottle',
          op: 68,
          pos: [150, 196],
          scale: [[0, [72, 72]], [12, [100, 100], 'pop'], [60, [98, 98]]],
          shapes: [
            group('glass', [rect({ size: [126, 140], roundness: 26 }), fill('#a8d8f5')]),
            group('liquid', [rect({ size: [96, 80], pos: [0, 26], roundness: 18 }), fill('#4aa3e0')]),
            group('medallion', [ellipse({ size: [44, 44] }), fill('#fdf6e9')]),
            group('medallion-core', [ellipse({ size: [24, 24] }), fill('#ffd166')]),
            group('neck', [rect({ size: [34, 26], pos: [0, -78], roundness: 6 }), fill('#c3d0e8')]),
            group('cap', [rect({ size: [52, 32], pos: [0, -104], roundness: 9 }), fill('#e6b64c')]),
            group('sheen', [ellipse({ size: [14, 56], pos: [-46, -22] }), fill('#ffffff', 45)]),
          ],
        }),
        ...riseDots({ color: '#eafaff', count: 9, center: [150, 96], spread: 74, from: -6, to: -88, size: 20, start: 8, dur: 52, stagger: 5 }),
        ...pulseRings({ color: '#4aa3e0', count: 2, center: [150, 108], radius: 88, width: 5, start: 12, dur: 40, stagger: 16 }),
        ...shine({ color: '#ffffff', center: [196, 92], dur: 60, size: 34, start: 4 }),
      ],
    }),

  teddy: () =>
    scene({
      name: 'Teddy hug',
      op: 68,
      layers: [
        layer({
          nm: 'teddy',
          op: 68,
          pos: [150, 152],
          rot: [[0, -6], [16, 6, 'inOut'], [34, -5, 'inOut'], [54, 0, 'out']],
          scale: [[0, [0, 0]], [13, [100, 100], 'pop'], [60, [103, 103], 'out']],
          shapes: [
            group('ear-l', [ellipse({ size: [44, 44], pos: [-46, -50] }), fill('#8d5a2f')]),
            group('ear-r', [ellipse({ size: [44, 44], pos: [46, -50] }), fill('#8d5a2f')]),
            group('ear-l-in', [ellipse({ size: [22, 22], pos: [-46, -50] }), fill('#d3a06b')]),
            group('ear-r-in', [ellipse({ size: [22, 22], pos: [46, -50] }), fill('#d3a06b')]),
            group('head', [ellipse({ size: [110, 110] }), fill('#a9713f')]),
            group('muzzle', [ellipse({ size: [56, 40], pos: [0, 20] }), fill('#dcb283')]),
            group('eye-l', [ellipse({ size: [13, 13], pos: [-21, -10] }), fill(INK)]),
            group('eye-r', [ellipse({ size: [13, 13], pos: [21, -10] }), fill(INK)]),
            group('nose', [ellipse({ size: [18, 13], pos: [0, 8] }), fill('#3a2418')]),
          ],
        }),
        ...riseDots({ color: '#ff4f68', count: 6, center: [150, 250], spread: 130, from: 0, to: -180, size: 30, start: 10, dur: 52, stagger: 6, shape: 'heart' }),
        ...pulseRings({ color: '#d3a06b', count: 2, radius: 112, width: 5, start: 0, dur: 46, stagger: 18 }),
      ],
    }),

  ring: () =>
    scene({
      name: 'Ring sparkle',
      op: 70,
      layers: [
        layer({
          nm: 'band',
          op: 70,
          pos: [150, 190],
          scale: [[0, [0, 0]], [12, [100, 100], 'pop'], [62, [104, 104], 'out']],
          shapes: [group('band', [ellipse({ size: [126, 126] }), stroke('#e9b949', 20)])],
        }),
        layer({
          nm: 'setting',
          op: 70,
          pos: [150, 112],
          scale: [[0, [0, 0]], [8, [0, 0]], [20, [100, 100], 'pop'], [52, [112, 112], 'out']],
          rot: [[0, 0], [58, 14, 'out']],
          shapes: [
            group('basket', [polyPath({ points: [[-30, 14], [30, 14], [20, 40], [-20, 40]] }), fill('#d9a63a')]),
            group('stone', [polyPath({ points: [[-44, -12], [-22, -34], [22, -34], [44, -12], [0, 22]] }), fill('#8fd4f2')]),
            group('table', [polyPath({ points: [[-22, -34], [22, -34], [30, -16], [-30, -16]] }), fill('#eafaff')]),
          ],
        }),
        ...shine({ color: '#ffffff', center: [150, 78], dur: 66, size: 70, start: 10 }),
        ...orbitDots({ color: '#c6efff', count: 8, center: [150, 150], inner: 40, outer: 142, size: 22, start: 20, dur: 42, stagger: 3, shape: 'star' }),
        ...burst({ color: '#fbe4a5', start: 46, dur: 22, from: 8, to: 62, points: 8 }),
      ],
    }),

  rocket: () =>
    scene({
      name: 'Rocket launch',
      op: 80,
      layers: [
        layer({
          nm: 'rocket',
          op: 80,
          pos: [
            [0, [150, 250]],
            [20, [150, 214], 'in'],
            [72, [46, 24], 'out'],
          ],
          rot: [[0, 0], [40, -5, 'inOut'], [70, 4, 'inOut']],
          shapes: [
            group('flame', [polyPath({ points: [[-17, 58], [17, 58], [0, 118]] }), fill('#ffb443')]),
            group('flame-core', [polyPath({ points: [[-9, 58], [9, 58], [0, 96]] }), fill('#ff6b4a')]),
            group('fin-l', [polyPath({ points: [[-24, -10], [-50, 52], [-12, 40]] }), fill('#ff5470')]),
            group('fin-r', [polyPath({ points: [[24, -10], [50, 52], [12, 40]] }), fill('#ff5470')]),
            group('hull', [rect({ size: [52, 122], roundness: 26 }), fill('#eef3fb')]),
            group('nose', [polyPath({ points: [[-26, -46], [26, -46], [0, -86]] }), fill('#ff5470')]),
            group('window', [ellipse({ size: [34, 34] }), fill('#2a3f63')]),
            group('window-glass', [ellipse({ size: [24, 24] }), fill('#63c8f5')]),
          ],
        }),
        ...pulseRings({ color: '#c3d0e8', count: 3, center: [150, 256], radius: 74, width: 12, start: 0, dur: 34, stagger: 6 }),
        ...riseDots({ color: '#ffb443', count: 8, center: [150, 250], spread: 60, from: 0, to: -70, size: 16, start: 4, dur: 30, stagger: 3 }),
        ...burst({ color: '#ff5470', start: 58, dur: 20, from: 22, to: 150, points: 8 }),
        ...orbitDots({ color: '#ffe3a3', count: 10, center: [110, 90], inner: 8, outer: 138, size: 18, start: 58, dur: 20, stagger: 1, shape: 'star' }),
      ],
    }),

  car: () =>
    scene({
      name: 'Sports car drift',
      op: 74,
      layers: [
        layer({
          nm: 'car',
          op: 74,
          pos: [150, 182],
          rot: [[0, -3], [14, 3, 'inOut'], [34, -2, 'inOut'], [56, 0, 'out']],
          scale: [[0, [0, 0]], [12, [100, 100], 'pop']],
          shapes: [
            group('shadow', [ellipse({ size: [204, 22], pos: [0, 54] }), fill('#000000', 24)]),
            group('body', [polyPath({ points: [[-110, 16], [-96, -22], [-38, -32], [42, -32], [86, -18], [110, 16], [96, 28], [-96, 28]] }), fill('#e33b52')]),
            group('cabin', [polyPath({ points: [[-46, -28], [-30, -58], [32, -58], [48, -28]] }), fill('#9fe4ff')]),
            group('stripe', [rect({ size: [170, 8], pos: [0, 2], roundness: 4 }), fill('#ffffff', 30)]),
            group('wheel-l', [ellipse({ size: [48, 48], pos: [-56, 26] }), fill('#1a1a22')]),
            group('wheel-r', [ellipse({ size: [48, 48], pos: [62, 26] }), fill('#1a1a22')]),
            group('hub-l', [ellipse({ size: [20, 20], pos: [-56, 26] }), fill('#b9c2d4')]),
            group('hub-r', [ellipse({ size: [20, 20], pos: [62, 26] }), fill('#b9c2d4')]),
            group('headlight', [ellipse({ size: [16, 12], pos: [104, 4] }), fill('#ffe08a')]),
          ],
        }),
        ...speedBars({ color: '#ffffff', count: 6, start: 4, dur: 30, opacity: 35 }),
        ...speedBars({ color: '#ff85ac', count: 4, start: 16, dur: 26, opacity: 45, ys: [110, 152, 194, 236] }),
        ...burst({ color: '#e33b52', start: 50, dur: 22, from: 14, to: 118, points: 6 }),
      ],
    }),

  castle: () =>
    scene({
      name: 'Castle raise',
      op: 88,
      layers: [
        layer({
          nm: 'tower-l',
          op: 88,
          pos: [72, 176],
          anchor: [0, 64],
          scale: [[2, [100, 4]], [18, [100, 100], 'out'], [80, [100, 100]]],
          shapes: [
            group('shaft', [rect({ size: [52, 128], roundness: 6 }), fill('#9aa7c2')]),
            group('crenel', [rect({ size: [52, 20], pos: [0, -74], roundness: 4 }), fill('#9aa7c2')]),
            group('slot', [rect({ size: [12, 26], pos: [0, -18], roundness: 5 }), fill('#2a3350')]),
          ],
        }),
        layer({
          nm: 'tower-r',
          op: 88,
          pos: [228, 176],
          anchor: [0, 64],
          scale: [[6, [100, 4]], [22, [100, 100], 'out'], [80, [100, 100]]],
          shapes: [
            group('shaft', [rect({ size: [52, 128], roundness: 6 }), fill('#9aa7c2')]),
            group('crenel', [rect({ size: [52, 20], pos: [0, -74], roundness: 4 }), fill('#9aa7c2')]),
            group('slot', [rect({ size: [12, 26], pos: [0, -18], roundness: 5 }), fill('#2a3350')]),
          ],
        }),
        layer({
          nm: 'keep',
          op: 88,
          pos: [150, 188],
          anchor: [0, 76],
          scale: [[10, [100, 4]], [28, [100, 100], 'out'], [80, [100, 100]]],
          shapes: [
            group('wall', [rect({ size: [124, 152], roundness: 6 }), fill('#b6c1d8')]),
            group('crenel', [rect({ size: [124, 22], pos: [0, -86], roundness: 4 }), fill('#b6c1d8')]),
            group('door', [rect({ size: [44, 72], pos: [0, 40], roundness: 20 }), fill('#4a3b6a')]),
            group('rose', [ellipse({ size: [22, 22], pos: [0, -40] }), fill('#2a3350')]),
            group('mast', [rect({ size: [6, 56], pos: [0, -122], roundness: 3 }), fill('#7a8496')]),
            group('flag', [polyPath({ points: [[3, -146], [48, -132], [3, -118]] }), fill('#ff5470')]),
          ],
        }),
        ...fallBits({ count: 14, start: 18, dur: 56, stagger: 3 }),
        ...pulseRings({ color: '#b6c1d8', count: 2, center: [150, 180], radius: 148, width: 6, start: 24, dur: 44, stagger: 14 }),
        ...burst({ color: '#ffffff', start: 62, dur: 24, from: 18, to: 150, points: 8 }),
      ],
    }),

  crown: () =>
    scene({
      name: 'King crown',
      op: 92,
      layers: [
        layer({
          nm: 'crown',
          op: 92,
          pos: [150, 168],
          anchor: [0, 40],
          scale: [
            [0, [0, 0]],
            [14, [108, 108], 'pop'],
            [28, [100, 100]],
            [86, [104, 104], 'out'],
          ],
          rot: [[0, 0], [22, -4, 'inOut'], [48, 4, 'inOut'], [72, 0, 'out']],
          shapes: [
            group('points', [polyPath({ points: [[-86, -6], [-86, -96], [-32, -52], [0, -110], [32, -52], [86, -96], [86, -6]] }), fill('#f0bc55')]),
            group('facet', [polyPath({ points: [[-86, -6], [-86, -64], [-32, -30], [0, -82], [32, -30], [86, -64], [86, -6]] }), fill('#ffd984', 70)]),
            group('band', [rect({ size: [176, 46], pos: [0, 22], roundness: 12 }), fill('#e0a63c')]),
            group('sheen', [rect({ size: [176, 14], pos: [0, 8], roundness: 7 }), fill('#f8d98b')]),
            group('gem-l', [ellipse({ size: [20, 20], pos: [-38, 26] }), fill('#ff4f68')]),
            group('gem-c', [ellipse({ size: [24, 24], pos: [0, 26] }), fill('#4f8cff')]),
            group('gem-r', [ellipse({ size: [20, 20], pos: [38, 26] }), fill('#3ec98f')]),
            group('pearl-l', [ellipse({ size: [18, 18], pos: [-86, -104] }), fill('#fff3d0')]),
            group('pearl-c', [ellipse({ size: [20, 20], pos: [0, -118] }), fill('#fff3d0')]),
            group('pearl-r', [ellipse({ size: [18, 18], pos: [86, -104] }), fill('#fff3d0')]),
          ],
        }),
        ...shine({ color: '#fff3d0', center: [150, 46], dur: 88, size: 84, start: 6 }),
        ...orbitDots({ color: '#f8d98b', count: 10, center: [150, 150], inner: 56, outer: 148, size: 24, start: 18, dur: 56, stagger: 4, shape: 'star' }),
        ...pulseRings({ color: '#f0bc55', count: 3, center: [150, 160], radius: 150, width: 6, start: 10, dur: 50, stagger: 12 }),
        ...burst({ color: '#fbe4a5', start: 64, dur: 26, from: 24, to: 160, points: 8 }),
      ],
    }),

  heart: () =>
    scene({
      name: 'Heart beat',
      op: 64,
      layers: [
        layer({
          nm: 'heart',
          op: 64,
          pos: [150, 146],
          // Two beats, then settle: a single pop reads as a bounce, not a pulse.
          scale: [
            [0, [0, 0]],
            [10, [114, 114], 'pop'],
            [20, [94, 94]],
            [30, [108, 108]],
            [44, [98, 98]],
            [62, [100, 100], 'out'],
          ],
          shapes: [
            group('body', [polyPath({ name: 'heart', points: HEART.map(([x, y]) => [round2(x * 4.8), round2(y * 4.8)]) }), fill('#e0264c')]),
            group('bright', [polyPath({ name: 'heart', points: HEART.map(([x, y]) => [round2(x * 3.1), round2(y * 3.1)]) }), fill('#ff85ac')]),
            group('gloss', [ellipse({ size: [22, 30], pos: [-30, -28] }), fill('#ffd0e0', 85)]),
          ],
        }),
        ...riseDots({ color: '#ff4f68', count: 7, center: [150, 284], spread: 172, from: 0, to: -214, size: 26, start: 8, dur: 50, stagger: 6, shape: 'heart' }),
        ...pulseRings({ color: '#ff85ac', count: 2, center: [150, 150], radius: 118, width: 5, start: 4, dur: 42, stagger: 14 }),
        ...burst({ color: '#ffd0e0', center: [150, 146], start: 30, dur: 24, from: 20, to: 108, points: 6 }),
      ],
    }),

  star: () =>
    scene({
      name: 'Lucky star',
      op: 68,
      layers: [
        layer({
          nm: 'star',
          op: 68,
          pos: [150, 150],
          rot: [[0, -42], [18, 9, 'pop'], [40, -5, 'inOut'], [66, 0, 'out']],
          scale: [[0, [0, 0]], [14, [110, 110], 'pop'], [34, [97, 97]], [62, [102, 102], 'out']],
          shapes: [
            group('outer', [starPath({ points: 5, innerR: 44, outerR: 104 }), fill('#e0a63c')]),
            group('mid', [starPath({ points: 5, innerR: 34, outerR: 84 }), fill('#ffd166')]),
            group('core', [starPath({ points: 5, innerR: 20, outerR: 52 }), fill('#fff3c4')]),
          ],
        }),
        ...orbitDots({ color: '#fbe4a5', count: 8, center: [150, 150], inner: 58, outer: 150, size: 22, arc: 80, start: 10, dur: 46, stagger: 4, shape: 'star' }),
        ...shine({ color: '#ffffff', center: [150, 150], dur: 62, size: 44, start: 6 }),
        ...burst({ color: '#fff3c4', center: [150, 150], start: 36, dur: 26, from: 22, to: 132, points: 8 }),
      ],
    }),

  balloon: () =>
    scene({
      name: 'Balloon rise',
      op: 76,
      layers: [
        layer({
          nm: 'balloon',
          op: 76,
          pos: [
            [0, [150, 232]],
            [22, [138, 148], 'inOut'],
            [46, [162, 128], 'inOut'],
            [74, [150, 152], 'out'],
          ],
          rot: [[0, -7], [24, 6, 'inOut'], [52, -4, 'inOut'], [74, 0, 'out']],
          scale: [[0, [0, 0]], [12, [100, 100], 'pop'], [70, [103, 103], 'out']],
          shapes: [
            group('body', [ellipse({ size: [124, 146] }), fill('#ff5470')]),
            group('rim', [ellipse({ size: [124, 146] }), stroke('#d4345a', 6, 90)]),
            group('knot', [polyPath({ points: [[-14, 74], [14, 74], [0, 96]] }), fill('#d4345a')]),
            group('string', [rect({ size: [5, 84], pos: [0, 136], roundness: 2 }), fill('#c3d0e8')]),
            group('gloss', [ellipse({ size: [22, 44], pos: [-30, -26] }), fill('#ffffff', 45)]),
          ],
        }),
        ...riseDots({ color: '#ffffff', count: 6, center: [150, 280], spread: 150, from: 0, to: -180, size: 14, start: 10, dur: 52, stagger: 7, shape: 'star' }),
        ...pulseRings({ color: '#ff85ac', count: 2, center: [150, 170], radius: 126, width: 4, start: 6, dur: 44, stagger: 18 }),
      ],
    }),

  lollipop: () =>
    scene({
      name: 'Lollipop spin',
      op: 72,
      layers: [
        layer({
          nm: 'lollipop',
          op: 72,
          pos: [150, 152],
          // A continuous half-turn is what makes the concentric rings read as a
          // swirl; the disc itself never changes shape.
          rot: [[0, -20], [70, 300, 'linear']],
          scale: [[0, [0, 0]], [14, [106, 106], 'pop'], [40, [98, 98]], [68, [100, 100], 'out']],
          shapes: [
            group('disc', [ellipse({ size: [136, 136] }), fill('#e0264c')]),
            group('swirl-1', [ellipse({ size: [112, 112] }), stroke('#fdf6e9', 14, 100)]),
            group('swirl-2', [ellipse({ size: [74, 74] }), stroke('#fdf6e9', 14, 100)]),
            group('swirl-3', [ellipse({ size: [36, 36] }), stroke('#fdf6e9', 12, 100)]),
            group('core', [ellipse({ size: [16, 16] }), fill('#ff85ac')]),
          ],
        }),
        layer({
          nm: 'stick',
          op: 72,
          pos: [150, 244],
          scale: [[0, [100, 0]], [12, [100, 100], 'out'], [68, [100, 100]]],
          shapes: [group('cane', [rect({ size: [14, 84], roundness: 7 }), fill('#fdf6e9')])],
        }),
        ...orbitDots({ color: '#ff85ac', count: 7, center: [150, 150], inner: 84, outer: 150, size: 18, arc: 60, start: 14, dur: 48, stagger: 5 }),
        ...shine({ color: '#ffffff', center: [108, 108], dur: 66, size: 30, start: 4 }),
      ],
    }),

  cake: () =>
    scene({
      name: 'Cake celebrate',
      op: 80,
      layers: [
        layer({
          nm: 'cake',
          op: 80,
          pos: [150, 200],
          anchor: [0, 44],
          scale: [[4, [100, 0]], [20, [100, 100], 'out'], [72, [102, 102], 'out']],
          shapes: [
            group('sponge', [rect({ size: [168, 64], pos: [0, 12], roundness: 12 }), fill('#f6d7a8')]),
            group('filling', [rect({ size: [168, 34], pos: [0, 44], roundness: 10 }), fill('#ff9ab8')]),
            group('frosting', [ellipse({ size: [172, 44] }), fill('#fdf6e9')]),
            group('drip-1', [ellipse({ size: [22, 22], pos: [-54, 18] }), fill('#fdf6e9')]),
            group('drip-2', [ellipse({ size: [22, 22], pos: [0, 22] }), fill('#fdf6e9')]),
            group('drip-3', [ellipse({ size: [22, 22], pos: [54, 18] }), fill('#fdf6e9')]),
            group('berry-l', [ellipse({ size: [18, 18], pos: [-54, 42] }), fill('#ff4f68')]),
            group('berry-c', [ellipse({ size: [18, 18], pos: [0, 46] }), fill('#4f8cff')]),
            group('berry-r', [ellipse({ size: [18, 18], pos: [54, 42] }), fill('#3ec98f')]),
          ],
        }),
        layer({
          nm: 'flame-l',
          op: 80,
          pos: [106, 128],
          scale: [
            [16, [100, 100]],
            [26, [78, 116]],
            [36, [108, 92]],
            [48, [82, 112]],
            [60, [104, 96]],
            [78, [96, 100], 'out'],
          ],
          shapes: [
            group('candle', [rect({ size: [14, 60], pos: [0, 44], roundness: 6 }), fill('#7ee0f5')]),
            group('fire', [ellipse({ size: [20, 34] }), fill('#ffb443')]),
            group('fire-core', [ellipse({ size: [10, 18], pos: [0, 4] }), fill('#fff3c4')]),
          ],
        }),
        layer({
          nm: 'flame-r',
          op: 80,
          pos: [194, 128],
          scale: [
            [20, [100, 100]],
            [30, [80, 114]],
            [42, [106, 94]],
            [54, [84, 110]],
            [66, [102, 98]],
            [78, [98, 100], 'out'],
          ],
          shapes: [
            group('candle', [rect({ size: [14, 60], pos: [0, 44], roundness: 6 }), fill('#ff9ab8')]),
            group('fire', [ellipse({ size: [20, 34] }), fill('#ffb443')]),
            group('fire-core', [ellipse({ size: [10, 18], pos: [0, 4] }), fill('#fff3c4')]),
          ],
        }),
        ...fallBits({ colors: ['#ff85ac', '#fbbf24', '#3ddc97', '#4f8cff'], count: 12, start: 20, dur: 50, stagger: 4 }),
        ...burst({ color: '#fdf6e9', center: [150, 140], start: 30, dur: 24, from: 30, to: 150, points: 7 }),
      ],
    }),

  fireworks: () =>
    scene({
      name: 'Firework shells',
      op: 92,
      layers: [
        ...burst({ color: '#ff5470', center: [112, 108], start: 4, dur: 34, from: 14, to: 132, points: 12, spin: 90 }),
        ...burst({ color: '#4f8cff', center: [196, 168], start: 26, dur: 32, from: 12, to: 108, points: 10, spin: -120 }),
        ...burst({ color: '#fbbf24', center: [96, 218], start: 48, dur: 30, from: 10, to: 88, points: 9, spin: 150 }),
        ...orbitDots({ color: '#ffffff', count: 6, center: [150, 150], inner: 100, outer: 158, size: 14, arc: 120, start: 12, dur: 60, stagger: 8, shape: 'star' }),
        layer({
          nm: 'flash',
          op: 92,
          pos: [112, 108],
          scale: [[2, [30, 30]], [8, [150, 150], 'out'], [30, [0, 0]]],
          opacity: [[2, 0], [8, 90], [26, 0, 'in']],
          shapes: [group('core', [ellipse({ size: [40, 40] }), fill('#ffffff')])],
        }),
        ...pulseRings({ color: '#ff85ac', count: 2, center: [150, 160], radius: 150, width: 4, start: 34, dur: 44, stagger: 16 }),
      ],
    }),

  jet: () =>
    scene({
      name: 'Jet flyby',
      op: 84,
      layers: [
        ...speedBars({ color: '#c6efff', count: 6, start: 10, dur: 34, thickness: 7, opacity: 34, ys: [72, 108, 144, 180, 216, 252] }),
        layer({
          nm: 'jet',
          op: 84,
          pos: [
            [0, [40, 250]],
            [46, [178, 116], 'linear'],
            [82, [268, 62], 'out'],
          ],
          rot: [[0, -38], [46, -38, 'linear'], [82, -34, 'out']],
          scale: [[0, [40, 40]], [10, [96, 96], 'out'], [60, [100, 100]], [82, [88, 88], 'in']],
          opacity: [[0, 0], [8, 100], [72, 100], [82, 0, 'in']],
          shapes: [
            group('fuselage', [rect({ size: [150, 40], roundness: 20 }), fill('#dfe7f5')]),
            group('nose', [ellipse({ size: [42, 40], pos: [76, 0] }), fill('#eafaff')]),
            group('tail', [polyPath({ points: [[-74, -6], [-100, -66], [-52, -12]] }), fill('#c3d0e8')]),
            group('wing', [polyPath({ points: [[-4, 8], [-52, 74], [44, 22]] }), fill('#b6c1d8')]),
            group('stripe', [polyPath({ points: [[-30, -14], [34, -26], [38, -8], [-26, 2]] }), fill('#4f8cff')]),
            group('window-1', [ellipse({ size: [13, 13], pos: [-34, -6] }), fill('#2a3350')]),
            group('window-2', [ellipse({ size: [13, 13], pos: [-10, -6] }), fill('#2a3350')]),
            group('window-3', [ellipse({ size: [13, 13], pos: [14, -6] }), fill('#2a3350')]),
            group('gold', [ellipse({ size: [16, 16], pos: [44, 6] }), fill('#ffd166')]),
          ],
        }),
        ...riseDots({ color: '#ffffff', count: 8, center: [70, 260], spread: 60, from: 0, to: -120, size: 22, start: 2, dur: 40, stagger: 4 }),
        ...shine({ color: '#fbe4a5', center: [226, 84], dur: 70, size: 40, start: 20 }),
      ],
    }),
};

// ---------------------------------------------------------------------------
// Welcome + room-effect loops
// ---------------------------------------------------------------------------
function welcomeScene() {
  return scene({
    name: 'Welcome burst',
    op: 96,
    layers: [
      ...pulseRings({ color: '#7c3aed', count: 3, radius: 148, width: 8, start: 0, dur: 54, stagger: 10 }),
      ...pulseRings({ color: '#3ddc97', count: 2, radius: 120, width: 5, start: 14, dur: 48, stagger: 16 }),
      layer({
        nm: 'halo',
        op: 96,
        pos: [150, 150],
        scale: [
          [0, [0, 0]],
          [16, [110, 110], 'pop'],
          [40, [96, 96]],
          [70, [104, 104], 'inOut'],
          [94, [100, 100], 'out'],
        ],
        rot: [[0, 0], [94, 22, 'out']],
        opacity: [[0, 0], [8, 100], [86, 100], [95, 70]],
        shapes: [
          group('ring', [ellipse({ size: [176, 176] }), stroke('#f472b6', 6)]),
          group('core', [ellipse({ size: [120, 120] }), fill('#241a2e', 70)]),
          group('spark', [starPath({ points: 8, innerR: 26, outerR: 88 }), fill('#fbbf24')]),
        ],
      }),
      ...orbitDots({ color: '#fbbf24', count: 12, inner: 20, outer: 150, size: 22, arc: 120, start: 10, dur: 60, stagger: 3, shape: 'star' }),
      ...riseDots({ color: '#ffffff', count: 8, center: [150, 280], spread: 200, from: 0, to: -190, size: 16, start: 20, dur: 60, stagger: 5 }),
      ...burst({ color: '#a78bfa', start: 60, dur: 30, from: 30, to: 170, points: 8 }),
    ],
  });
}

const EFFECT_SCENES = {
  'room-sparkle': () =>
    scene({
      name: 'Sparkle loop',
      op: 72,
      layers: [
        ...orbitDots({ color: '#ffffff', count: 6, inner: 24, outer: 132, size: 20, arc: 40, start: 0, dur: 48, stagger: 6, shape: 'star' }),
        ...shine({ color: '#c6efff', center: [150, 150], dur: 72, size: 56 }),
        ...pulseRings({ color: '#7c3aed', count: 2, radius: 110, width: 4, start: 6, dur: 50, stagger: 20 }),
      ],
    }),
  'room-confetti': () =>
    scene({
      name: 'Confetti loop',
      op: 96,
      layers: [...fallBits({ count: 16, dur: 84, stagger: 5, width: 260 })],
    }),
  'room-hearts': () =>
    scene({
      name: 'Hearts loop',
      op: 90,
      layers: [
        ...riseDots({ color: '#ff4f68', count: 8, center: [150, 290], spread: 190, from: 0, to: -220, size: 30, dur: 70, stagger: 7, shape: 'heart' }),
        ...riseDots({ color: '#ff85ac', count: 5, center: [150, 300], spread: 150, from: 0, to: -200, size: 22, start: 12, dur: 66, stagger: 9, shape: 'heart' }),
      ],
    }),
  'room-glow': () =>
    scene({
      name: 'Glow loop',
      op: 84,
      layers: [
        ...pulseRings({ color: '#3ddc97', count: 3, radius: 140, width: 6, dur: 60, stagger: 14 }),
        ...pulseRings({ color: '#38bdf8', count: 2, radius: 104, width: 4, start: 20, dur: 54, stagger: 18 }),
      ],
    }),
};

// ---------------------------------------------------------------------------
// Structural validation — a malformed keyframe array renders as a blank
// overlay, which is invisible in review, so assert it here instead.
// ---------------------------------------------------------------------------
function validate(animated) {
  const problems = [];
  const push = (where, message) => problems.push(`${where}: ${message}`);

  if (!Array.isArray(animated.layers) || animated.layers.length === 0) push(animated.nm, 'no layers');

  const walk = (value, where) => {
    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${where}[${idx}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if ('a' in value) {
      if (value.a === 0) {
        if (value.k === undefined) push(where, 'static property without k');
        return;
      }
      if (!Array.isArray(value.k) || value.k.length < 2) {
        push(where, 'animated property needs >= 2 keyframes');
        return;
      }
      let previous = -Infinity;
      value.k.forEach((frame, idx) => {
        const at = `${where}#${idx}`;
        if (typeof frame.t !== 'number' || frame.t < previous) push(at, `non-ascending time ${frame.t}`);
        previous = frame.t;
        if (!Array.isArray(frame.s) || frame.s.length === 0) push(at, 'keyframe without value array');
        else frame.s.forEach((n, dim) => {
          if (!Number.isFinite(n)) push(`${at}.s[${dim}]`, `not a number: ${n}`);
        });
        if (idx === value.k.length - 1) return;
        for (const handle of ['o', 'i']) {
          const h = frame[handle];
          if (!h || !Array.isArray(h.x) || !Array.isArray(h.y)) {
            push(at, `missing ${handle} easing handle`);
            continue;
          }
          const dims = frame.s.length;
          if (h.x.length !== dims || h.y.length !== dims) push(at, `${handle} handle length != ${dims} dims`);
          h.x.forEach((n) => {
            if (n < 0 || n > 1) push(at, `${handle}.x out of 0..1: ${n}`);
          });
          h.y.forEach((n) => {
            if (n < -2 || n > 2) push(at, `${handle}.y out of range: ${n}`);
          });
        }
      });
      return;
    }
    Object.entries(value).forEach(([key, child]) => walk(child, `${where}.${key}`));
  };

  const indices = new Set();
  animated.layers.forEach((entry, idx) => {
    const where = `${animated.nm}/layer ${entry.nm || idx}`;
    if (entry.ty !== 4) push(where, `unsupported layer type ${entry.ty}`);
    if (entry.op <= entry.ip) push(where, 'layer ends before it starts');
    if (entry.op > animated.op) push(where, `layer out ${entry.op} exceeds composition op ${animated.op}`);
    if (indices.has(entry.ind)) push(where, 'duplicate layer index');
    indices.add(entry.ind);
    if (!Array.isArray(entry.shapes) || entry.shapes.length === 0) push(where, 'no shapes');
    Object.entries(entry.ks).forEach(([key, prop]) => {
      walk(prop, `${where}.ks.${key}`);
    });
    entry.shapes.forEach((shape, shapeIdx) => {
      const groupWhere = `${where}.shapes[${shapeIdx}]`;
      if (shape.ty !== 'gr') push(groupWhere, `expected a group, got ${shape.ty}`);
      if (!Array.isArray(shape.it) || shape.it.length < 2) push(groupWhere, 'group needs a shape plus styling');
      const tail = shape.it[shape.it.length - 1];
      if (!tail || tail.ty !== 'tr') push(groupWhere, 'group must end with a transform');
      else walk(tail.p, `${groupWhere}.p`);
      shape.it.forEach((item, itemIdx) => {
        if (item.ty === 'fl' || item.ty === 'st') {
          const c = item.c.k;
          if (!Array.isArray(c) || c.length !== 4) push(`${groupWhere}.it[${itemIdx}]`, 'fill colour needs 4 channels');
          else c.forEach((n) => {
            if (!Number.isFinite(n) || n < 0 || n > 1) push(`${groupWhere}.it[${itemIdx}]`, `colour channel outside 0..1: ${n}`);
          });
          if (item.o.k < 0 || item.o.k > 100) push(`${groupWhere}.it[${itemIdx}]`, 'opacity out of 0..100');
        }
        if (item.ty === 'sh') {
          const v = item.ks.k.v;
          if (!Array.isArray(v) || v.length < 3) push(`${groupWhere}.it[${itemIdx}]`, 'path needs >= 3 vertices');
        }
      });
    });
  });

  return problems;
}

module.exports = { GIFT_SCENES, EFFECT_SCENES, welcomeScene, validate };
