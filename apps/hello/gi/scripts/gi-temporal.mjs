// hello-gi temporal response: after a converged warm-up, one discrete event (the key
// light moves to its alternate position, the camera cuts to its alternate pose, the
// camera teleports there without the cut signal, so history reprojects as continuous
// motion, or `none` as a stationary control) and per-frame linear HDR images until the
// lane settles again. `meanCurve` is the per-frame covered mean over the converged mean.
//
//   node scripts/gi-temporal.mjs [--scenes cornell,leak,courtyard] [--size 128]
//     [--lanes irradiance-field,screen-probe] [--events light,camera,teleport,none]
//     [--warmup 240] [--frames 120] [--tail 240] [--tail-stride 16] [--out <dir>]
//     [--sponza-dist <dist>] [--capture-frames 1,30,120]
//
// Error e(t) = mean |L(I_t) - L(I_inf)| over covered pixels, where I_inf is the mean of
// 16 frames taken every `--tail-stride` frames after a further `--tail` frames. The
// noise floor is the mean per-frame error of those 16 frames. A probe keeps its Monte
// Carlo error until its next lattice sweep, so the samples must span many sweeps:
// consecutive frames share that error and understate the floor about tenfold.
// Progress p(t) = (e(1) - e(t)) / (e(1) - floor);
// frames to 50%/90% are the first t at which p(t) reaches that level and stays there
// for 4 frames. Direct light responds within one frame, so e(1) is the stale-GI error.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import * as gi from './gi-dawn.mjs';
import { optionReader, rasterCoverage } from './gi-comparison.mjs';
import { luminance, toDisplay, toHeatmap, writePfm, writePng } from './gi-metrics.mjs';

const args = process.argv.slice(2);
const option = optionReader(args);
const SIZE = Number(option('size', '128'));
const WARMUP = Number(option('warmup', '240'));
const FRAMES = Number(option('frames', '120'));
const TAIL = Number(option('tail', '240'));
const TAIL_STRIDE = Number(option('tail-stride', '16'));
const LANES = option('lanes', 'irradiance-field,screen-probe').split(',');
const EVENTS = option('events', 'light,camera').split(',');
const SCENES = option('scenes', 'cornell,leak,courtyard').split(',');
const CAPTURE_FRAMES = option('capture-frames', '').split(',').filter(Boolean).map(Number);
if (CAPTURE_FRAMES.some((frame) => !Number.isSafeInteger(frame) || frame < 1 || frame > FRAMES) || new Set(CAPTURE_FRAMES).size !== CAPTURE_FRAMES.length)
  throw new Error('capture-frames must contain unique event frames within the measured window');
for (const lane of LANES) if (!['irradiance-field', 'screen-probe'].includes(lane)) throw new Error(`invalid lane ${lane}`);
for (const event of EVENTS) if (!['light', 'camera', 'teleport', 'none'].includes(event)) throw new Error(`invalid event ${event}`);
for (const [name, value] of Object.entries({ SIZE, WARMUP, FRAMES, TAIL, TAIL_STRIDE }))
  if (!Number.isSafeInteger(value) || value < 1 || (name === 'FRAMES' && value < 30)) throw new Error(`invalid ${name}`);
const OUT = resolve(option('out', resolve(gi.monorepoRoot, 'artifacts/gi-temporal')));
const SPONZA_DIST = resolve(option('sponza-dist', resolve(gi.appRoot, 'dist')));
mkdirSync(OUT, { recursive: true });

await gi.installDawn();
const adapter = await navigator.gpu.requestAdapter();
const { PROCEDURAL_SCENES, SPONZA, diffuseGiFor } = await import('../src/scenes.ts');
const { createGiBoxMesh, setCameraPose, setLightState, spawnCamera, spawnLight, spawnProceduralScene } =
  await import('../src/build-scene.ts');
const boxMesh = await createGiBoxMesh();
const cooked = SCENES.some((id) => id !== 'sponza') ? await gi.cookGiMaterials() : new Map();

async function spawn(world, assets, id) {
  if (id !== 'sponza') {
    const scene = PROCEDURAL_SCENES[id];
    const controls = spawnProceduralScene(world, scene, gi.publishMaterials(world, assets, cooked), 1, boxMesh);
    return { scene, controls };
  }
  const { createWorldContext } = await import('@forgeax/engine-ecs');
  const { renderComponentsPlugin } = await import('@forgeax/engine-render');
  const { scenePlugin } = await import('@forgeax/engine-scene');
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  const restore = gi.installDistCatalog(assets, SPONZA_DIST);
  try {
    const asset = (await assets.loadByGuid(assets.parseGuid(SPONZA.sceneGuid))).unwrap();
    assets.instantiate(world.allocSharedRef('SceneAsset', asset), world).unwrap();
  } finally {
    restore();
  }
  const light = spawnLight(world, SPONZA.light);
  const camera = spawnCamera(world, SPONZA.camera, 1);
  return {
    scene: SPONZA,
    controls: {
      setLight: (on, moved = false) => setLightState(world, light, SPONZA.light, on, moved),
      setCamera: (pose, cut = false) => setCameraPose(world, camera, pose, cut),
    },
  };
}

function errorAgainst(rgb, target, covered) {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < covered.length; p++) {
    if (!covered[p]) continue;
    sum += Math.abs(luminance(rgb, p) - luminance(target, p));
    n += 1;
  }
  return sum / Math.max(1, n);
}

function framesTo(level, curve, start, floor) {
  const span = start - floor;
  if (!(span > 0)) return 0;
  for (let t = 0; t < curve.length; t++) {
    const ok = curve.slice(t, t + 4).every((e) => (start - e) / span >= level);
    if (ok && t + 4 <= curve.length) return t + 1;
  }
  return null;
}

const report = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gi.monorepoRoot }).toString().trim(),
  sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'packages', 'apps/hello/gi', 'scripts/raytracing'], { cwd: gi.monorepoRoot })).digest('hex'),
  assetsCommit: execFileSync('git', ['-C', 'forgeax-engine-assets', 'rev-parse', 'HEAD'], { cwd: gi.monorepoRoot }).toString().trim(),
  catalogSha256: SCENES.includes('sponza') ? createHash('sha256').update(readFileSync(resolve(SPONZA_DIST, 'pack-index.json'))).digest('hex') : undefined,
  adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
    device: adapter.info.device, description: adapter.info.description },
  generatedAt: new Date().toISOString(),
  size: SIZE,
  warmup: WARMUP,
  frames: FRAMES,
  tail: TAIL,
  tailStride: TAIL_STRIDE,
  captureFrames: CAPTURE_FRAMES,
  coverage: 'same-frame visible-surface rows at the post-event camera; includes black geometry',
  runs: [],
};
for (const id of SCENES)
  for (const lane of LANES)
    for (const event of EVENTS) {
      const { renderer, assets, errors, recorder } = await gi.createGiRenderer({ width: SIZE, height: SIZE, capture: CAPTURE_FRAMES.length > 0 });
      try {
        const world = new World();
        const { scene, controls } = await spawn(world, assets, id);
        const lease = renderer.attach(world).unwrap();
        const driver = await gi.createFrameDriver({ renderer, world, lease });
        const direct = gi.directProfile(renderer.inspect().profile);
        renderer.setProfile({ ...direct, diffuseGi: diffuseGiFor(lane, scene) }).unwrap();
        await driver.settle();
        let surface;
        const captures = [];
        const frame = async (includeSurface = false, eventFrame) => {
          const pending = CAPTURE_FRAMES.includes(eventFrame)
            ? recorder.captureFrame({ byteBudget: 2 ** 31, snapshotTimeoutMs: 600000 })
            : undefined;
          // Seed retained resources before the measured frame; this boundary does
          // not advance the World or consume another temporal sample.
          if (pending) (await recorder.frameBoundary()).unwrap();
          const { observed } = await driver.observe(includeSurface ? ['linear-hdr', 'visible-surface'] : ['linear-hdr']);
          if (pending) {
            const tape = (await pending).unwrap();
            const file = `${id}-${lane}-${event}-f${eventFrame}.rhitape`;
            writeFileSync(resolve(OUT, file), tape.bytes);
            captures.push({ eventFrame, frameId: observed.observations.find((o) => o.domain === 'linear-hdr').metadata.frameId, file,
              bytes: tape.bytes.byteLength, sha256: createHash('sha256').update(tape.bytes).digest('hex') });
          }
          if (includeSurface) surface = observed.observations.find((o) => o.domain === 'visible-surface');
          return gi.hdrToRgb(observed.observations.find((o) => o.domain === 'linear-hdr'), SIZE, SIZE);
        };
        for (let i = 0; i < WARMUP; i++) await driver.draw();
        const before = await frame();
        if (event === 'light') controls.setLight(true, true);
        else if (event !== 'none') controls.setCamera(scene.cameraAlt, event === 'camera');
        const curveImages = [];
        for (let t = 0; t < FRAMES; t++) curveImages.push(await frame(false, t + 1));
        for (let i = 0; i < TAIL; i++) await driver.draw();
        const tail = [];
        for (let i = 0; i < 16; i++) {
          for (let k = 1; k < TAIL_STRIDE; k++) await driver.draw();
          tail.push(await frame(i === 15));
        }
        const converged = new Float32Array(SIZE * SIZE * 3);
        for (const img of tail) for (let i = 0; i < converged.length; i++) converged[i] += img[i] / tail.length;
        const covered = rasterCoverage(surface, SIZE, SIZE);
        if (!covered.some((value) => value !== 0)) throw new Error('empty temporal raster coverage');
        if ([before, ...curveImages, ...tail].some((image) => image.some((value) => !Number.isFinite(value)))) throw new Error('nonfinite temporal HDR value');
        const floor = tail.reduce((s, img) => s + errorAgainst(img, converged, covered), 0) / tail.length;
        const curve = curveImages.map((img) => errorAgainst(img, converged, covered));
        const meanLum = (img) => {
          let s = 0;
          let n = 0;
          for (let p = 0; p < covered.length; p++)
            if (covered[p]) {
              s += luminance(img, p);
              n += 1;
            }
          return s / Math.max(1, n);
        };
        const target = meanLum(converged);
        const run = {
          scene: id,
          captures,
          lane,
          event,
          convergedMean: target,
          noiseFloor: floor,
          relativeNoiseFloor: floor / Math.max(1e-12, target),
          startError: curve[0],
          relativeStartError: curve[0] / Math.max(1e-12, target),
          framesTo50: framesTo(0.5, curve, curve[0], floor),
          framesTo90: framesTo(0.9, curve, curve[0], floor),
          residualAt8: curve[7] / Math.max(1e-12, target),
          residualAt30: curve[29] / Math.max(1e-12, target),
          curve: curve.map((e) => e / Math.max(1e-12, target)),
          meanCurve: curveImages.map((img) => meanLum(img) / Math.max(1e-12, target)),
          coveragePixels: covered.reduce((sum, value) => sum + value, 0),
          coverageSha256: createHash('sha256').update(covered).digest('hex'),
          coverageFrameId: surface.metadata.frameId,
          inspect: renderer.inspect().diffuseGi,
          errors,
        };
        // Ghosting evidence: frame 1, frame 8 and converged, plus the frame-8 residual.
        const exposure = 0.5 / Math.max(1e-4, target);
        run.exposure = exposure;
        const name = `${id}-${lane}-${event}`;
        for (const [part, image] of [['before', before], ['f1', curveImages[0]], ['f8', curveImages[7]], ['converged', converged]])
          writePfm(resolve(OUT, `${name}-${part}.pfm`), image, SIZE, SIZE);
        writePng(resolve(OUT, `${name}-before.png`), toDisplay(before, SIZE, SIZE, exposure), SIZE, SIZE);
        writePng(resolve(OUT, `${name}-f1.png`), toDisplay(curveImages[0], SIZE, SIZE, exposure), SIZE, SIZE);
        writePng(resolve(OUT, `${name}-f8.png`), toDisplay(curveImages[7], SIZE, SIZE, exposure), SIZE, SIZE);
        writePng(resolve(OUT, `${name}-converged.png`), toDisplay(converged, SIZE, SIZE, exposure), SIZE, SIZE);
        writePng(resolve(OUT, `${name}-f8-residual.png`), toHeatmap(curveImages[7], converged, SIZE, SIZE, 0.25 * target), SIZE, SIZE);
        report.runs.push(run);
        writeFileSync(resolve(OUT, 'temporal.json'), `${JSON.stringify(report, null, 2)}\n`);
        console.log(
          `[temporal] ${name}: start ${run.relativeStartError.toFixed(3)} floor ${run.relativeNoiseFloor.toFixed(3)} ` +
            `to50 ${run.framesTo50} to90 ${run.framesTo90} @8 ${run.residualAt8.toFixed(3)}`,
        );
      } catch (cause) {
        report.failure = { scene: id, lane, event, message: String(cause) };
        writeFileSync(resolve(OUT, 'temporal.json'), `${JSON.stringify(report, null, 2)}\n`);
        throw cause;
      } finally {
        renderer.dispose();
      }
    }
writeFileSync(resolve(OUT, 'temporal.json'), `${JSON.stringify(report, null, 2)}\n`);
process.exit(report.runs.length !== SCENES.length * LANES.length * EVENTS.length || report.runs.some((run) => run.errors.length > 0) ? 1 : 0);
