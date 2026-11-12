// G7 measurement, run after every stage: renders a maid-whale Pack with level
// orthographic cameras (front, right, back) on one fixed frame and scale through
// `forgeax model render`, segments the subject from the clear color and compares it
// with the calibrated reference silhouettes (reference.json), pixel by pixel.
//
//   node examples/maid-whale/measure.mjs <engine-worktree> <pack> [<out-dir>]
//
// The diff images hold silhouettes only (both / reference only / model only), never
// reference pixels.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePng, encodePng } from './calibrate/png.mjs';

export const VIEWS = ['front', 'right', 'back'];
/** Pixels per meter and image size of the measurement renders. */
export const SCALE = 500;
export const SIZE = [600, 600];
/** Fixed world frame [minX, minY, minZ, maxX, maxY, maxZ]: the same camera for every stage. */
export const FRAME = [-0.42, -0.02, -0.46, 0.42, 1.04, 0.38];

const center = [0, 1, 2].map((k) => (FRAME[k] + FRAME[k + 3]) / 2);
/** Sheet view -> camera yaw (degrees about +Y from the front, `model render` free cameras). */
export const SHEET_YAW = { front: 0, right: 90, back: 180 };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Screen axes of a `model render` free camera (DevKit viewFrame): right is level. */
export function cameraAxes(yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const toward = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
  const right = [Math.cos(y), 0, -Math.sin(y)];
  const up = [toward[1] * right[2] - toward[2] * right[1], toward[2] * right[0] - toward[0] * right[2], toward[0] * right[1] - toward[1] * right[0]];
  return { right, up };
}

/** Pixel center of image cell (px, py) in view meters for a camera (default: the level sheet view). */
export function pixelToView(view, px, py, camera = { yaw: SHEET_YAW[view], pitch: 0 }) {
  const { right, up } = cameraAxes(camera.yaw, camera.pitch);
  return [(px + 0.5 - SIZE[0] / 2) / SCALE + dot(center, right), (SIZE[1] / 2 - py - 0.5) / SCALE + dot(center, up)];
}

/** Even-odd raster of a closed polygon in view meters onto the measurement grid. */
export function rasterize(view, points, camera, offset = [0, 0]) {
  const [w, h] = SIZE;
  const mask = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    const v = pixelToView(view, 0, py, camera)[1] - offset[1];
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) xs.push(a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let px = 0; px < w; px++) {
      const u = pixelToView(view, px, py, camera)[0] - offset[0];
      let inside = false;
      for (const x of xs) if (x <= u) inside = !inside;
      mask[py * w + px] = inside ? 1 : 0;
    }
  }
  return mask;
}

/**
 * Subject mask of a rendered view. Every face renders in the magenta highlight slot
 * (`--selector sel.all()`), so a pixel belongs to the subject when it is clearly redder
 * than it is green; the gray clear color never is, at any shading.
 */
export function subjectMask(png) {
  const { width, height, rgba } = png;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) mask[i] = rgba[i * 4] - rgba[i * 4 + 1] > 24 ? 1 : 0;
  return mask;
}

export function iou(a, b, exclude) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (exclude?.[i] === 1) continue;
    if (a[i] === 1 && b[i] === 1) inter++;
    if (a[i] === 1 || b[i] === 1) union++;
  }
  return union === 0 ? 0 : inter / union;
}

/** Rectangle mask (view meters bounds) on the measurement grid. */
function boxMask(view, [u0, v0, u1, v1], camera, offset = [0, 0]) {
  const [w, h] = SIZE;
  const mask = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const p = pixelToView(view, px, py, camera);
      const u = p[0] - offset[0];
      const v = p[1] - offset[1];
      if (u >= u0 && u <= u1 && v >= v0 && v <= v1) mask[py * w + px] = 1;
    }
  }
  return mask;
}

/**
 * R-1 exclusion: the sheet's back tail outline and its mirror (u -> -u), where the model's tail
 * lands in the back view. Only the tail; the box version also drops the lower body below y 0.268.
 */
function tailOutlineMask(ref, camera, offset = [0, 0]) {
  const points = ref.views.back.outlines.tail.points;
  const a = rasterize('back', points, camera, offset);
  const b = rasterize('back', points.map(([u, v]) => [-u, v]), camera, offset);
  return a.map((x, i) => x | b[i]);
}

function diffImage(ref, model) {
  const [w, h] = SIZE;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = ref[i] && model[i] ? [150, 150, 150] : ref[i] ? [220, 40, 40] : model[i] ? [40, 90, 230] : [255, 255, 255];
    rgba.set([...c, 255], i * 4);
  }
  return encodePng({ width: w, height: h, rgba });
}

/**
 * Landmark and part-extent checks: [name, selector, view, quantity, reference]. The
 * quantity reads the selection's world bounds in view coordinates; `reference` is a
 * landmark name or `part:<view>/<part>/<w|h|top|bottom>`.
 */
export const CHECKS = [
  ['crown (hair top)', "sel.tag('hair')", 'front', 'top', 'crown'],
  ['chin (head bottom)', "sel.tag('head')", 'front', 'bottom', 'chin'],
  ['shoulder (sleeve top)', "sel.tag('arm-l')", 'front', 'top', 'shoulder'],
  ['wrist (cuff bottom)', "sel.tag('cuff-l')", 'front', 'bottom', 'wrist'],
  ['hand bottom', "sel.tag('hand-l')", 'front', 'bottom', 'hand-bottom'],
  ['hem (skirt bottom)', "sel.tag('skirt-hem').or(sel.tag('dress'))", 'front', 'bottom', 'hem'],
  ['sock top', "sel.tag('sock-l')", 'front', 'top', 'sock-top'],
  ['sole top (shoe top)', "sel.tag('shoe-l')", 'front', 'top', 'sole-top'],
  ['hair width (back)', "sel.tag('hair')", 'back', 'w', 'part:back/hair-total/w'],
  ['hair depth (side)', "sel.tag('hair')", 'right', 'w', 'part:right/hair-total/w'],
  ['hair height (side)', "sel.tag('hair')", 'right', 'h', 'part:right/hair-total/h'],
  ['hem width (front)', "sel.tag('skirt-hem').or(sel.tag('dress').and(sel.inBox([-1, 0, -1], [1, 0.27, 1], { by: 'centroid' })))", 'front', 'w', 'part:front/skirt-hem/w'],
  ['hem depth (side)', "sel.tag('skirt-hem').or(sel.tag('dress').and(sel.inBox([-1, 0, -1], [1, 0.27, 1], { by: 'centroid' })))", 'right', 'w', 'part:right/skirt-hem/w'],
  ['cuff width (front)', "sel.tag('cuff-l')", 'front', 'w', 'part:front/cuff-l/w'],
  ['hand width (front)', "sel.tag('hand-l')", 'front', 'w', 'part:front/hand-l/w'],
  ['shoe width (front)', "sel.tag('shoe-l')", 'front', 'w', 'part:front/shoe-l/w'],
  ['shoe length (side)', "sel.tag('shoe-l')", 'right', 'w', 'part:right/shoes/w'],
  ['tail reach (side)', "sel.tag('tail')", 'right', 'right', 'part:right/tail/right'],
  ['tail reach (front)', "sel.tag('tail')", 'front', 'right', 'part:front/tail/right'],
  ['face width (front)', "sel.tag('head')", 'front', 'w', 'part:front/face/w'],
];

/** Outer extent of an outline along a vertical (`col:u`) or horizontal (`row:v`) line. */
function lineExtent(points, axis, at) {
  const hits = [];
  const [k, o] = axis === 'col' ? [0, 1] : [1, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if ((a[k] <= at && b[k] > at) || (b[k] <= at && a[k] > at)) hits.push(a[o] + ((at - a[k]) * (b[o] - a[o])) / (b[k] - a[k]));
  }
  return hits.length < 2 ? 0 : Math.max(...hits) - Math.min(...hits);
}

function viewBox(view, b) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const u = view === 'front' ? [x0, x1] : view === 'back' ? [-x1, -x0] : [-z1, -z0];
  return { left: u[0], right: u[1], bottom: y0, top: y1, w: u[1] - u[0], h: y1 - y0 };
}

function referenceValue(ref, key) {
  if (key.startsWith('outline:')) {
    const [view, name, line] = key.slice(8).split('/');
    const [axis, at] = line.split(':');
    return lineExtent(ref.views[view].outlines[name].points, axis, Number(at));
  }
  if (!key.startsWith('part:')) return ref.landmarks.find((l) => l.name === key).v;
  const [view, name, q] = key.slice(5).split('/');
  const p = ref.views[view].parts[name];
  return { w: p.size[0], h: p.size[1], top: p.bounds[3], bottom: p.bounds[1], left: p.bounds[0], right: p.bounds[2] }[q];
}

export function compare(engineArg, source) {
  const engine = resolve(engineArg);
  const project = join(engine, 'packages/modeling');
  const ref = JSON.parse(readFileSync(join(project, 'examples/maid-whale/reference.json'), 'utf8'));
  const cli = join(engine, 'packages/engine/dist/bin/forgeax.mjs');
  const rows = [];
  for (const [name, selector, view, q, key] of CHECKS) {
    const run = spawnSync(process.execPath, [cli, 'model', 'select', '--source', source, '--selector', selector, '--timeout-ms', '600000', '--json'], { cwd: project, encoding: 'utf8', maxBuffer: 64 << 20 });
    const parsed = JSON.parse(run.stdout);
    if (!parsed.ok) {
      rows.push({ name, missing: parsed.error?.code ?? 'error' });
      continue;
    }
    const measured = viewBox(view, parsed.value.selected.bounds)[q];
    const target = referenceValue(ref, key);
    const kind = key.startsWith('part:') || key.startsWith('outline:') ? 'extent' : 'landmark';
    // Landmarks: error over total height (criterion 1 %); extents: relative error (criterion 2 %).
    const error = kind === 'landmark' ? Math.abs(measured - target) / ref.scale.totalHeightM : Math.abs(measured - target) / Math.abs(target);
    rows.push({ name, kind, measured: Number(measured.toFixed(4)), reference: Number(target.toFixed(4)), error: Number(error.toFixed(4)), pass: error <= (kind === 'landmark' ? 0.01 : 0.02) });
  }
  return rows;
}

function render(engine, project, source, views, extra = []) {
  const cli = join(engine, 'packages/engine/dist/bin/forgeax.mjs');
  const args = ['model', 'render', '--source', source, '--views', JSON.stringify(views), '--annotate', 'false', '--scale', String(SCALE), '--width', String(SIZE[0]), '--height', String(SIZE[1]), '--frame', JSON.stringify(FRAME), ...extra, '--timeout-ms', '600000', '--json'];
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', maxBuffer: 512 << 20 });
  const parsed = JSON.parse(run.stdout);
  if (!parsed.ok) throw new Error(`model render: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

/** Best IoU over reference translations within +-`reach` meters (the sheet has no absolute origin). */
function registered(view, points, camera, model, reach = 0.032, step = 0.008, exclude) {
  let best = { iou: -1, offset: [0, 0] };
  for (let du = -reach; du <= reach + 1e-9; du += step) {
    for (let dv = -reach; dv <= reach + 1e-9; dv += step) {
      const offset = [Number(du.toFixed(3)), Number(dv.toFixed(3))];
      const value = iou(rasterize(view, points, camera, offset), model, exclude?.(offset));
      if (value > best.iou) best = { iou: value, offset };
    }
  }
  return best;
}

/**
 * Matched-camera measurement: the sheet camera is pitched (R-2) and its front/back
 * are not exact mirror projections, so each view is rendered with free cameras at the
 * calibrated pitch and a yaw sweep around its axis; the reference silhouette is
 * registered by a translation of at most a few centimeters. Reports level, pitched and
 * best-yaw IoU per view so measurement bias and geometric error separate.
 */
export function measureMatched(engineArg, source, outArg, { pitch, yaws = [-12, -8, -4, 0, 4, 8, 12] } = {}) {
  const engine = resolve(engineArg);
  const project = join(engine, 'packages/modeling');
  const ref = JSON.parse(readFileSync(join(project, 'examples/maid-whale/reference.json'), 'utf8'));
  const p = pitch ?? ref.camera.pitchDeg;
  const cameras = [];
  for (const view of VIEWS) for (const dy of yaws) cameras.push({ name: `${view}_${dy}`, yaw: SHEET_YAW[view] + dy, pitch: p });
  const value = render(engine, project, source, cameras, ['--selector', 'sel.all()']);
  const out = outArg === undefined ? undefined : resolve(outArg);
  if (out !== undefined) mkdirSync(out, { recursive: true });
  const views = {};
  for (const view of VIEWS) {
    const rows = yaws.map((dy) => {
      const camera = { yaw: SHEET_YAW[view] + dy, pitch: p };
      const image = value.views.find((v) => v.view === `${view}_${dy}`).image;
      const model = subjectMask(decodePng(readFileSync(join(project, image))));
      const best = registered(view, ref.views[view].silhouette.points, camera, model);
      return { yaw: dy, ...best, camera, model };
    });
    const zero = rows.find((r) => r.yaw === 0) ?? rows[0];
    const best = rows.reduce((a, b) => (b.iou > a.iou ? b : a));
    const row = {
      pitched: Number(zero.iou.toFixed(4)),
      pitchedOffset: zero.offset,
      bestYaw: best.yaw,
      best: Number(best.iou.toFixed(4)),
      bestOffset: best.offset,
      sweep: rows.map((r) => [r.yaw, Number(r.iou.toFixed(4))]),
    };
    if (view === 'back') {
      const t = ref.views.back.parts.tail.bounds;
      const without = (offset) => {
        const a = boxMask(view, t, best.camera, offset);
        const b = boxMask(view, [-t[2], t[1], -t[0], t[3]], best.camera, offset);
        return a.map((x, i) => x | b[i]);
      };
      const reference = rasterize(view, ref.views.back.silhouette.points, best.camera, best.offset);
      row.bestWithoutTail = Number(iou(reference, best.model, tailOutlineMask(ref, best.camera, best.offset)).toFixed(4));
      // Both tail boxes: excludes the lower body below y 0.268 as well.
      row.bestWithoutTailBoxes = Number(iou(reference, best.model, without(best.offset)).toFixed(4));
    }
    if (out !== undefined) {
      row.diff = `diff-matched-${view}.png`;
      writeFileSync(join(out, row.diff), diffImage(rasterize(view, ref.views[view].silhouette.points, best.camera, best.offset), best.model));
    }
    views[view] = row;
  }
  return { schema: 'forgeax.maid-whale.measure-matched/1', source, pitch: p, scale: SCALE, frame: FRAME, views };
}

/**
 * Shape checks on the rendered level silhouettes: extents of the model
 * and reference masks along one image line or inside one band, so they see sections
 * and spans rather than selection bounding boxes.
 */
export const SHAPES = [
  ['tail section h at side u 0.22 (y < 0.33)', 'right', 'band', [0.219, 0.221, 0, 0.33]],
  ['tail section h at side u 0.26 (y < 0.33)', 'right', 'band', [0.259, 0.261, 0, 0.33]],
  ['fluke span (front, x 0.27-0.37, y < 0.35)', 'front', 'band', [0.27, 0.37, 0, 0.35]],
  ['hair depth at y 0.85 (side)', 'right', 'row', 0.85],
  ['hair width at y 0.50 (back)', 'back', 'row', 0.5],
];

function maskExtent(view, mask, kind, at) {
  const [w, h] = SIZE;
  let lo = Infinity;
  let hi = -Infinity;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (mask[py * w + px] !== 1) continue;
      const [u, v] = pixelToView(view, px, py);
      const hit = kind === 'col' ? Math.abs(u - at) <= 0.6 / SCALE : kind === 'row' ? Math.abs(v - at) <= 0.6 / SCALE : u >= at[0] && u <= at[1] && v >= at[2] && v <= at[3];
      if (!hit) continue;
      const q = kind === 'row' ? u : v;
      lo = Math.min(lo, q);
      hi = Math.max(hi, q);
    }
  }
  return hi > lo ? hi - lo : 0;
}

export function measure(engineArg, source, outArg) {
  const engine = resolve(engineArg);
  const project = join(engine, 'packages/modeling');
  const ref = JSON.parse(readFileSync(join(project, 'examples/maid-whale/reference.json'), 'utf8'));
  const cli = join(engine, 'packages/engine/dist/bin/forgeax.mjs');
  const args = ['model', 'render', '--source', source, '--views', JSON.stringify(VIEWS), '--annotate', 'false', '--scale', String(SCALE), '--width', String(SIZE[0]), '--height', String(SIZE[1]), '--frame', JSON.stringify(FRAME), '--selector', 'sel.all()', '--timeout-ms', '600000', '--json'];
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', maxBuffer: 256 << 20 });
  const parsed = JSON.parse(run.stdout);
  if (!parsed.ok) throw new Error(`model render: ${JSON.stringify(parsed.error)}`);
  const out = outArg === undefined ? undefined : resolve(outArg);
  if (out !== undefined) mkdirSync(out, { recursive: true });
  const views = {};
  let shapes;
  for (const view of VIEWS) {
    const image = parsed.value.views.find((v) => v.view === view).image;
    const model = subjectMask(decodePng(readFileSync(join(project, image))));
    const reference = rasterize(view, ref.views[view].silhouette.points);
    const row = { iou: Number(iou(reference, model).toFixed(4)) };
    for (const [name, v, kind, at] of SHAPES) {
      if (v !== view) continue;
      const measured = maskExtent(view, model, kind, at);
      const target = maskExtent(view, reference, kind, at);
      const error = Math.abs(measured - target) / target;
      (shapes ??= []).push({ name, kind: 'shape', measured: Number(measured.toFixed(4)), reference: Number(target.toFixed(4)), error: Number(error.toFixed(4)), pass: error <= 0.02 });
    }
    if (view === 'back') {
      // R-1: the sheet mirrors the tail in the back view; also report IoU without the tail (its
      // outline and mirror) and, as before, without both tail boxes (which also exclude the lower
      // body below y 0.268).
      row.iouWithoutTail = Number(iou(reference, model, tailOutlineMask(ref)).toFixed(4));
      const t = ref.views.back.parts.tail.bounds;
      const a = boxMask(view, t);
      const b = boxMask(view, [-t[2], t[1], -t[0], t[3]]);
      row.iouWithoutTailBoxes = Number(iou(reference, model, a.map((x, i) => x | b[i])).toFixed(4));
    }
    if (out !== undefined) {
      row.diff = `diff-${view}.png`;
      writeFileSync(join(out, row.diff), diffImage(reference, model));
    }
    views[view] = row;
  }
  return { schema: 'forgeax.maid-whale.measure/1', source, scale: SCALE, frame: FRAME, camera: 'level orthographic (model render)', views, shapes, mesh: parsed.value.mesh };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [engine, source, out, mode] = process.argv.slice(2);
  const result = measure(engine, source, out);
  // `--level`: the fixed level-ortho IoU only (fast iteration).
  if (mode !== '--level') {
    result.matched = measureMatched(engine, source, out);
    result.checks = compare(engine, source);
  }
  if (out !== undefined) writeFileSync(join(resolve(out), 'measure.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.views));
  for (const [v, r] of Object.entries(result.matched?.views ?? {})) console.log('matched', v, JSON.stringify({ pitched: r.pitched, bestYaw: r.bestYaw, best: r.best, offset: r.bestOffset, withoutTail: r.bestWithoutTail, withoutTailBoxes: r.bestWithoutTailBoxes, sweep: r.sweep }));
  for (const r of [...(result.shapes ?? []), ...(result.checks ?? [])]) console.log(r.name.padEnd(24), r.missing ?? `${r.measured} vs ${r.reference} err ${(r.error * 100).toFixed(1)}% ${r.pass ? 'ok' : 'FAIL'}`);
}
