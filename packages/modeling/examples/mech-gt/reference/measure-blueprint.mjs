// Case C-100 criterion 9: measure the public three-view vector blueprint (design spec §5) into
// derived data. The drawing itself is never stored: pass a local copy of the SVG, and only the
// numbers this script writes (silhouettes, wheel circles and feature lines in meters, car frame)
// enter the repository.
//   node examples/mech-gt/reference/measure-blueprint.mjs <blueprint.svg> > examples/mech-gt/reference/blueprint.json
// Car frame: x left, y up, z forward (nose +z), origin on the ground at the wheelbase center.
// Scale: the side silhouette's length is the public length (4947 mm); its height checks it.
import { readFileSync } from 'node:fs';

const SOURCE = {
  drawing: 'Dimensions.com three-view vector drawing of the reference car (design spec §5)',
  link: 'kept in the design spec §5, not in the repository',
  note: 'measured outlines only; the drawing is not stored',
};
const LENGTH_MM = 4947;
/**
 * Feature lines: the drawing element that carries each one, by view. `span` keeps the part of
 * a side-view element between these distances from the tail (meters), where one drawn line
 * carries two features.
 */
const FEATURES = {
  shoulder: { view: 'right', element: 'POLYLINE-310', span: [0, 1.595], note: 'rear shoulder crease from the tail lamp over the rear arch to the side intake' },
  sideIntake: { view: 'right', element: 'POLYLINE-310', span: [1.595, 5], note: 'outline of the side intake blade behind the door' },
  waist: { view: 'right', element: 'POLYLINE-326', note: 'character line across the door' },
  belt: { view: 'right', element: 'POLYLINE-180', note: 'lower edge of the side glass' },
  sill: { view: 'right', element: 'POLYLINE-331', note: 'lower crease of the side scoop, above the sill' },
  frontFace: { view: 'front', element: 'POLYLINE-148', note: 'front-face outline: hood leading edge, lamp surrounds and lower intakes' },
  tail: { view: 'back', element: 'POLYLINE-91', note: 'tail-lamp band across the rear' },
};

function parsePath(d, steps = 8) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const polys = [];
  let cur = [];
  let [x, y, sx, sy, lcx, lcy, i] = [0, 0, 0, 0, 0, 0, 0];
  let cmd = '';
  const num = () => Number(tokens[i++]);
  const push = (px, py) => {
    cur.push([px, py]);
    [x, y] = [px, py];
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    if (C === 'M') {
      if (cur.length) polys.push(cur);
      cur = [];
      push(num() + ox, num() + oy);
      [sx, sy] = [x, y];
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') push(num() + ox, num() + oy);
    else if (C === 'H') push(num() + ox, y);
    else if (C === 'V') push(x, num() + oy);
    else if (C === 'C' || C === 'S') {
      const [x0, y0] = [x, y];
      const [x1, y1] = C === 'C' ? [num() + ox, num() + oy] : [2 * x - lcx, 2 * y - lcy];
      const [x2, y2, x3, y3] = [num() + ox, num() + oy, num() + ox, num() + oy];
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      [lcx, lcy] = [x2, y2];
      continue;
    } else if (C === 'Z') {
      push(sx, sy);
      polys.push(cur);
      cur = [];
    } else throw new Error(`unsupported path command ${cmd}`);
    [lcx, lcy] = [x, y];
  }
  if (cur.length) polys.push(cur);
  return polys;
}

/** Elements by their innermost group id (the drawing's element ids). */
function elements(text) {
  const out = new Map();
  const stack = [];
  const re = /<(\/?)(g|path|polyline|polygon|line)\b([^>]*?)(\/?)>/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const [, close, tag, attrs, self] = m;
    const attr = (n) => (attrs.match(new RegExp(`\\s${n}="([^"]*)"`)) ?? [])[1];
    if (tag === 'g') {
      if (close) stack.pop();
      else if (!self) stack.push(attr('id') ?? '');
      continue;
    }
    let polys = [];
    if (tag === 'path') polys = parsePath(attr('d') ?? '');
    else if (tag === 'line') polys = [[[+attr('x1'), +attr('y1')], [+attr('x2'), +attr('y2')]]];
    else {
      const n = (attr('points') ?? '').trim().split(/[\s,]+/).map(Number);
      const p = [];
      for (let k = 0; k + 1 < n.length; k += 2) p.push([n[k], n[k + 1]]);
      if (tag === 'polygon') p.push(p[0]);
      polys = [p];
    }
    const id = stack.at(-1) ?? '';
    out.set(id, [...(out.get(id) ?? []), ...polys]);
  }
  return out;
}

/** Kasa circle fit. */
function fitCircle(pts) {
  const s = { x: 0, y: 0, xx: 0, yy: 0, xy: 0, xz: 0, yz: 0, z: 0 };
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    s.x += x; s.y += y; s.xx += x * x; s.yy += y * y; s.xy += x * y; s.xz += x * z; s.yz += y * z; s.z += z;
  }
  const A = [[s.xx, s.xy, s.x], [s.xy, s.yy, s.y], [s.x, s.y, pts.length]];
  const B = [s.xz, s.yz, s.z];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  const [a, b, c] = [0, 1, 2].map((k) => det(A.map((r, i) => r.map((v, j) => (j === k ? B[i] : v)))) / D);
  return { cx: a / 2, cy: b / 2, r: Math.sqrt(c + (a * a + b * b) / 4) };
}

/** Douglas-Peucker in place of the dense flattening (tolerance in output units); a closed loop splits at its farthest point. */
function simplify(p, tol) {
  if (p.length < 3) return p;
  if (Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 1e-9) {
    let far = 1;
    for (let k = 1; k < p.length; k++) if (Math.hypot(p[k][0] - p[0][0], p[k][1] - p[0][1]) > Math.hypot(p[far][0] - p[0][0], p[far][1] - p[0][1])) far = k;
    return [...simplify(p.slice(0, far + 1), tol).slice(0, -1), ...simplify(p.slice(far), tol)];
  }
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = p[a];
    const [bx, by] = p[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1;
    let bi = -1;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((bx - ax) * (ay - p[k][1]) - (ax - p[k][0]) * (by - ay)) / len;
      if (d > best) [best, bi] = [d, k];
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return p.filter((_, k) => keep[k]);
}

const text = readFileSync(process.argv[2], 'utf8');
const els = elements(text);
const outlines = [...els].filter(([id]) => /OUTLINE/i.test(id) || /^POLYLINE-43[6-9]$/.test(id));
const bbox = (p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
const closed = [...els.values()].flat().filter((p) => p.length > 200 && Math.hypot(p[0][0] - p.at(-1)[0], p[0][1] - p.at(-1)[1]) < 0.5);
// The four silhouettes: the long closed outlines, placed by the layout (side top-left, plan bottom-left, front top-right, rear bottom-right).
const byPlace = (left, top) => closed.filter((p) => { const b = bbox(p); return (b[0] < 300) === left && (b[1] < 250) === top; }).sort((a, b) => b.length - a.length)[0];
const side = byPlace(true, true);
const plan = byPlace(true, false);
const front = byPlace(false, true);
const back = byPlace(false, false);
void outlines;

const sb = bbox(side);
const unit = LENGTH_MM / (sb[2] - sb[0]) / 1000;
const ground = sb[3];
// Below the sill only the tires reach: the lowest 8 % of the height.
const low = side.filter((q) => q[1] > ground - (ground - sb[1]) * 0.08);
const rearWheel = fitCircle(low.filter((q) => q[0] < (sb[0] + sb[2]) / 2));
const frontWheel = fitCircle(low.filter((q) => q[0] >= (sb[0] + sb[2]) / 2));
const midX = (rearWheel.cx + frontWheel.cx) / 2;
const pb = bbox(plan);
const planMid = (pb[1] + pb[3]) / 2;
const fb = bbox(front);
const bb = bbox(back);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const pt = (p) => p.map(([a, b]) => [r4(a), r4(b)]);
const views = {
  // right view: (z, y) - the drawing's side view has the nose to the right.
  right: (q) => [(q[0] - midX) * unit, (ground - q[1]) * unit],
  // top view: (x, z) - nose right, the car's left side up.
  top: (q) => [(planMid - q[1]) * unit, (q[0] - midX) * unit],
  // front view: (x, y) - facing the car, its left side on the right.
  front: (q) => [(q[0] - (fb[0] + fb[2]) / 2) * unit, (fb[3] - q[1]) * unit],
  // back view: (x, y) - from behind, its left side on the left.
  back: (q) => [((bb[0] + bb[2]) / 2 - q[0]) * unit, (bb[3] - q[1]) * unit],
};
const TOL = 0.001;
const feature = (name, f) => {
  const polys = els.get(f.element);
  if (polys === undefined) throw new Error(`${name}: element ${f.element} not in the drawing`);
  const tail = Math.min(...side.map((q) => views.right(q)[0]));
  // Split each polyline into the runs whose points lie inside the span.
  const runs = (p) => {
    if (f.span === undefined) return [p];
    const out = [[]];
    for (const q of p) {
      const d = q[0] - tail;
      if (d >= f.span[0] && d <= f.span[1]) out.at(-1).push(q);
      else if (out.at(-1).length) out.push([]);
    }
    return out.filter((r) => r.length > 1);
  };
  const { span, ...rest } = f;
  return { ...rest, ...(span ? { span } : {}), polylines: polys.flatMap((p) => runs(p.map(views[f.view]))).map((p) => pt(simplify(p, TOL))) };
};
const out = {
  schema: 'forgeax.mech-gt.blueprint/1',
  source: SOURCE,
  frame: 'meters; x left, y up, z forward; origin on the ground at the wheelbase center; right view (z, y), top view (x, z), front and back views (x, y)',
  scale: { metersPerUnit: unit, lengthMm: LENGTH_MM, heightMm: Math.round((ground - sb[1]) * unit * 1000 * 10) / 10 },
  wheels: {
    rear: { z: r4((rearWheel.cx - midX) * unit), y: r4((ground - rearWheel.cy) * unit), r: r4(rearWheel.r * unit) },
    front: { z: r4((frontWheel.cx - midX) * unit), y: r4((ground - frontWheel.cy) * unit), r: r4(frontWheel.r * unit) },
    wheelbase: r4((frontWheel.cx - rearWheel.cx) * unit),
  },
  silhouettes: {
    right: pt(simplify(side.map(views.right), TOL)),
    top: pt(simplify(plan.map(views.top), TOL)),
    front: pt(simplify(front.map(views.front), TOL)),
    back: pt(simplify(back.map(views.back), TOL)),
  },
  features: Object.fromEntries(Object.entries(FEATURES).map(([name, f]) => [name, feature(name, f)])),
};
process.stdout.write(`${JSON.stringify(out)}\n`);
