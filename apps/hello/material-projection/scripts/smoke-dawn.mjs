#!/usr/bin/env node
// Dawn-node smoke for projection and the non-PBR family. One orthographic
// frame holds every subject, so each gate reads fixed pixel rectangles:
// - triplanar boxes with zeroed UVs still show the checker (UV mapping would
//   paint one constant texel);
// - the world-projected pair differs because the texture stays in world
//   space, while the object-projected pair is identical because the texture
//   travels with the mesh;
// - an object-space +X normal map on a rotated, non-uniformly scaled sphere
//   shades the whole disc as one flat facet;
// - Lambert has no specular peak where Standard does;
// - Matcap reads its image by view normal, Normal visualizes the view normal.
// Every FALSIFY mode swaps one feature for its nearest non-feature and must fail.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { height, patch, patchDifference, runProjection, width } from './dawn-harness.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { BOX_OFFSET, BOX_X, BOTTOM_Y, OBJECT_NORMAL_X, PIXELS_PER_UNIT, SPHERE_X, TOP_Y, toPixel } = await import(
  pathToFileURL(resolve(appRoot, 'src', 'scene.ts')).href
);
const FALSIFIERS = ['uv', 'world', 'tangent', 'standard', 'unlit'];
const targetFrames = smokeFrameBudget();
const falsify = process.env.FALSIFY;
if (falsify !== undefined && !FALSIFIERS.includes(falsify)) {
  console.error(`[smoke] unknown FALSIFY=${falsify}; expected one of ${FALSIFIERS.join(', ')}`);
  process.exit(2);
}
const run = await runProjection({ appRoot, mode: falsify ?? 'projection', frames: targetFrames });
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', falsify ? `smoke-${falsify}.png` : 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, writeReferencePng(run.pixels, width, height));

/** Rectangle of half-size `half` pixels centred on world (x, y). */
const around = (x, y, half, dx = 0, dy = 0) => {
  const [px, py] = toPixel(x, y);
  const cx = Math.round(px + dx);
  const cy = Math.round(py + dy);
  return [cx - half, cx + half, cy - half, cy + half];
};
const fmt = (p) =>
  `luma=${p.luma.toFixed(4)} std=${p.std.toFixed(4)} rgb=[${p.r.toFixed(3)},${p.g.toFixed(3)},${p.b.toFixed(3)}]`;
const failures = [];
const expect = (ok, message) => { if (!ok) failures.push(message); };

// Triplanar boxes: the checker cell is half a world unit (20 px), so a 20 px
// window over the box centre spans at least one cell edge on some face.
const boxPatch = (x, dx = 0) => patch(run.pixels, around(x, TOP_Y, 10, dx));
const shift = BOX_OFFSET[0] * PIXELS_PER_UNIT;
const boxes = {
  worldA: boxPatch(BOX_X.worldA),
  worldB: boxPatch(BOX_X.worldA, shift),
  objectA: boxPatch(BOX_X.objectA),
  objectB: boxPatch(BOX_X.objectA, shift),
};
for (const [name, value] of Object.entries(boxes)) {
  console.log(`[smoke] box ${name} ${fmt(value)}`);
  expect(value.std > 0.06, `box ${name} shows no projected checker: ${fmt(value)}`);
}
const pairDiff = (x) => patchDifference(run.pixels, around(x, TOP_Y, 16), around(x, TOP_Y, 16, shift));
const worldDiff = pairDiff(BOX_X.worldA);
const objectDiff = pairDiff(BOX_X.objectA);
console.log(`[smoke] pair diff world=${worldDiff.toFixed(4)} object=${objectDiff.toFixed(4)}`);
expect(worldDiff > 0.08, `world-projected pair does not change with position: diff=${worldDiff.toFixed(4)}`);
expect(objectDiff < 0.02, `object-projected pair changes with position: diff=${objectDiff.toFixed(4)}`);

// Object-space +X normal: the disc must be one flat facet. The quadrant
// probes stay inside the scaled silhouette (half-extents 32 x 35 px).
const facets = [
  [-18, 0],
  [18, 0],
  [0, -20],
  [0, 20],
  [0, 0],
].map(([dx, dy]) => patch(run.pixels, around(OBJECT_NORMAL_X, TOP_Y, 4, dx, dy)));
const facetLumas = facets.map((value) => value.luma);
const facetSpread = Math.max(...facetLumas) - Math.min(...facetLumas);
console.log(`[smoke] object-normal lumas=[${facetLumas.map((value) => value.toFixed(4)).join(',')}] spread=${facetSpread.toFixed(4)}`);
expect(facetSpread < 0.03, `object-space normal map is not flat-shaded: spread=${facetSpread.toFixed(4)}`);
expect(facetLumas[4] > 0.15, `object-space normal sphere is unlit: ${fmt(facets[4])}`);

// Specular peak: the brightest pixel over the disc against its mean.
const disc = (x) => patch(run.pixels, around(x, BOTTOM_Y, 22));
const standard = disc(SPHERE_X.standard);
const lambert = disc(SPHERE_X.lambert);
console.log(`[smoke] standard ${fmt(standard)} max=${standard.max.toFixed(4)}`);
console.log(`[smoke] lambert ${fmt(lambert)} max=${lambert.max.toFixed(4)}`);
expect(lambert.luma > 0.08, `lambert sphere is unlit: ${fmt(lambert)}`);
expect(standard.max - lambert.max > 0.1, `lambert shows the Standard specular peak: max ${lambert.max.toFixed(4)} vs ${standard.max.toFixed(4)}`);

// Matcap and Normal: view-normal-indexed colours at the disc's cardinal points.
const side = (x, dx, dy) => patch(run.pixels, around(x, BOTTOM_Y, 3, dx, dy));
const matcap = { left: side(SPHERE_X.matcap, -22, 0), right: side(SPHERE_X.matcap, 22, 0), top: side(SPHERE_X.matcap, 0, -22), bottom: side(SPHERE_X.matcap, 0, 22), center: side(SPHERE_X.matcap, 0, 0) };
for (const [name, value] of Object.entries(matcap)) console.log(`[smoke] matcap ${name} ${fmt(value)}`);
expect(matcap.left.r > matcap.left.b + 0.1, `matcap left is not red-leaning: ${fmt(matcap.left)}`);
expect(matcap.right.b > matcap.right.r + 0.1, `matcap right is not blue-leaning: ${fmt(matcap.right)}`);
expect(matcap.top.g > matcap.bottom.g + 0.1, `matcap top is not greener than bottom: ${fmt(matcap.top)} vs ${fmt(matcap.bottom)}`);
// The image dims toward its rim on every channel; luma would weight the hue shift instead.
const level = (p) => (p.r + p.g + p.b) / 3;
expect(
  level(matcap.center) > Math.max(level(matcap.left), level(matcap.right)) + 0.05,
  `matcap centre is not brighter than the rim: ${fmt(matcap.center)} vs ${fmt(matcap.left)} / ${fmt(matcap.right)}`,
);

const normal = { left: side(SPHERE_X.normal, -22, 0), right: side(SPHERE_X.normal, 22, 0), top: side(SPHERE_X.normal, 0, -22), bottom: side(SPHERE_X.normal, 0, 22), center: side(SPHERE_X.normal, 0, 0) };
for (const [name, value] of Object.entries(normal)) console.log(`[smoke] normal ${name} ${fmt(value)}`);
expect(normal.right.r > normal.left.r + 0.2, `normal view-x does not increase to the right: ${fmt(normal.left)} vs ${fmt(normal.right)}`);
expect(normal.top.g > normal.bottom.g + 0.2, `normal view-y does not increase upward: ${fmt(normal.top)} vs ${fmt(normal.bottom)}`);
expect(normal.center.b > normal.center.r + 0.1 && normal.center.b > normal.center.g + 0.1, `normal centre does not face the camera: ${fmt(normal.center)}`);

if (run.backend !== 'webgpu') failures.push(`backend=${run.backend}`);
if (run.frames < targetFrames) failures.push(`frames=${run.frames} < ${targetFrames}`);
if (run.errors.length > 0) failures.push(`engine errors=${run.errors.map((error) => error.code).join(',')}`);
console.log(`[smoke] backend=${run.backend} frames=${run.frames} png=${pngOut}`);
run.dispose();
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
emitSmokeReceipt('hello-material-projection/smoke', run.frames);
console.log('[smoke] PASS - triplanar maps UV-less boxes in world and object space, the object-space normal map shades a flat facet, Lambert has no specular peak, and Matcap/Normal read the view normal');
process.exit(0);
