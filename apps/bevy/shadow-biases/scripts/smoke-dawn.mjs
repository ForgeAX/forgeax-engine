#!/usr/bin/env node
// bevy-shadow-biases Dawn smoke. Renders the shared scene through the Bevy
// key states and falsifies each live control from pixels:
//   baseline          directional light casts sphere shadows onto the ground
//   directional bias  a large depth bias, then a large normal bias, each lifts
//                     the shadow; R restores it (the light keeps castShadow)
//   F                 the filter profile changes the shadow edge
//   L                 point light: the sphere's point shadow lands on the ground
//   point bias        a large depth bias (world meters), then a large normal
//                     bias (texels), each lifts the point shadow; R restores it
//   move light        the point shadow follows the moved light
// Evidence is self-verification against geometric shadow positions derived
// from the authored light and sphere positions.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { createProjector, luminance, openDawnCanvas } from '../../scripts/dawn-readback.mjs';
import { createSmokeRenderer, drawSmokeFrame, rendererBackend, subscribeSmokeErrors } from '../../scripts/renderer-smoke.mjs';

const WIDTH = 200;
const HEIGHT = 150;
const PHASES = 10;
const FRAMES_PER_PHASE = Math.max(8, Math.ceil(smokeFrameBudget() / PHASES));
const SHADOWED = 0.6;
const LIT = 0.85;

const dawn = await openDawnCanvas(WIDTH, HEIGHT);
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const {
  BIAS_DEFAULTS, CAMERA_POSITION, CAMERA_TARGET, FILTERS, cycleFilter, moveLight, setBiases, spawnBiasesScene,
  toggleLight,
} = await import('../src/scene.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const manifest = readFileSync(resolve(here, '..', 'dist', 'shaders', 'manifest.json'), 'utf8');
let renderer;
try {
  renderer = await createSmokeRenderer(createRenderer, dawn.canvas, {}, {
    shaderManifestUrl: `data:application/json,${encodeURIComponent(manifest)}`,
  });
} finally {
  dawn.release();
}
console.log(`[shadow-biases] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));

const world = new World();
const scene = spawnBiasesScene(world, WIDTH / HEIGHT);
const project = createProjector({ position: CAMERA_POSITION, target: CAMERA_TARGET, fov: Math.PI / 4, width: WIDTH, height: HEIGHT });

// Lights sit at (5, 5, 0) aimed at the origin. The sphere at (0, 2, -4)
// shadows the ground at (-2, 0, -4) along the directional light and at
// (-10/3, 0, -20/3) along the point light; moving the light to (5, 5, -2)
// moves that point shadow to (-10/3, 0, -16/3). Each sample carries a
// reference on the same ground that no sphere shadows in any phase.
const receiverSamples = {
  directional: [[-2, 0, -4], [-2, 0, -2.8]],
  point: [[-10 / 3, 0, -20 / 3], [-10 / 3, 0, -8]],
  pointMoved: [[-10 / 3, 0, -16 / 3], [-10 / 3, 0, -4.1]],
};
// A row across the directional shadow's lit/shadowed boundary.
const EDGE = Array.from({ length: 13 }, (_, i) => [-2.6 + i * 0.1, 0, -4]);

let framesObserved = 0;
async function renderPhase(name) {
  for (let i = 0; i < FRAMES_PER_PHASE; i++) {
    world.update().unwrap();
    propagateTransforms(world).unwrap();
    const drawn = drawSmokeFrame(renderer, world);
    if (!drawn.ok) errors.push(drawn.error.code);
    framesObserved++;
  }
  await dawn.device.queue.onSubmittedWorkDone();
  const frame = await dawn.readback();
  frame.capture(name);
  const lum = (point) => luminance(frame.sample(project(point), 0));
  const values = Object.fromEntries(Object.entries(receiverSamples).map(([key, [point, reference]]) => [
    key, luminance(frame.sample(project(point))) / Math.max(luminance(frame.sample(project(reference))), 1e-4),
  ]));
  values.edge = EDGE.map(lum);
  console.log(`[smoke] ${name} ${JSON.stringify(values, (_, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v))}`);
  return values;
}

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
const isShadowed = (value) => value < SHADOWED;
const isLit = (value) => value > LIT;
const withBiases = (light, values) => ({ ...BIAS_DEFAULTS, [light]: { ...BIAS_DEFAULTS[light], ...values } });

const baseline = await renderPhase('directional-baseline');
expect(isShadowed(baseline.directional), `baseline: no directional shadow (${baseline.directional})`);

setBiases(world, scene, withBiases('directional', { depthBias: 0.2 }));
const dirDepth = await renderPhase('directional-depth-bias');
expect(isLit(dirDepth.directional), `directional depthBias did not reach the receiver (${dirDepth.directional})`);

setBiases(world, scene, withBiases('directional', { normalBias: 3 }));
const dirNormal = await renderPhase('directional-normal-bias');
expect(isLit(dirNormal.directional), `directional normalBias did not reach the receiver (${dirNormal.directional})`);

setBiases(world, scene, BIAS_DEFAULTS);
const dirReset = await renderPhase('directional-reset');
expect(isShadowed(dirReset.directional), `R did not restore the directional shadow (${dirReset.directional})`);

expect(cycleFilter(world, scene) === 'pcf3', 'F did not advance pcf1 -> pcf3');
expect(cycleFilter(world, scene) === 'pcf5', 'F did not advance pcf3 -> pcf5');
const soft = await renderPhase('directional-filter-pcf5');
const edgeDelta = Math.max(...soft.edge.map((value, i) => Math.abs(value - dirReset.edge[i])));
expect(edgeDelta > 0.02, `F: pcf5 left the shadow edge unchanged (max delta ${edgeDelta.toFixed(3)})`);
expect(isShadowed(soft.directional), `F: pcf5 lost the shadow core (${soft.directional})`);
for (let i = 2; i < FILTERS.length; i++) cycleFilter(world, scene);

toggleLight(world, scene);
const point = await renderPhase('point-baseline');
expect(isShadowed(point.point), `L: no point shadow (${point.point})`);

setBiases(world, scene, withBiases('point', { depthBias: 5 }));
const pointDepth = await renderPhase('point-depth-bias');
expect(isLit(pointDepth.point), `point depthBias did not reach the receiver (${pointDepth.point})`);

setBiases(world, scene, withBiases('point', { normalBias: 100 }));
const pointNormal = await renderPhase('point-normal-bias');
expect(isLit(pointNormal.point), `point normalBias did not reach the receiver (${pointNormal.point})`);

setBiases(world, scene, BIAS_DEFAULTS);
const pointReset = await renderPhase('point-reset');
expect(isShadowed(pointReset.point), `R did not restore the point shadow (${pointReset.point})`);
expect(isLit(pointReset.pointMoved), `point shadow already at the moved position (${pointReset.pointMoved})`);

moveLight(world, scene, [0, 0, -2]);
const moved = await renderPhase('point-moved');
expect(isShadowed(moved.pointMoved), `moved light: shadow did not follow (${moved.pointMoved})`);
expect(isLit(moved.point), `moved light: shadow stayed at the old position (${moved.point})`);

if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (errors.length > 0) failures.push(`renderer errors: ${errors.join(', ')}`);
console.log(`[smoke] frames observed=${framesObserved}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('[smoke] PASS - live directional and point biases, filter profile and light movement falsified');
emitSmokeReceipt('bevy-shadow-biases/smoke', framesObserved);
await renderer.dispose();
dawn.device?.destroy?.();
process.exit(0);
