#!/usr/bin/env node
// bevy-shadow-caster-receiver Dawn smoke. Renders the shared scene through
// five Bevy key states and falsifies each one from pixels:
//   baseline      red casts onto the ground; blue (NotShadowCaster) does not
//   C             casters invert: red stays visible but stops casting; blue casts
//   C, R          casters restored, receivers invert: the ground stops receiving
//                 red's shadow while the lime plane starts receiving it
//   R, L          point light: red's point shadow lands on the ground; blue has none
//   R             point light with receivers inverted: the ground drops it again
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
const PHASES = 5;
const FRAMES_PER_PHASE = Math.max(12, Math.ceil(smokeFrameBudget() / PHASES));
const SHADOWED = 0.6;
const LIT = 0.85;

const dawn = await openDawnCanvas(WIDTH, HEIGHT);
const { World } = await import('@forgeax/engine-ecs');
const { createRenderer } = await import('@forgeax/engine-runtime');
const { propagateTransforms } = await import('@forgeax/engine-scene');
const { CAMERA_POSITION, CAMERA_TARGET, spawnCasterReceiverScene, toggleLight, toggleParticipation } =
  await import('../src/scene.mjs');

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
console.log(`[shadow-caster-receiver] backend=${rendererBackend(renderer)}`);
const errors = [];
subscribeSmokeErrors(renderer, (error) => errors.push(error.code));

const world = new World();
const scene = spawnCasterReceiverScene(world, WIDTH / HEIGHT);
const project = createProjector({ position: CAMERA_POSITION, target: CAMERA_TARGET, fov: Math.PI / 4, width: WIDTH, height: HEIGHT });

// Directional light travels along (-1, -1, 0)/sqrt2 and the point light sits
// at (5, 5, 0): the sphere centres at y = 2 project to these receiver points.
// Ground samples sit just inside z > 0, where the lime plane (z <= 0) never
// hides the ground. Each shadow sample carries an unshadowed reference on the
// same receiver; the point reference moves along +x because +z leaves the frame.
// Sphere samples sit on the surface facing both the camera and the lights, so
// they are lit in every phase and falsify base color, not shadowing.
const LIT_SIDE = [0.026, 0.211, 0.132];
const spheres = {
  redSphere: [-1 + LIT_SIDE[0], 2 + LIT_SIDE[1], LIT_SIDE[2]],
  blueSphere: [1 + LIT_SIDE[0], 2 + LIT_SIDE[1], LIT_SIDE[2]],
};
const receiverSamples = {
  groundRedDirectional: [[-3, 0, 0.08], [-3, 0, 1.18]],
  groundBlueDirectional: [[-1, 0, 0.08], [-1, 0, 1.18]],
  limeRedDirectional: [[-2, 1, -0.12], [-2, 1, -1.22]],
  groundRedPoint: [[-5, 0, 0.1], [-3.9, 0, 0.1]],
  groundBluePoint: [[-5 / 3, 0, 0.1], [-5 / 3, 0, 1.2]],
};

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
  const visibility = ([point, reference]) =>
    luminance(frame.sample(project(point))) / Math.max(luminance(frame.sample(project(reference))), 1e-4);
  const values = {
    ...Object.fromEntries(Object.entries(spheres).map(([key, point]) => [key, frame.sample(project(point), 0)])),
    ...Object.fromEntries(Object.entries(receiverSamples).map(([key, pair]) => [key, visibility(pair)])),
  };
  console.log(`[smoke] ${name} ${JSON.stringify(values, (_, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v))}`);
  return values;
}

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
const isShadowed = (value) => value < SHADOWED;
const isLit = (value) => value > LIT;
const spheresVisible = (phase, values) => {
  const [rr, rg, rb] = values.redSphere;
  const [br, bg, bb] = values.blueSphere;
  expect(rr > rg + 0.15 && rr > rb + 0.15, `${phase}: red sphere not visible ${values.redSphere}`);
  expect(bb > br + 0.15 && bb > bg + 0.15, `${phase}: blue sphere not visible ${values.blueSphere}`);
};

const baseline = await renderPhase('baseline');
spheresVisible('baseline', baseline);
expect(isShadowed(baseline.groundRedDirectional), `baseline: red casts no directional shadow (${baseline.groundRedDirectional})`);
expect(isLit(baseline.groundBlueDirectional), `baseline: NotShadowCaster blue still casts (${baseline.groundBlueDirectional})`);
expect(isLit(baseline.limeRedDirectional), `baseline: NotShadowReceiver lime receives (${baseline.limeRedDirectional})`);

toggleParticipation(world, scene, 'cast');
const casters = await renderPhase('casters-toggled');
spheresVisible('casters-toggled', casters);
expect(isLit(casters.groundRedDirectional), `C: red kept casting after cast=false (${casters.groundRedDirectional})`);
expect(isShadowed(casters.groundBlueDirectional), `C: blue did not start casting (${casters.groundBlueDirectional})`);

toggleParticipation(world, scene, 'cast');
toggleParticipation(world, scene, 'receive');
const receivers = await renderPhase('receivers-toggled');
spheresVisible('receivers-toggled', receivers);
expect(isLit(receivers.groundRedDirectional), `R: ground kept receiving after receive=false (${receivers.groundRedDirectional})`);
expect(isShadowed(receivers.limeRedDirectional), `R: lime did not start receiving (${receivers.limeRedDirectional})`);
expect(
  Math.abs(luminance(receivers.redSphere) - luminance(baseline.redSphere)) < 0.05,
  `R: red sphere shading changed while only receivers toggled (${baseline.redSphere} -> ${receivers.redSphere})`,
);

toggleParticipation(world, scene, 'receive');
expect(toggleLight(world, scene) === 'PointLight', 'L did not switch to the point light');
const point = await renderPhase('point-light');
spheresVisible('point-light', point);
expect(isShadowed(point.groundRedPoint), `L: red casts no point shadow (${point.groundRedPoint})`);
expect(isLit(point.groundBluePoint), `L: NotShadowCaster blue casts a point shadow (${point.groundBluePoint})`);

toggleParticipation(world, scene, 'receive');
const pointReceivers = await renderPhase('point-receivers-toggled');
expect(isLit(pointReceivers.groundRedPoint), `L+R: ground kept receiving the point shadow (${pointReceivers.groundRedPoint})`);

if (rendererBackend(renderer) !== 'webgpu') failures.push(`backend=${rendererBackend(renderer)}`);
if (errors.length > 0) failures.push(`renderer errors: ${errors.join(', ')}`);
console.log(`[smoke] frames observed=${framesObserved}`);
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.length} criteria failed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('[smoke] PASS - ShadowParticipation cast/receive toggles falsified on directional and point shadows');
emitSmokeReceipt('bevy-shadow-caster-receiver/smoke', framesObserved);
await renderer.dispose();
dawn.device?.destroy?.();
process.exit(0);
