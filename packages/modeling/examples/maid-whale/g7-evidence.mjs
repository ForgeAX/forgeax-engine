// Case C-200 stage G7 acceptance measure (criterion 6) from the
// matched renders: per-part mean colour CIEDE2000 against the sheet, the per-face colour and
// decal chart checks, and the face close-up landmark offsets (model minus sheet).
//
//   node examples/maid-whale/g7-evidence.mjs <turnaround.png> <render-dir> [<compare-dir>]
//
// <render-dir> holds the Dawn driver's output (renders.json, <frame>-<lighting>.png per
// g7-measure.ts MEASURE_LIGHTINGS, <frame>-id.png): orthographic cameras registered to the
// sheet's FRONT / SIDE / BACK pixel grids (pitch from reference.json `camera`), an unlit
// identity pass per slot, and level/pitched face close-ups. Criterion 6 has two lines:
// line 1 the albedo render (authored slot colours and decal
// texels, no shading), line 2 the frozen `sheet-soft` lighting; the harness default `studio`
// lighting is reported as info.
// The driver is a Dawn test kept outside the repository (it needs the snapshot and the case
// harness with an orthographic camera); see data/g7-colour.json `method`. Derived numbers go
// to data/g7-colour.json; images holding sheet pixels go only to <compare-dir> (default
// /tmp/f2face/out/g7-measure), never into a repository.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './calibrate/png.mjs';
import { FACE_MIDLINE_U } from './decals.ts';
import { COLOUR_PARTS, colourRow, compareStrip, decodeIds, faceFeatures, idPalette, MEASURE_LIGHTINGS, modelPartColour, SHEET_SOFT_SCALE, SHEET_SOFT_SHAPE, sheetCrop, sheetPartColour } from './g7-measure.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function crop(image, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(image.rgba.subarray(y * image.width * 4, (y * image.width + w) * 4), y * w * 4);
  return { width: w, height: h, rgba };
}

const mm = (v) => (v === undefined ? undefined : Number((v * 1000).toFixed(1)));
const diff = (a, b) => (a === undefined || b === undefined ? undefined : mm(a - b));

/** Landmark offsets model - sheet (mm) of one close-up. */
function offsets(sheetF, modelF, midline) {
  const rows = {};
  // Face-local u: the sheet's face midline sits at FACE_MIDLINE_U, the model's at 0.
  const su = (u) => (u === undefined ? undefined : u - midline);
  sheetF.eyes.forEach((s, i) => {
    const m = modelF.eyes[i];
    const tag = s.side > 0 ? 'eye-l' : s.side < 0 ? 'eye-r' : 'eye';
    rows[`${tag} centre u`] = diff(m.iris?.[0], su(s.iris?.[0]));
    rows[`${tag} centre v`] = diff(m.iris?.[1], s.iris?.[1]);
    rows[`${tag} lash top v`] = diff(m.lashTop, s.lashTop);
    rows[`${tag} lash width`] = diff(m.lashU && m.lashU[1] - m.lashU[0], s.lashU && s.lashU[1] - s.lashU[0]);
    rows[`${tag} brow v`] = diff(m.brow, s.brow);
    rows[`${tag} brow - lash top gap`] = diff(m.brow !== undefined && m.lashTop !== undefined ? m.brow - m.lashTop : undefined, s.brow !== undefined && s.lashTop !== undefined ? s.brow - s.lashTop : undefined);
  });
  rows['mouth v'] = diff(modelF.mouth, sheetF.mouth);
  rows['skin bottom v (midline)'] = diff(modelF.skinBottom, sheetF.skinBottom);
  rows['skin top v (bang line, |u| 0.03-0.06)'] = diff(modelF.skinTop, sheetF.skinTop);
  rows['skin width at eye centre'] = diff(modelF.skinWidth, sheetF.skinWidth);
  rows['skin front u at eye centre'] = diff(modelF.skinFront, sheetF.skinFront);
  const out = Object.fromEntries(Object.entries(rows).filter(([, v]) => v !== undefined));
  // Under half the sheet's visible face skin: the model's face is covered; landmarks would read hair.
  if (modelF.skinArea < 0.5 * sheetF.skinArea) return { faceCovered: Number((modelF.skinArea / sheetF.skinArea).toFixed(3)) };
  return out;
}

const round = (f) =>
  JSON.parse(JSON.stringify(f, (_, v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v)));

export function evidence(sheetPath, renderDir, compareDir = '/tmp/f2face/out/g7-measure') {
  const sheet = decodePng(readFileSync(sheetPath));
  const renders = JSON.parse(readFileSync(join(renderDir, 'renders.json'), 'utf8'));
  const load = (name) => decodePng(readFileSync(join(renderDir, `${name}.png`)));
  mkdirSync(compareDir, { recursive: true });
  const palette = idPalette(renders.idSlots);
  const idIndex = new Map(renders.idSlots.map((s, i) => [s, i]));
  const colours = [...palette.values()];
  const views = {};
  for (const view of ['front', 'right', 'back']) {
    const { frame } = renders.frames[view];
    const ids = decodeIds(load(`${view}-id`), colours);
    let subject = 0;
    for (let i = 0; i < ids.length; i++) if (ids[i] >= 0) subject++;
    const lit = Object.fromEntries(MEASURE_LIGHTINGS.map((l) => [l.name, load(`${view}-${l.name}`)]));
    views[view] = { frame, lit, ids, identityPixels: subject };
    writeFileSync(join(compareDir, `view-${view}.png`), encodePng(compareStrip(sheetCrop(sheet, frame), lit['sheet-soft'])));
  }
  const sheetMeans = COLOUR_PARTS.map((part) => sheetPartColour(sheet, part));
  const line = (lighting) => {
    const rows = COLOUR_PARTS.map((part, i) => {
      const v = views[part.view];
      return round(colourRow(part, sheetMeans[i], modelPartColour(v.lit[lighting.name], v.ids, idIndex, v.frame, part)));
    });
    const fail = rows.filter((r) => !r.pass).map((r) => r.part);
    return { lighting, pass: fail.length === 0, fail, rows };
  };
  const [albedo, sheetSoft, studio, sheetSoftWorld] = MEASURE_LIGHTINGS.map(line);
  const face = {};
  for (const [name, out, eyes] of [
    ['face-front', 'face-compare', [[1, 0.02, 0.115], [-1, -0.115, -0.02]]],
    ['face-side', 'side-compare', [[0, -0.15, -0.03]]],
    ['face-front-pitched', 'face-compare-pitched', [[1, 0.02, 0.115], [-1, -0.115, -0.02]]],
    ['face-side-pitched', 'side-compare-pitched', [[0, -0.15, -0.03]]],
  ]) {
    const { frame } = renders.frames[name];
    const render = load(`${name}-sheet-soft`);
    const sheetView = sheetCrop(sheet, frame);
    const k = 609 * frame.k;
    const [w, h] = [Math.round((name.includes('side') ? 0.22 : 0.3) * k), Math.round(0.22 * k)];
    writeFileSync(join(compareDir, `${out}.png`), encodePng(compareStrip(crop(sheetView, w, h), crop(render, w, h))));
    const midline = name.includes('side') ? 0 : FACE_MIDLINE_U;
    const s = faceFeatures(sheetView, frame, eyes.map(([side, u0, u1]) => [side, u0 + midline, u1 + midline]));
    const m = faceFeatures(render, frame, eyes);
    face[name] = { pitchDeg: frame.pitchDeg, image: `${out}.png`, offsetsMm: offsets(s, m, midline), sheet: round(s), model: round(m) };
  }
  const checks = renders.checks;
  return {
    schema: 'forgeax.maid-whale.g7-colour/1',
    source: renders.source,
    criterion: 'per-part mean colour CIEDE2000 <= 5 against the sheet on matched cameras, two lines: (1) albedo render, (2) sheet-soft lighting; one colour per face; decal charts seamless and decal footprints on their slot faces',
    method: {
      cameras: `orthographic, registered to the sheet pixel grid (2 render px per sheet px; ${renders.pitchDeg} deg pitch from reference.json camera, model ground = its lowest point along the camera up, like the sheet's lowest sole pixel)`,
      lightings: 'g7-measure.ts MEASURE_LIGHTINGS: albedo (Skylight ambientIrradiance pi only: each pixel shows its base colour or decal texel), sheet-soft (frozen preset below, key fixed in each panel camera frame: g7-measure.ts panelLighting), studio (case harness default: studioEnvironment IBL + warm key + cool fill, info only), sheet-soft-world (the same preset with the key fixed in the world for every panel, the rule before 2026-10-26, info only); Camera tonemap none, exposure 1',
      sheetSoft: { shape: SHEET_SOFT_SHAPE, scale: SHEET_SOFT_SCALE, calibration: 'one scalar, once, on the white apron only: lit mean L* of the white cloth (apron) row = the sheet mean (93.40); then frozen, no per-part tuning' },
      sheet: 'mean L*a*b* of window pixels of the part colour classes (calibrate/segment.mjs), 4-neighbour eroded',
      model: 'mean L*a*b* of rendered pixels whose unlit identity-pass slot (8-neighbour eroded) is the part, within the window grown by 16 sheet px; decal slots (face, apron front) keep only pixels of the same classes',
      driver: 'Dawn test .isolation-g7m/g7m.dawn.test.ts (ignored scratch dir): snapshot + hairOmbre + tailSlots + skinSlots + applyFaceDecal + applyEmblem, slot materials as the Pack job Materials.standard (linear baseColor, slotPbr metallic/roughness), case harness copy with an orthographic Camera and switchable lights',
    },
    colour: { pass: albedo.pass && sheetSoft.pass, albedo, sheetSoft, studio, sheetSoftWorld },
    faceColour: checks.faceColour.pass,
    faceColourDetail: { ...checks.faceColour, mixedSlotFaces: checks.faceColour.mixedSlotFaces.length, colourVaryingFaces: checks.faceColour.colourVaryingFaces.length },
    charts: checks.charts.map((c) => ({ ...c, layers: c.layers.filter((l) => l.uncovered > 0 || l.samples === 0), layerCount: c.layers.length })),
    face,
    views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { identityPixels: v.identityPixels }])),
    timings: renders.timings,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sheet, renderDir, compareDir] = process.argv.slice(2);
  if (sheet === undefined || renderDir === undefined) {
    console.error('usage: node g7-evidence.mjs <turnaround.png> <render-dir> [<compare-dir>]');
    process.exit(2);
  }
  const t0 = Date.now();
  const result = evidence(resolve(sheet), resolve(renderDir), compareDir && resolve(compareDir));
  result.timings = { ...result.timings, analysisMs: Date.now() - t0 };
  mkdirSync(join(HERE, 'data'), { recursive: true });
  writeFileSync(join(HERE, 'data/g7-colour.json'), `${JSON.stringify(result, null, 1)}\n`);
  for (const key of ['albedo', 'sheetSoft', 'studio', 'sheetSoftWorld']) {
    const l = result.colour[key];
    console.log(`-- ${l.lighting.name}${key === 'studio' || key === 'sheetSoftWorld' ? ' (info)' : ''}: ${l.pass ? 'pass' : `FAIL ${l.fail.join(', ')}`}`);
    for (const r of l.rows) console.log(`${r.part.padEnd(22)} ${r.view.padEnd(6)} dE00 ${String(r.dE ?? '-').padStart(6)} (hue/chroma only ${r.dEChroma}, palette vs sheet ${r.dEPalette}) n ${r.sheet?.n ?? 0}/${r.model?.n ?? 0} kept ${r.model?.kept?.toFixed?.(2) ?? '-'} ${r.pass ? 'ok' : 'FAIL'}`);
  }
  console.log('faceColour', result.faceColour, 'charts', result.charts.map((c) => `${c.slot}:${c.pass}`).join(' '));
  for (const [k, v] of Object.entries(result.face)) console.log(k, JSON.stringify(v.offsetsMm));
}
