// G1 calibration of the maid-whale turnaround.
//
//   node calibrate.mjs <turnaround.png> <reference.json> [--debug <overlay.png>]
//
// Reads the reference sheet (never stored in a repository), measures silhouettes,
// landmarks, part extents and colors, and writes only derived data. The optional
// debug overlay contains reference pixels and must stay local.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from './png.mjs';
import {
  classBounds,
  classMap,
  cleanMask,
  closeMask,
  medianColor,
  polygonArea,
  simplifyClosed,
  srgbToLinear,
  termMask,
  traceOutline,
  viewFrames,
} from './segment.mjs';
import { OUTLINES, VIEWS } from './windows.mjs';

/** Chosen scale: ground to ahoge tip in the front view is one meter. */
export const TOTAL_HEIGHT_M = 1.0;
const OUTLINE_TOLERANCE_PX = 0.75;
const round = (v, digits = 4) => Number(v.toFixed(digits));

function measure(image) {
  const { width, height } = image;
  const map = classMap(image);
  const mask = cleanMask(map.fg, width, height);
  map.fg = mask;
  const frames = viewFrames(mask, width, height);
  const views = {};
  for (const [name, view] of Object.entries(VIEWS)) {
    const parts = {};
    for (const [part, spec] of Object.entries(view.parts)) {
      const b = classBounds(map, width, spec.rect, spec.classes);
      if (b === null) throw new Error(`${name}/${part}: no pixels of ${spec.classes} in ${spec.rect}`);
      parts[part] = b;
    }
    const frame = frames.find(([a, b]) => a >= view.columns[0] && b <= view.columns[1]);
    if (frame === undefined) throw new Error(`${name}: no view frame inside ${view.columns}`);
    views[name] = { frame, parts };
  }
  return { map, mask, frames, views };
}

/**
 * Image x of the body axis: midpoint of the two leg columns in front, of the two
 * shoes in back (the tail hides the right leg there), the leg span in the side view.
 */
function axisOf(name, parts) {
  const mid = (b) => (b.x0 + b.x1 + 1) / 2;
  if (name === 'right') return mid(parts.legs);
  if (name === 'front') return (mid(parts['leg-r']) + mid(parts['leg-l'])) / 2;
  return (mid(parts['shoe-l']) + mid(parts['shoe-r'])) / 2;
}

function groundOf(name, parts) {
  const shoes = name === 'right' ? [parts.shoes] : [parts['shoe-l'], parts['shoe-r']];
  return Math.max(...shoes.map((s) => s.y1)) + 1;
}

export function calibrate(bytes) {
  const image = decodePng(bytes);
  const { map, mask, views } = measure(image);
  const front = views.front.parts;
  const groundFront = groundOf('front', front);
  const topFront = front.ahoge.y0;
  const pxPerMeter = (groundFront - topFront) / TOTAL_HEIGHT_M;
  const out = {
    schema: 'maid-whale-reference/1',
    source: {
      title: 'maid-whale turnaround sheet (FRONT / SIDE / BACK), outside every repository',
      sha256Prefix: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      width: image.width,
      height: image.height,
      note: 'derived data only; the image is never stored',
    },
    scale: {
      totalHeightM: TOTAL_HEIGHT_M,
      definition: 'front view, ground (lowest sole pixel) to ahoge tip',
      pxPerMeter: round(pxPerMeter, 3),
      meterPerPx: round(1 / pxPerMeter, 6),
    },
    views: {},
  };
  for (const [name, view] of Object.entries(views)) {
    const axis = axisOf(name, view.parts);
    const ground = groundOf(name, view.parts);
    const u = (x) => round((x - axis) / pxPerMeter);
    const v = (y) => round((ground - y) / pxPerMeter);
    const outline = traceOutline(mask, image.width, image.height, view.frame);
    const simplified = simplifyClosed(outline.points, OUTLINE_TOLERANCE_PX);
    // Screen y points down, so the traced polygon is clockwise in view meters; reverse it.
    const points = simplified.map(([x, y]) => [u(x), v(y)]).reverse();
    const parts = {};
    for (const [part, b] of Object.entries(view.parts)) {
      const bounds = [u(b.x0), v(b.y1 + 1), u(b.x1 + 1), v(b.y0)];
      parts[part] = {
        bounds,
        size: [round(bounds[2] - bounds[0]), round(bounds[3] - bounds[1])],
        center: [u(b.cx + 0.5), v(b.cy + 0.5)],
        pixels: b.count,
      };
    }
    const outlines = {};
    for (const [part, entry] of Object.entries(OUTLINES[name] ?? {})) {
      const { terms: termList, close = 0 } = Array.isArray(entry) ? { terms: entry } : entry;
      const raw = closeMask(termMask(map, image.width, image.height, termList), image.width, image.height, close);
      const partMask = cleanMask(raw, image.width, image.height, {
        minIsland: 20,
        maxHole: 400,
      });
      const traced = traceOutline(partMask, image.width, image.height, view.frame);
      const pts = simplifyClosed(traced.points, 1.0).map(([x, y]) => [u(x), v(y)]).reverse();
      outlines[part] = { areaM2: round(polygonArea(pts), 5), points: pts };
    }
    out.views[name] = {
      image: {
        columns: view.frame,
        axisX: axis,
        groundY: ground,
        topY: Math.min(...Object.values(view.parts).map((b) => b.y0)),
      },
      silhouette: {
        view: name,
        name: `${name}-silhouette`,
        kind: 'fit',
        tolerance: 0.002,
        areaM2: round(outline.area / pxPerMeter ** 2, 5),
        polygonAreaM2: round(polygonArea(points), 5),
        points,
      },
      parts,
      outlines,
    };
  }
  out.groundAgreementPx = Object.fromEntries(
    Object.entries(out.views).map(([n, w]) => [n, w.image.groundY - groundFront]),
  );
  out.landmarks = landmarks(out);
  out.proportions = proportions(out);
  out.palette = palette(image, map);
  out.camera = cameraEstimate(out);
  out.findings = findings(out);
  return { reference: out, image, map, mask, views };
}

function landmarks(ref) {
  const f = ref.views.front.parts;
  const s = ref.views.right.parts;
  const b = ref.views.back.parts;
  const H = ref.scale.totalHeightM;
  const eyeTop = Math.min(f['eye-r'].bounds[3], f['eye-l'].bounds[3]);
  const list = [
    ['ground', 'front', 0, 'lowest sole pixel'],
    ['sole-top', 'front', Math.min(f['shoe-r'].bounds[3], f['shoe-l'].bounds[3]), 'top of the shoes (strap line)'],
    ['sock-top', 'front', Math.max(f['sock-r'].bounds[3], f['sock-l'].bounds[3]), 'top of the white socks'],
    ['hem-at-legs', 'front', Math.max(f['leg-r'].bounds[3], f['leg-l'].bounds[3]), 'visible leg top: the hem underside behind its front edge (the knee is hidden)'],
    ['hem', 'front', f['skirt-hem'].bounds[1], 'lowest skirt hem pixel'],
    ['hem-band-top', 'front', f['skirt-hem'].bounds[3], 'top of the white hem band'],
    ['apron-bottom', 'front', f.apron.bounds[1], 'lowest apron ruffle pixel'],
    ['hand-bottom', 'front', Math.min(f['hand-r'].bounds[1], f['hand-l'].bounds[1]), 'lowest hand pixel'],
    ['wrist', 'front', Math.max(f['cuff-r'].bounds[1], f['cuff-l'].bounds[1]), 'cuff bottom'],
    ['waist', 'front', (f.waistband.bounds[1] + f.waistband.bounds[3]) / 2, 'waistband center'],
    ['shoulder', 'right', s.sleeve.bounds[3], 'top of the sleeve (side view)'],
    ['chin', 'front', f.face.bounds[1], 'lowest face skin pixel'],
    ['eye-line', 'front', (f['eye-r'].center[1] + f['eye-l'].center[1]) / 2, 'eye (lash line) centroid'],
    ['eye-top', 'front', eyeTop, 'top of the upper lashes'],
    ['crown', 'back', b['hair-total'].bounds[3], 'top of the hair cap (back view)'],
    ['headdress-top', 'front', f.headdress.bounds[3], 'top of the frill'],
    ['ahoge-tip', 'front', f.ahoge.bounds[3], 'highest pixel'],
    ['tail-tip-front', 'front', f.fluke.bounds[1], 'lowest fluke pixel, front view'],
    ['tail-tip-side', 'right', s.fluke.bounds[1], 'lowest fluke pixel, side view'],
    ['tail-tip-back', 'back', b.fluke.bounds[1], 'lowest fluke pixel, back view'],
  ];
  return list.map(([name, view, v, note]) => ({
    name,
    view,
    v: round(v),
    fraction: round(v / H),
    note,
  }));
}

function proportions(ref) {
  const lm = Object.fromEntries(ref.landmarks.map((l) => [l.name, l.v]));
  const f = ref.views.front.parts;
  const headHeight = lm.crown - lm.chin;
  return {
    headHeight: round(headHeight),
    headsTall: round(lm.crown / headHeight, 3),
    headWithHairFraction: round((lm['headdress-top'] - lm.chin) / ref.scale.totalHeightM, 4),
    faceWidth: f.face.size[0],
    shoulderWidthFront: round(f['cuff-l'].bounds[2] - f['cuff-r'].bounds[0]),
    hemWidthFront: f['skirt-hem'].size[0],
    legSpacingFront: round(f['leg-l'].center[0] - f['leg-r'].center[0]),
    eyeSpacingFront: round(f['eye-l'].center[0] - f['eye-r'].center[0]),
  };
}

/** Per-part colors measured on lit and shaded pixels together (median), sRGB and linear. */
function palette(image, map) {
  const entries = [
    ['hair-root', 'front', [170, 90, 300, 150], ['hair']],
    ['hair-tip', 'back', [920, 360, 1200, 440], ['light']],
    ['navy-cloth', 'front', [100, 470, 135, 500], ['navy', 'hair']],
    ['white-cloth', 'front', [150, 380, 280, 480], ['white']],
    ['skin', 'front', [170, 230, 300, 255], ['skin']],
    ['ribbon', 'front', [310, 130, 360, 190], ['light']],
    ['gem', 'front', [208, 278, 238, 304], ['gem']],
    ['gold', 'front', [130, 576, 330, 642], ['gold']],
    ['shoe', 'front', [140, 600, 220, 640], ['navy', 'dark']],
    ['tail', 'side', [700, 470, 860, 600], ['navy', 'hair']],
    ['tail-underside', 'side', [640, 540, 800, 600], ['white', 'other']],
  ];
  return entries.map(([name, view, rect, classes]) => {
    const c = medianColor(image, map, rect, classes);
    if (c === null) throw new Error(`palette ${name}: no pixels`);
    return {
      name,
      view,
      srgb: c.srgb,
      hex: `#${c.srgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`,
      linear: c.srgb.map((x) => round(srgbToLinear(x))),
      pixels: c.pixels,
    };
  });
}

/**
 * The sheet is not a strict orthographic projection. The fluke's lowest point is
 * one 3D point seen from the front (far side) and the back (near side): with a
 * camera pitched down by `a`, its image height differs by 2 z sin(a), where z is
 * its depth behind the leg axis, measured in the side view.
 */
function cameraEstimate(ref) {
  const f = ref.views.front.parts.fluke;
  const b = ref.views.back.parts.fluke;
  const s = ref.views.right.parts.fluke;
  const depth = s.bounds[2];
  const lift = (f.bounds[1] - b.bounds[1]) / 2;
  const pitch = (Math.asin(Math.min(1, lift / depth)) * 180) / Math.PI;
  return {
    basis: 'estimate',
    pitchDeg: round(pitch, 2),
    pitchNote: 'from the fluke tip: front/back height difference over its side-view depth',
    flukeHeight: round((f.bounds[1] + b.bounds[1]) / 2),
    flukeDepth: round(depth),
    consequence:
      'a point at depth z toward the camera draws z sin(pitch) lower: lowest-pixel grounds and front/back hems are depth-biased, so G7 measures renders and reference with the same code and cameras',
  };
}

function findings(ref) {
  const f = ref.views.front.parts;
  const b = ref.views.back.parts;
  const frontSide = Math.sign(f.fluke.center[0]);
  // Back view u = -x: a tail on the same body side has the opposite sign of u there.
  const backSide = -Math.sign(b.fluke.center[0]);
  const out = [];
  if (frontSide !== backSide) {
    out.push({
      id: 'R-1',
      title: 'Tail side differs between views',
      detail: `front and side views put the tail on body ${frontSide > 0 ? '+X' : '-X'}; the back view draws it on ${backSide > 0 ? '+X' : '-X'} (mirrored)`,
      decision: 'model the tail on the side two of three views agree on; back-view IoU is reported with and without the tail region',
    });
  }
  out.push({
    id: 'R-2',
    title: 'Sheet camera is pitched, not strictly orthographic',
    detail: `estimated pitch ${ref.camera.pitchDeg} deg (fluke tip front/back height disagreement)`,
    decision: 'G7 compares silhouettes with matched cameras at the measured pitch as well as level',
  });
  // The back bow over the hair tips (back view) against the hair's depth behind the waist (side view).
  const s = ref.views.right.parts;
  out.push({
    id: 'R-3',
    title: 'Back bow drawn over the back hair',
    detail: `the back view draws the back bow (${b['back-bow'].bounds[1]}-${b['back-bow'].bounds[3]}) over the hair tips (hair down to ${b['hair-total'].bounds[1]}); the side view puts the back hair ${s['hair-total'].bounds[2]} behind the body axis, about 15 cm behind the waist`,
    decision: 'the bow is visible from the back: it sits outside the back hair at the waist, the hair tips tuck under or part around it, and the side-view hair depth is kept',
  });
  return out;
}

function debugOverlay(result, path) {
  const { image, views } = result;
  const rgba = Uint8Array.from(image.rgba);
  const plot = (x, y, c) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    rgba.set([...c, 255], (y * image.width + x) * 4);
  };
  const colors = [
    [255, 0, 0],
    [0, 200, 0],
    [255, 140, 0],
    [200, 0, 200],
    [0, 160, 255],
  ];
  for (const view of Object.values(views)) {
    let k = 0;
    for (const b of Object.values(view.parts)) {
      const c = colors[k++ % colors.length];
      for (let x = b.x0; x <= b.x1; x++) {
        plot(x, b.y0, c);
        plot(x, b.y1, c);
      }
      for (let y = b.y0; y <= b.y1; y++) {
        plot(b.x0, y, c);
        plot(b.x1, y, c);
      }
    }
  }
  for (const [name, view] of Object.entries(result.reference.views)) {
    const { axisX, groundY } = view.image;
    for (let y = 0; y < image.height; y++) plot(Math.round(axisX), y, [0, 0, 0]);
    for (let x = view.image.columns[0]; x <= view.image.columns[1]; x++) plot(x, groundY, [0, 0, 0]);
    const s = result.reference.scale.pxPerMeter;
    const line = (points, c) => {
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * s) + 1;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          plot(Math.round(axisX + (a[0] + (b[0] - a[0]) * t) * s), Math.round(groundY - (a[1] + (b[1] - a[1]) * t) * s), c);
        }
      }
    };
    line(view.silhouette.points, [255, 255, 0]);
    let k = 0;
    for (const o of Object.values(view.outlines)) line(o.points, colors[k++ % colors.length]);
    void name;
  }
  writeFileSync(path, encodePng({ width: image.width, height: image.height, rgba }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [source, target, flag, debugPath] = process.argv.slice(2);
  if (source === undefined || target === undefined) {
    console.error('usage: node calibrate.mjs <turnaround.png> <reference.json> [--debug <overlay.png>]');
    process.exit(2);
  }
  const result = calibrate(readFileSync(source));
  // Number arrays (points, bounds, colors) stay on one line each.
  const json = JSON.stringify(result.reference, null, 1).replace(
    /\[\n\s*(-?[\d.e-]+(?:,\n\s*-?[\d.e-]+)*)\n\s*\]/g,
    (_, body) => `[${body.split(/,\n\s*/).join(', ')}]`,
  );
  writeFileSync(target, `${json}\n`);
  if (flag === '--debug' && debugPath !== undefined) debugOverlay(result, debugPath);
  const r = result.reference;
  console.log(JSON.stringify({ scale: r.scale, ground: r.groundAgreementPx, camera: r.camera, proportions: r.proportions }, null, 1));
  for (const l of r.landmarks) console.log(l.name.padEnd(16), l.view.padEnd(6), l.v.toFixed(4), l.fraction.toFixed(4));
}
