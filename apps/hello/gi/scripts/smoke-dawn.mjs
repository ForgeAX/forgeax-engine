// hello-gi Dawn smoke: the ordinary Renderer's exact diffuse GI lane on the
// Cornell scene, with pixel-readback falsifiers against GI off and against the
// bounded reference path tracer.
//
//   AC-1  60 completed GI frames, lane ready, no device/renderer errors.
//   AC-2  GI brightens the regions raster leaves unlit (direct-derived mask).
//   AC-3  Reference direct matches raster direct (shared light units), and GI
//         indirect agrees with the reference indirect (ratio in [0.6, 1.6]).
//   AC-4  Emission alone produces positive indirect light.
//   F-1   Light off + emission off + black sky: GI equals direct (zero indirect).
//   AC-5  Thin-wall leak scene, screen-probe lane: the lit room keeps the
//         reference's multi-bounce indirect energy and the dark room stays dark,
//         both edge-on and with the separator in view.
//   AC-6  A camera cut into the leak scene's dark room starts within 10% of its
//         converged mean and is within 10% at frame 8.
//   AC-7  Irradiance-field lane on the thin-wall leak scene: indirect within 10% of
//         the multi-bounce diffuse-receiver reference, and the dark room (lit only
//         through the door) within [0.5, 1.0]x its reference indirect.
//   AC-8  Baked lane on the thin-wall leak scene: the volume is cooked by the same
//         reference integrator and published through the irradiance-volume
//         NativeCooker, loaded from the served Catalog by GUID, and its indirect is
//         within 10% of the reference with the dark room in [0.4, 1.3]x (the smoke's
//         32-ray x 16-path bake undersamples the door; 128 x 256 reads 1.02x).
//   F-2   Falsifier: a second cook of the same input reproduces the digest,
//         fingerprint and bytes, and gathering another scene's volume (cornell GUID)
//         over the leak scene changes the image, so the lane reads the GUID it names.

import { World } from '@forgeax/engine-ecs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
import * as gi from './gi-dawn.mjs';

const jsonMode = process.argv.includes('--json');
const FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const SIZE = 64;
const REFERENCE_SAMPLES = 128;

const log = (line) => {
  if (!jsonMode) console.log(`[smoke] ${line}`);
};
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
};

await gi.installDawn();
const { BAKED_VOLUMES, PROCEDURAL_SCENES, diffuseGiFor } = await import('../src/scenes.ts');
const { createGiBoxMesh, spawnProceduralScene } = await import('../src/build-scene.ts');
const boxMesh = await createGiBoxMesh();
const { indirectMetrics, luminance, regionMask, unlitMask } = await import('./gi-metrics.mjs');
const scene = PROCEDURAL_SCENES.cornell;
const cooked = await gi.cookGiMaterials();
const { renderer, assets, errors } = await gi.createGiRenderer({ width: SIZE, height: SIZE });
const world = new World();
const controls = spawnProceduralScene(world, scene, gi.publishMaterials(world, assets, cooked), 1, boxMesh);
const lease = renderer.attach(world);
if (!lease.ok) throw new Error(`attach failed: ${JSON.stringify(lease.error)}`);
const driver = await gi.createFrameDriver({ renderer, world, lease: lease.value });
const direct = gi.directProfile(renderer.inspect().profile);
let framesObserved = 0;

async function mean(frames) {
  const sum = new Float32Array(SIZE * SIZE * 3);
  for (let k = 0; k < frames; k++) {
    const { observed } = await driver.observe(['linear-hdr']);
    framesObserved += 1;
    const rgb = gi.hdrToRgb(
      observed.observations.find((o) => o.domain === 'linear-hdr'),
      SIZE,
      SIZE,
    );
    for (let i = 0; i < sum.length; i++) sum[i] += rgb[i] / frames;
  }
  return sum;
}

async function render({ mode, light, emissive, frames }) {
  controls.setLight(light);
  controls.setEmissive(emissive);
  const diffuseGi = diffuseGiFor(mode, scene);
  renderer.setProfile(diffuseGi === undefined ? direct : { ...direct, diffuseGi }).unwrap();
  await driver.settle();
  return mean(frames);
}

const webgpu = await import('@forgeax/engine-rhi-webgpu');
const { buildRaySurfaceScene } = await import('@forgeax/engine-render/internal');
const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
async function reference(light, emissive) {
  const ray = await gi.proceduralRayScene(scene, cooked, emissive);
  const common = {
    device,
    compile: webgpu.createShaderModule,
    scene: buildRaySurfaceScene(ray.instances).unwrap(),
    materials: ray.materials,
    lights: [gi.lightSnapshot(scene.light, light)],
    camera: scene.camera,
    width: SIZE,
    height: SIZE,
    maxDistance: scene.maxDistance,
  };
  const first = await gi.tracePath({
    ...common,
    maxBounces: 1,
    environment: [0, 0, 0],
    samples: 16,
  });
  const full = await gi.tracePath({
    ...common,
    maxBounces: 2,
    environment: scene.environment,
    samples: REFERENCE_SAMPLES,
  });
  return { direct: first, indirect: full.map((v, i) => v - first[i]) };
}

const off = await render({ mode: 'off', light: true, emissive: false, frames: 2 });
const on = await render({ mode: 'exact', light: true, emissive: false, frames: FRAMES });
const state = renderer.inspect().diffuseGi;
check(
  state?.state === 'ready' && framesObserved >= FRAMES,
  `AC-1 ${framesObserved} frames, lane ${state?.state}`,
);

const mask = unlitMask(off, SIZE, SIZE);
const giIndirect = on.map((v, i) => v - off[i]);
const masked = (rgb) => {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p++)
    if (mask[p]) {
      sum += luminance(rgb, p);
      count += 1;
    }
  return count === 0 ? 0 : sum / count;
};
const unlitOff = masked(off);
const unlitOn = masked(on);
check(
  mask.reduce((a, b) => a + b, 0) >= 32 && unlitOn > 2 * unlitOff + 0.002,
  `AC-2 unlit mask ${mask.reduce((a, b) => a + b, 0)} px: off ${unlitOff.toFixed(4)} -> exact ${unlitOn.toFixed(4)}`,
);

const traced = await reference(true, false);
const directMetrics = indirectMetrics(traced.direct, off);
check(
  directMetrics.ratio >= 0.9 && directMetrics.ratio <= 1.1,
  `AC-3 reference direct ${directMetrics.mean.toFixed(4)} vs raster direct ${directMetrics.referenceMean.toFixed(4)} (ratio ${directMetrics.ratio.toFixed(3)})`,
);
const metrics = indirectMetrics(giIndirect, traced.indirect);
check(
  metrics.ratio >= 0.6 && metrics.ratio <= 1.6,
  `AC-3 indirect mean exact ${metrics.mean.toFixed(4)} vs reference ${metrics.referenceMean.toFixed(4)} (ratio ${metrics.ratio.toFixed(3)})`,
);

const emissiveDirect = await render({ mode: 'off', light: false, emissive: true, frames: 1 });
const emissiveGi = await render({ mode: 'exact', light: false, emissive: true, frames: 16 });
const emissiveIndirect =
  emissiveGi.reduce((s, v, i) => s + v - emissiveDirect[i], 0) / emissiveGi.length;
check(emissiveIndirect > 1e-3, `AC-4 emission-only indirect ${emissiveIndirect.toFixed(5)}`);

const darkDirect = await render({ mode: 'off', light: false, emissive: false, frames: 1 });
const darkGi = await render({ mode: 'exact', light: false, emissive: false, frames: 4 });
const darkIndirect = Math.max(...darkGi.map((v, i) => Math.abs(v - darkDirect[i])));
check(
  darkIndirect < 1e-4,
  `F-1 light+emission off: max |GI - direct| ${darkIndirect.toExponential(2)}`,
);

// AC-5: screen traces must not lose energy that world rays find. A screen march
// that keeps advancing its proven-free distance behind a surface starts the world
// ray behind occluders, which then reads back faces (zero) or the black sky; the
// lit room measured 0.24x of the reference (1.24 relRMSE) before the march
// stopped extending free space once hidden. After: lit room 0.94x at 128 px.
const leakScene = PROCEDURAL_SCENES.leak;
const LEAK_BOUNCES = 7;
const leakRooms = async (camera) => {
  const lane = await gi.createGiRenderer({ width: SIZE, height: SIZE });
  const leakWorld = new World();
  spawnProceduralScene(
    leakWorld,
    { ...leakScene, camera },
    gi.publishMaterials(leakWorld, lane.assets, cooked),
    1,
    boxMesh,
  );
  const leakLease = lane.renderer.attach(leakWorld).unwrap();
  const leakDriver = await gi.createFrameDriver({
    renderer: lane.renderer,
    world: leakWorld,
    lease: leakLease,
  });
  const leakDirect = gi.directProfile(lane.renderer.inspect().profile);
  const sample = async (frames) => {
    const sum = new Float32Array(SIZE * SIZE * 3);
    for (let k = 0; k < frames; k++) {
      const { observed } = await leakDriver.observe(['linear-hdr']);
      framesObserved += 1;
      const rgb = gi.hdrToRgb(
        observed.observations.find((o) => o.domain === 'linear-hdr'),
        SIZE,
        SIZE,
      );
      for (let i = 0; i < sum.length; i++) sum[i] += rgb[i] / frames;
    }
    return sum;
  };
  lane.renderer.setProfile(leakDirect).unwrap();
  await leakDriver.settle();
  const direct = await sample(2);
  const diffuseGi = diffuseGiFor('screen-probe', leakScene);
  lane.renderer.setProfile({ ...leakDirect, diffuseGi }).unwrap();
  await leakDriver.settle();
  // Multi-bounce arrives through scene-history feedback, one bounce per few frames.
  for (let i = 0; i < 96; i++) await leakDriver.draw();
  const withGi = await sample(16);
  for (const error of lane.errors) errors.push(error);
  lane.renderer.dispose?.();
  const ray = await gi.proceduralRayScene(leakScene, cooked, true);
  const common = {
    device,
    compile: webgpu.createShaderModule,
    scene: buildRaySurfaceScene(ray.instances).unwrap(),
    materials: ray.materials,
    lights: [gi.lightSnapshot(leakScene.light)],
    camera,
    width: SIZE,
    height: SIZE,
    maxDistance: leakScene.maxDistance,
    receiver: 'diffuse',
  };
  const first = await gi.tracePath({
    ...common,
    maxBounces: 1,
    environment: [0, 0, 0],
    samples: 32,
  });
  const full = await gi.tracePath({
    ...common,
    maxBounces: 1 + LEAK_BOUNCES,
    environment: leakScene.environment,
    samples: REFERENCE_SAMPLES,
  });
  const indirect = withGi.map((v, i) => v - direct[i]);
  const reference = full.map((v, i) => v - first[i]);
  const room = (region) => indirectMetrics(indirect, reference, regionMask(region, SIZE, SIZE));
  return {
    lit: room({ ...leakScene.darkRoom, x0: 0.06, x1: 0.47 }),
    dark: room(leakScene.darkRoom),
  };
};
const leak = await leakRooms(leakScene.camera);
check(
  leak.lit.ratio >= 0.7 && leak.lit.ratio <= 1.3,
  `AC-5 leak lit-room indirect screen-probe ${leak.lit.mean.toFixed(4)} vs reference ${leak.lit.referenceMean.toFixed(4)} (ratio ${leak.lit.ratio.toFixed(3)})`,
);
// The camera sits in the 4 cm separator's plane, so the wall has no depth sample
// and screen rays from the dark room reach the lit room's pixels: 0.17-0.18x of
// the lit room at 64 px, 11x the 0.007 reference at 128 px (4.1x with world rays
// only). A missing wall would measure about 1x.
check(
  leak.dark.mean < 0.22 * leak.lit.mean,
  `AC-5 leak dark-room indirect ${leak.dark.mean.toFixed(4)} < 0.22 x lit ${leak.lit.mean.toFixed(4)} (reference ${leak.dark.referenceMean.toFixed(4)})`,
);
// Moved 1.5 m sideways the separator rasterizes (about 3 px wide). A screen ray
// that passes behind it must not accept a hit on the lit side: measured 3.84-3.95x
// of the reference, 4.99x when hits behind a surface were accepted.
const LEAK_WALL_VISIBLE = { ...leakScene.camera, origin: [1.5, 1.5, 14.2], target: [1.5, 1.5, 0] };
const leakVisible = await leakRooms(LEAK_WALL_VISIBLE);
check(
  leakVisible.dark.ratio <= 4.4,
  `AC-5 leak dark-room indirect, separator in view: ${leakVisible.dark.mean.toFixed(4)} vs reference ${leakVisible.dark.referenceMean.toFixed(4)} (ratio ${leakVisible.dark.ratio.toFixed(3)} <= 4.4)`,
);

// AC-6: the default leak view over-lights the dark room through the edge-on
// separator (above). The alternate view looks into that room, and a cut there must
// carry neither that view's pixel history nor its scene history. Without the cut
// signal the same move is continuous motion whose history passes the distance and
// normal test: 1.40x on the first frame and 1.22x at frame 8 (a 10-frame EMA decays
// 0.9 per frame). 128 px, because single 64 px frames of this view scatter by 8%.
const CUT_SIZE = 128;
const cut = await (async () => {
  const lane = await gi.createGiRenderer({ width: CUT_SIZE, height: CUT_SIZE });
  const cutWorld = new World();
  const controls = spawnProceduralScene(
    cutWorld,
    leakScene,
    gi.publishMaterials(cutWorld, lane.assets, cooked),
    1,
    boxMesh,
  );
  const driver = await gi.createFrameDriver({
    renderer: lane.renderer,
    world: cutWorld,
    lease: lane.renderer.attach(cutWorld).unwrap(),
  });
  const direct = gi.directProfile(lane.renderer.inspect().profile);
  lane.renderer.setProfile({ ...direct, diffuseGi: diffuseGiFor('screen-probe', leakScene) }).unwrap();
  await driver.settle();
  for (let i = 0; i < 96; i++) await driver.draw();
  const mean = async () => {
    const { observed } = await driver.observe(['linear-hdr']);
    framesObserved += 1;
    const rgb = gi.hdrToRgb(
      observed.observations.find((o) => o.domain === 'linear-hdr'),
      CUT_SIZE,
      CUT_SIZE,
    );
    let sum = 0;
    for (let p = 0; p < CUT_SIZE * CUT_SIZE; p++) sum += luminance(rgb, p);
    return sum / (CUT_SIZE * CUT_SIZE);
  };
  controls.setCamera(leakScene.cameraAlt, true);
  const curve = [];
  for (let k = 0; k < 8; k++) curve.push(await mean());
  for (let i = 0; i < 96; i++) await driver.draw();
  let converged = 0;
  for (let k = 0; k < 16; k++) converged += (await mean()) / 16;
  for (const error of lane.errors) errors.push(error);
  lane.renderer.dispose?.();
  return { converged, curve: curve.map((m) => m / converged) };
})();
const [cutFirst = Number.NaN] = cut.curve;
const cutAt8 = cut.curve[7] ?? Number.NaN;
check(
  Math.abs(cutFirst - 1) <= 0.1 && Math.abs(cutAt8 - 1) <= 0.1,
  `AC-6 leak camera cut: first frame ${cutFirst.toFixed(3)}x, frame 8 ${cutAt8.toFixed(3)}x of converged (${cut.curve.map((r) => r.toFixed(3)).join(' ')})`,
);

// AC-7: the field lane converges from its first sweeps; frames after settle let the
// hysteresis-filtered probes and the Card radiosity feedback reach steady state.
const FIELD_LEAK_WARMUP = 192;
const FIELD_LEAK_SAMPLES = 256;
const fieldLane = await gi.createGiRenderer({ width: SIZE, height: SIZE });
const fieldWorld = new World();
spawnProceduralScene(fieldWorld, leakScene, gi.publishMaterials(fieldWorld, fieldLane.assets, cooked), 1, boxMesh);
const fieldDriver = await gi.createFrameDriver({
  renderer: fieldLane.renderer,
  world: fieldWorld,
  lease: fieldLane.renderer.attach(fieldWorld).unwrap(),
});
const fieldProfile = gi.directProfile(fieldLane.renderer.inspect().profile);
async function fieldLeakImage(diffuseGi, warmup, frames) {
  fieldLane.renderer.setProfile(diffuseGi === undefined ? fieldProfile : { ...fieldProfile, diffuseGi }).unwrap();
  await fieldDriver.settle();
  for (let i = 0; i < warmup; i++) await fieldDriver.draw();
  const sum = new Float32Array(SIZE * SIZE * 3);
  for (let k = 0; k < frames; k++) {
    const { observed } = await fieldDriver.observe(['linear-hdr']);
    framesObserved += 1;
    const rgb = gi.hdrToRgb(observed.observations.find((o) => o.domain === 'linear-hdr'), SIZE, SIZE);
    for (let i = 0; i < sum.length; i++) sum[i] += rgb[i] / frames;
  }
  return sum;
}
const fieldDirect = await fieldLeakImage(undefined, 0, 2);
const fieldLit = await fieldLeakImage(diffuseGiFor('irradiance-field', leakScene), FIELD_LEAK_WARMUP, 8);
const fieldRay = await gi.proceduralRayScene(leakScene, cooked, true);
const fieldCommon = {
  device,
  compile: webgpu.createShaderModule,
  scene: buildRaySurfaceScene(fieldRay.instances).unwrap(),
  materials: fieldRay.materials,
  lights: [gi.lightSnapshot(leakScene.light)],
  camera: leakScene.camera,
  width: SIZE,
  height: SIZE,
  maxDistance: leakScene.maxDistance,
  receiver: 'diffuse',
};
const fieldReferenceDirect = await gi.tracePath({
  ...fieldCommon,
  maxBounces: 1,
  environment: [0, 0, 0],
  samples: 64,
});
const fieldReferenceFull = await gi.tracePath({
  ...fieldCommon,
  maxBounces: 1 + LEAK_BOUNCES,
  environment: leakScene.environment,
  samples: FIELD_LEAK_SAMPLES,
});
const fieldCovered = Uint8Array.from({ length: SIZE * SIZE }, (_, p) =>
  luminance(fieldLit, p) > 0 || luminance(fieldDirect, p) > 0 ? 1 : 0,
);
const fieldIndirect = fieldLit.map((v, i) => v - fieldDirect[i]);
const fieldReference = fieldReferenceFull.map((v, i) => v - fieldReferenceDirect[i]);
const fieldAll = indirectMetrics(fieldIndirect, fieldReference, fieldCovered);
const fieldDark = indirectMetrics(
  fieldIndirect,
  fieldReference,
  regionMask(leakScene.darkRoom, SIZE, SIZE).map((v, p) => v & fieldCovered[p]),
);
check(
  fieldAll.ratio >= 0.9 && fieldAll.ratio <= 1.1,
  `AC-7 leak indirect irradiance-field ${fieldAll.mean.toFixed(4)} vs reference ${fieldAll.referenceMean.toFixed(4)} (ratio ${fieldAll.ratio.toFixed(3)})`,
);
// Probes beside the 4 cm divider traced through it (the Global SDF trace's
// self-hit expansion shrinks with the start distance); retracing those rays one
// voxel off the surface took this 64 px / 256 spp ratio from 1.18 to 0.66 and the
// 128 px gi-gallery metric of the same region from 1.29 to 0.90 (lavapipe).
check(
  fieldDark.referenceMean > 0 && fieldDark.ratio >= 0.5 && fieldDark.ratio <= 1.0,
  `AC-7 dark room indirect ${fieldDark.mean.toFixed(5)} vs reference ${fieldDark.referenceMean.toFixed(5)} (ratio ${fieldDark.ratio.toFixed(3)} in [0.5, 1.0])`,
);

fieldLane.renderer.dispose?.();

// AC-8 / F-2: the build-time bake. The volume is cooked by the irradiance-volume
// NativeCooker over the same exact ray scene, lights and bounce budget the reference
// traces, written as a served Pack v2 catalog; the lane loads it from that catalog by
// GUID and gathers it with no trace pass. Same input, same bytes and digest.
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const bake = await import('./gi-bake.mjs');
const bakeSettings = { raysPerProbe: 32, samples: 16, maxBounces: LEAK_BOUNCES, seed: 47 };
const bakeDirectory = mkdtempSync(join(tmpdir(), 'hello-gi-bake-'));
const bakeScene = (target, identifier) =>
  bake.bakeProceduralScene({
    scene: target,
    cooked,
    guid: BAKED_VOLUMES[identifier],
    device,
    compile: webgpu.createShaderModule,
    settings: bakeSettings,
  });
const leakBake = await bakeScene(leakScene, 'leak');
const cornellBake = await bakeScene(scene, 'cornell');
const repeatBake = await bakeScene(leakScene, 'leak');
check(
  repeatBake.stats.digest === leakBake.stats.digest &&
    repeatBake.stats.fingerprint === leakBake.stats.fingerprint &&
    repeatBake.stats.artifactBytes === leakBake.stats.artifactBytes,
  `F-2 bake determinism: digest ${leakBake.stats.digest.slice(7, 19)} and ${leakBake.stats.artifactBytes} B reproduced`,
);
await bake.writeBakedCatalog(bakeDirectory, [leakBake, cornellBake]);

const bakedLane = await gi.createGiRenderer({ width: SIZE, height: SIZE, timing: true });
const bakedWorld = new World();
spawnProceduralScene(
  bakedWorld,
  leakScene,
  gi.publishMaterials(bakedWorld, bakedLane.assets, cooked),
  1,
  boxMesh,
);
const bakedDriver = await gi.createFrameDriver({
  renderer: bakedLane.renderer,
  world: bakedWorld,
  lease: bakedLane.renderer.attach(bakedWorld).unwrap(),
});
const restoreCatalog = gi.installDistCatalog(bakedLane.assets, bakeDirectory);
const bakedDirect = gi.directProfile(bakedLane.renderer.inspect().profile);
async function bakedImage(diffuseGi, warmup, frames) {
  bakedLane.renderer
    .setProfile(diffuseGi === undefined ? bakedDirect : { ...bakedDirect, diffuseGi })
    .unwrap();
  await bakedDriver.settle();
  const sum = new Float32Array(SIZE * SIZE * 3);
  for (let k = 0; k < warmup + frames; k++) {
    const { observed } = await bakedDriver.observe(['linear-hdr'], ['linear-hdr', 'timings']);
    framesObserved += 1;
    if (k < warmup) continue;
    for (const pass of observed.timings?.frame?.passes ?? []) bakedPasses.push(pass.passName);
    const rgb = gi.hdrToRgb(
      observed.observations.find((o) => o.domain === 'linear-hdr'),
      SIZE,
      SIZE,
    );
    for (let i = 0; i < sum.length; i++) sum[i] += rgb[i] / frames;
  }
  return sum;
}
const bakedPasses = [];
const bakedOff = await bakedImage(undefined, 1, 2);
const bakedLit = await bakedImage(
  diffuseGiFor('baked', leakScene, { volume: BAKED_VOLUMES.leak }),
  4,
  8,
);
const bakedInspect = bakedLane.renderer.inspect().diffuseGi;
const swappedScene = await bakedImage(
  diffuseGiFor('baked', leakScene, { volume: BAKED_VOLUMES.cornell }),
  4,
  8,
);
restoreCatalog();
const bakedCovered = Uint8Array.from({ length: SIZE * SIZE }, (_, p) =>
  luminance(bakedLit, p) > 0 || luminance(bakedOff, p) > 0 ? 1 : 0,
);
const bakedIndirect = bakedLit.map((v, i) => v - bakedOff[i]);
const bakedAll = indirectMetrics(bakedIndirect, fieldReference, bakedCovered);
const bakedDark = indirectMetrics(
  bakedIndirect,
  fieldReference,
  regionMask(leakScene.darkRoom, SIZE, SIZE).map((v, p) => v & bakedCovered[p]),
);
const swapped = swappedScene.map((v, i) => v - bakedOff[i]);
let swappedDelta = 0;
for (let i = 0; i < bakedLit.length; i++) swappedDelta += Math.abs(swapped[i] - bakedIndirect[i]);
swappedDelta /= bakedLit.length;
check(
  bakedInspect?.state === 'ready' && bakedInspect.volume?.probes > 0,
  `AC-8 baked lane ${bakedInspect?.state}: GUID ${bakedInspect?.volume?.guid}, ` +
    `${bakedInspect?.volume?.probes} probes, ${bakedInspect?.volume?.digest?.slice(7, 19)}`,
);
check(
  bakedAll.ratio >= 0.9 && bakedAll.ratio <= 1.1,
  `AC-8 leak indirect baked ${bakedAll.mean.toFixed(4)} vs reference ${bakedAll.referenceMean.toFixed(4)} (ratio ${bakedAll.ratio.toFixed(3)})`,
);
check(
  bakedDark.referenceMean > 0 && bakedDark.ratio >= 0.4 && bakedDark.ratio <= 1.3,
  `AC-8 dark room indirect ${bakedDark.mean.toFixed(5)} vs reference ${bakedDark.referenceMean.toFixed(5)} (ratio ${bakedDark.ratio.toFixed(3)} in [0.4, 1.3])`,
);
const TRACE_PASSES = /cardSurface|lightCards|traceProbes|updateProbes|deriveProbes|radiateCards/;
check(
  bakedPasses.some((name) => name.startsWith('baked-field.')) &&
    !bakedPasses.some((name) => TRACE_PASSES.test(name)),
  `AC-8 baked lane records ${[...new Set(bakedPasses)].join(', ')} and no trace pass`,
);
check(
  swappedDelta > 1e-3,
  `F-2 another scene's volume changes the image (mean |delta| ${swappedDelta.toExponential(2)}): the lane gathers the GUID it is given`,
);
errors.push(...bakedLane.errors);
bakedLane.renderer.dispose?.();
rmSync(bakeDirectory, { recursive: true, force: true });
check(errors.length === 0, `no device or renderer errors (${errors.length})`);
for (const error of errors.slice(0, 4))
  log(`  error: ${typeof error === 'string' ? error : JSON.stringify(error)}`);

const summary = {
  ok: failures.length === 0,
  backend: renderer.inspect().capabilities.backendKind,
  framesObserved,
  unlit: { pixels: mask.reduce((a, b) => a + b, 0), off: unlitOff, exact: unlitOn },
  direct: directMetrics,
  indirect: metrics,
  emissiveIndirect,
  darkIndirect,
  leak,
  fieldLeak: { all: fieldAll, darkRoom: fieldDark },
  bakedLeak: {
    bake: [leakBake.stats, cornellBake.stats],
    inspect: bakedInspect,
    all: bakedAll,
    darkRoom: bakedDark,
    passes: [...new Set(bakedPasses)],
    swappedDelta,
  },
  leakVisible,
  cut,
  failures,
};
renderer.dispose?.();
if (jsonMode) console.log(JSON.stringify(summary));
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
log(
  `PASS - backend=${summary.backend}; ${framesObserved} frames; exact GI matches reference indirect within the falsifier band`,
);
if (!jsonMode) emitSmokeReceipt('hello-gi/smoke', framesObserved);
process.exit(0);
