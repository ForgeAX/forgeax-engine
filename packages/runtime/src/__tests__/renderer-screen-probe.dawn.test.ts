import { mkdirSync, writeFileSync } from 'node:fs';
import type { StandardDiffuseGi, StandardScreenProbes } from '@forgeax/engine-render';
import { Camera } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  type FieldImage,
  irradianceFieldGi,
  SIZE,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/screen-probe/dawn';
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(
    `${directory}/${name}`,
    value instanceof Uint8Array ? value : JSON.stringify(value, null, 2),
  );

const FIELD_PASSES = [
  'irradiance-field.card-surface',
  'irradiance-field.card-lighting',
  'irradiance-field.trace-probes',
  'irradiance-field.update-probes',
  'irradiance-field.radiosity',
];
const PROBE_PASSES = [
  'screen-probe.place-uniform',
  'screen-probe.place-adaptive',
  'screen-probe.generate-rays',
  'screen-probe.trace-screen',
  'screen-probe.trace-world',
  'screen-probe.resolve',
  'screen-probe.probe-temporal',
  'screen-probe.filter-0',
  'screen-probe.filter-1',
  'screen-probe.integrate',
  'screen-probe.temporal',
  'screen-probe.composite',
  'screen-probe.scene-history',
];
const L = 0.5;
const FURNACE_FRAMES = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 32 : 48;

/** The 32x32 view at downsample 8 gives a 4x4 uniform grid plus 8 adaptive slots. */
const screenProbeGi = (
  overrides: {
    readonly environment?: readonly [number, number, number];
    readonly probes?: Partial<StandardScreenProbes>;
  } = {},
): StandardDiffuseGi => {
  // Seven-frame history decay needs the original field sample count on both
  // backends; 32-ray noise exceeds the unchanged residual bound on Ray Query.
  const field = irradianceFieldGi({ ...overrides, resolution: 'half', raysPerProbe: 64 });
  assert(field.gather === 'irradiance-field');
  return {
    gather: 'screen-probe',
    maxDistance: field.maxDistance,
    environment: field.environment,
    field: field.field,
    probes: {
      downsample: 8,
      adaptiveFraction: 0.5,
      importance: 'brdf',
      screenTrace: { maxSteps: 32, thickness: 0.02 },
      filterPasses: 2,
      shortRangeAo: 0,
      maxFrames: 10,
      ...overrides.probes,
    },
  };
};

const stats = (a: FieldImage, b: FieldImage, mask: (i: number) => boolean = () => true) => {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let i = 0; i < a.red.length; i++) {
    if (!mask(i)) continue;
    const d = Math.abs((a.red[i] ?? 0) - (b.red[i] ?? 0));
    sum += d;
    max = Math.max(max, d);
    count++;
  }
  return { meanAbsolute: sum / Math.max(count, 1), max };
};

/** Mean frame-to-frame change over `frames` consecutive static images. */
const flicker = async (image: () => Promise<FieldImage>, frames: number) => {
  let previous = await image();
  let total = 0;
  for (let i = 0; i < frames; i++) {
    const next = await image();
    total += stats(previous, next).meanAbsolute;
    previous = next;
  }
  return total / frames;
};

it('lights, blocks, converges, reprojects, replays and recovers in the ordinary Renderer', {
  timeout: 900_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      onDeviceLost: () => recorder.deviceLost(),
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  const result: Record<string, unknown> = {};
  const motionCaptures: Record<string, { digest: string; bytes: number }> = {};
  const captureMotionImage = async (name: string) => {
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const image = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await pending).unwrap();
    save(`motion-${name}.rhitape`, encoded.bytes);
    save(
      `motion-${name}.red.bin`,
      new Uint8Array(image.red.buffer, image.red.byteOffset, image.red.byteLength),
    );
    motionCaptures[name] = { digest: encoded.digest, bytes: encoded.bytes.byteLength };
    save('motion-captures.json', motionCaptures);
    return image;
  };
  const probeState = () => {
    const state = h.inspection();
    assert('gather' in state && state.gather === 'screen-probe');
    return state;
  };
  try {
    // Lights off: no sun, environment or emission adds exactly zero.
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const dark = await h.image();
    h.setGi(screenProbeGi());
    await h.settle();
    const off = await h.image();
    expect(h.errors).toEqual([]);
    expect(off.bytes).toEqual(dark.bytes);
    expect(h.renderer.inspect().perFramePassNames).toEqual(
      expect.arrayContaining([...FIELD_PASSES, ...PROBE_PASSES]),
    );
    expect(h.renderer.inspect().perFramePassNames).not.toContain('irradiance-field.gather');
    expect(h.inspection()).toMatchObject({
      gather: 'screen-probe',
      state: 'ready',
      pixelCount: 1024,
      probes: { downsample: 8, tiles: [4, 4], uniform: 16, adaptiveCapacity: 8, raysPerProbe: 64 },
      field: { gather: 'irradiance-field', state: 'ready' },
    });

    // Offscreen emitter behind the camera: only world rays (Card radiance) see it.
    const emitter = h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
    await h.settle(16);
    const bleed = await captureMotionImage('before');
    expect(bleed.center).toBeGreaterThan(0.05);

    // Camera motion over the emitter's gradient. The wall face (z = -2.875,
    // fov 60) moves rigidly on screen, so the analytic warp splits the moved
    // view into reprojectable pixels and disoccluded ones (top rows and right
    // columns). The converged gather is itself view dependent (probe lattice
    // and screen-edge clamping), so even ideal reprojection keeps a residual:
    // the bound for reprojected pixels is that ideal warp, and a ghost (stale
    // history kept on disoccluded pixels) is what the second mask falsifies.
    const camera = [...h.world.query({ with: [Camera] }).unwrap()][0]?.entity;
    assert(camera !== undefined);
    const shift = 1 / (Math.tan(Math.PI / 6) * 2.875);
    const oldPixel = (i: number) => {
      const nx = ((i % SIZE) + 0.5) / (SIZE / 2) - 1 + 0.6 * shift;
      const ny = 1 - (Math.floor(i / SIZE) + 0.5) / (SIZE / 2) + 0.3 * shift;
      if (Math.abs(nx) >= 1 || Math.abs(ny) >= 1) return -1;
      const x = Math.min(SIZE - 1, Math.floor(((nx + 1) / 2) * SIZE));
      return Math.min(SIZE - 1, Math.floor(((1 - ny) / 2) * SIZE)) * SIZE + x;
    };
    h.world.set(camera, Transform, { pos: [0.6, 0.3, 0] }).unwrap();
    const after: FieldImage[] = [];
    for (let i = 0; i < 8; i++) {
      // Capture the exact frame tested by the original decay bound; each
      // branch still submits one image, preserving the eight-frame sequence.
      after.push(
        i === 0
          ? await captureMotionImage('first')
          : i === 7
            ? await captureMotionImage('after7')
            : await h.image(),
      );
    }
    await h.settle(32);
    const movedConverged = await captureMotionImage('converged');
    const warped = { ...bleed, red: bleed.red.map((_, i) => bleed.red[oldPixel(i)] ?? 0) };
    const reprojected = (i: number) => oldPixel(i) >= 0;
    const disoccluded = (i: number) => oldPixel(i) < 0;
    const moved = after[0] as FieldImage;
    const motion = {
      stale: stats(bleed, movedConverged).meanAbsolute,
      decay: [0, 1, 3, 7].map((i) => stats(after[i] as FieldImage, movedConverged).meanAbsolute),
      idealReprojection: stats(warped, movedConverged, reprojected).meanAbsolute,
      reprojected: stats(moved, movedConverged, reprojected).meanAbsolute,
      staleDisoccluded: stats(bleed, movedConverged, disoccluded).meanAbsolute,
      disoccluded: stats(moved, movedConverged, disoccluded).meanAbsolute,
    };
    result.motion = motion;
    save('result.json', result);
    // The independent comparison test also writes result.json. Keep the
    // motion oracle beside its matching captures before an assertion can fail.
    save('motion-result.json', result);
    expect(motion.stale).toBeGreaterThan(0.05);
    // Accepted taps must keep moved-view error below the ideal old-image warp.
    // Sharing the response budget does not relax this original motion bound.
    expect(motion.reprojected).toBeLessThan(motion.idealReprojection);
    // Disoccluded pixels restart from the current gather (measured 0.29x of
    // their stale error); a kept ghost would stay near 1x.
    expect(motion.disoccluded).toBeLessThan(0.5 * motion.staleDisoccluded);
    // Both temporal stages must meet the original seven-frame residual bound.
    // Kernel controls alone do not admit this complete-scene response.
    expect(motion.decay[3]).toBeLessThan(0.6 * (motion.decay[0] ?? 0));
    h.world.set(camera, Transform, { pos: [0, 0, 0] }).unwrap();
    await h.settle(32);

    // Leak falsifier: the same emitter behind the wall lights the field there,
    // yet none of it reaches the visible face.
    h.world.despawn(emitter).unwrap();
    const hidden = h.spawn(h.emitterMesh, h.emissive, [0, 0, -5]);
    await h.settle(16);
    const blocked = await h.image();
    const fieldMax = (await h.read('irradiance')).reduce((max, value) => Math.max(max, value), 0);
    expect(fieldMax).toBeGreaterThan(0.5);
    const blockedMax = blocked.red.reduce((max, value) => Math.max(max, value), 0);
    expect(blocked.center).toBeLessThan(0.02 * bleed.center);
    expect(blockedMax).toBeLessThan(0.05 * bleed.center);
    // Removal is an in-place field edit: the hidden light decays with the probe
    // history instead of a reset. The ghost is measured against the only signal
    // that light left on screen (blockedMax): 0.24x after 16 frames, while a
    // history that never forgets it stays at 1x.
    h.world.despawn(hidden).unwrap();
    await h.settle(16);
    const ghost = (await h.image()).red;
    const ghostMax = ghost.reduce(
      (max, value, i) => Math.max(max, Math.abs(value - (dark.red[i] ?? Number.NaN))),
      0,
    );
    result.emissive = {
      bleed: bleed.center,
      blocked: blocked.center,
      blockedMax,
      fieldMax,
      ghostMax,
    };
    save('result.json', result);
    save('emissive-images.json', {
      width: SIZE,
      height: SIZE,
      bleed: Array.from(bleed.red),
      blocked: Array.from(blocked.red),
      ghost: Array.from(ghost),
      dark: Array.from(dark.red),
    });
    // A perfectly black blocked signal has no relative decay denominator.
    // Require exact zero after removal; any nonzero residual still fails.
    // Positive baselines retain the original strict 50-percent decay bound.
    if (blockedMax === 0) expect(ghostMax).toBe(0);
    else expect(ghostMax).toBeLessThan(0.5 * blockedMax);

    // White furnace: albedo-1 wall and floor under a uniform environment. Screen
    // hits read the previous lit scene, so multi-bounce converges toward L.
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.setGi(screenProbeGi({ environment: [L, L, L] }));
    await h.settle(FURNACE_FRAMES);
    const furnace = await h.image();
    const furnaceMax = furnace.red.reduce((max, value) => Math.max(max, value), 0);
    expect(furnace.mean).toBeGreaterThan(0.85 * L);
    expect(furnace.mean).toBeLessThan(1.05 * L);
    expect(furnaceMax).toBeLessThan(1.15 * L);

    // Screen vs world consistency: world-only tracing reaches the same furnace.
    h.setGi(
      screenProbeGi({
        environment: [L, L, L],
        probes: { screenTrace: { maxSteps: 0, thickness: 0.02 } },
      }),
    );
    await h.settle(FURNACE_FRAMES);
    const worldOnly = await h.image();
    const consistency = stats(furnace, worldOnly);
    expect(consistency.meanAbsolute).toBeLessThan(0.08 * L);
    result.furnace = {
      L,
      mean: furnace.mean,
      max: furnaceMax,
      worldOnly: worldOnly.mean,
      consistency,
    };

    // Capture the production frame and replay its composite on a fresh device.
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const captured = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await pending).unwrap();
    save('renderer.rhitape', encoded.bytes);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const composite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' && shader.entryPoint === 'fs_ray_diffuse_reconstructed',
      ),
    );
    assert(composite, 'frame contains the shared diffuse composite');
    const computeEntries = model.works.flatMap((work) =>
      work.pipeline.shaders.filter((shader) => shader.stage === 'compute').map((s) => s.entryPoint),
    );
    expect(computeEntries).toEqual(
      expect.arrayContaining([
        'placeUniformProbes',
        'placeAdaptiveProbes',
        'compactAdaptiveProbes',
        'generateProbeRays',
        'traceScreenProbes',
        'traceWorldProbes',
        'resolveProbeRays',
        'temporalProbeRadiance',
        'filterProbeRadiance',
        'integrateScreenProbes',
        'temporalScreenProbes',
        'copySceneHistory',
      ]),
    );
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const inspected = (await replay.inspectWork(composite.workIndex, ['pixels'])).unwrap();
      assert(inspected.attachment);
      expect(inspected.attachment.bytes).toEqual(captured.bytes);
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(device)?.destroy();
    }
    result.replay = { digest: encoded.digest, works: model.works.length, exact: true };

    // A rejected submit neither flips history nor counts as a frame.
    const frames = h.inspection().submittedFrames;
    h.rejectNextSubmit();
    expect(h.submit().ok).toBe(false);
    expect(h.inspection().submittedFrames).toBe(frames);
    h.errors.length = 0;
    await h.draw();
    expect(h.inspection().submittedFrames).toBe(frames + 1);

    // Resize replaces only per-extent buffers; the field generation survives.
    const fieldGeneration = probeState().field?.generation;
    expect(fieldGeneration).toBeTypeOf('number');
    // Past 1, so a restarted field (generation 1) fails the checks below.
    expect(fieldGeneration).toBeGreaterThan(1);
    h.canvas.width = h.canvas.height = 16;
    await h.settle(24);
    expect(h.inspection()).toMatchObject({ pixelCount: 256, probes: { tiles: [2, 2] } });
    expect(probeState().field?.generation).toBe(fieldGeneration);
    const small = await h.image();
    expect(Math.abs(small.mean - furnace.mean)).toBeLessThan(0.1 * L);
    h.canvas.width = h.canvas.height = 32;
    await h.settle(24);
    result.resize = { small: small.mean };

    // One shared field: both lanes read the Renderer's single field, so its
    // generation counter continues across lane switches (a second field
    // would restart at 1). The profile change republishes the scene, which
    // may advance the generation; it never resets it.
    const shared = screenProbeGi({ environment: [L, L, L] });
    assert(shared.gather === 'screen-probe' && fieldGeneration !== undefined);
    h.setGi({
      gather: 'irradiance-field',
      maxDistance: shared.maxDistance,
      environment: shared.environment,
      field: shared.field,
    });
    await h.settle(4);
    const fieldLane = h.inspection();
    assert('gather' in fieldLane && fieldLane.gather === 'irradiance-field');
    expect(fieldLane.generation).toBeGreaterThanOrEqual(fieldGeneration);
    h.setGi(shared);
    await h.settle(24);
    expect(probeState().field?.generation).toBeGreaterThanOrEqual(fieldLane.generation);
    result.generation = {
      before: fieldGeneration,
      fieldLane: fieldLane.generation,
      after: probeState().field?.generation,
    };

    // Temporal accumulation needs a spatially varying transport signal. The
    // uniform furnace above converges below the output's half-float quantum;
    // comparing its rounding flicker with a directly modulated sun would not
    // exercise GI history. Keep that energy test separate and add the same
    // offscreen emitter used by the real-world transport control.
    h.spawn(h.emitterMesh, h.emissive, [-1, 0, 1]);
    h.setGi(screenProbeGi({ environment: [L, L, L], probes: { maxFrames: 1 } }));
    await h.settle(8);
    const raw = await flicker(h.image, 8);
    h.setGi(screenProbeGi({ environment: [L, L, L] }));
    await h.settle(0);
    const early = await flicker(h.image, 3);
    await h.settle(24);
    const late = await flicker(h.image, 8);
    expect(raw).toBeGreaterThan(0);
    expect(late).toBeLessThan(0.5 * raw);
    expect(late).toBeLessThan(early);
    // A lighting change keeps the geometry, so reprojected history survives it:
    // a sun drifting every frame (its direct change is ~1e-5) must keep the
    // settled flicker instead of restarting at the raw per-frame level.
    let drift = 0;
    let previous = await h.image();
    for (let i = 0; i < 8; i++) {
      h.setSun(i % 2 === 0 ? 2e-5 : 1e-5);
      const next = await h.image();
      drift += stats(previous, next).meanAbsolute / 8;
      previous = next;
    }
    h.setSun(0);
    result.temporal = { fixture: 'asymmetric-offscreen-emitter', raw, early, late, drift };
    save('result.json', result);
    expect(drift).toBeLessThan(0.25 * raw);

    // Disable retires the shared field after its submitted work completes.
    const live = h.liveBuffers();
    expect(live.length).toBeGreaterThan(8);
    h.setGi(undefined);
    await h.draw();
    expect(h.renderer.inspect().diffuseGi).toBeUndefined();
    await expect
      .poll(async () => {
        await h.draw();
        return live.every((buffer) => h.destroyed.has(buffer));
      })
      .toBe(true);
    h.setGi(screenProbeGi({ environment: [L, L, L] }));
    await h.settle(FURNACE_FRAMES);
    const beforeLoss = await h.image();

    const old = h.native();
    h.loseDevice();
    await expect.poll(() => h.renderer.state()).toBe('device-lost');
    h.errors.length = 0;
    renderValue(await h.renderer.recover());
    old?.destroy();
    expect(h.native()).not.toBe(old);
    await h.settle(FURNACE_FRAMES);
    const recovered = await h.image();
    expect(Math.abs(recovered.mean - beforeLoss.mean)).toBeLessThan(0.05 * L);
    expect(h.errors).toEqual([]);
    result.recovery = { before: beforeLoss.mean, after: recovered.mean };
    save('result.json', result);
  } finally {
    save('latest-state.json', { result, errors: h.errors, inspection: h.renderer.inspect() });
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});

it('stays within a bounded error of the exact and irradiance-field lanes with the expected GPU passes', {
  timeout: 900_000,
}, async () => {
  const h = await createIrradianceFieldHarness({
    rhi: webgpu.rhi,
    manifest,
    host: { gpuPassTiming: { maxPassesPerFrame: 128, maxFramesInFlight: 2, retentionFrames: 8 } },
  });
  try {
    h.spawn(h.floorMesh, h.white, [0, -1.5, -2]);
    h.setSun(1);
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const direct = await h.image();
    expect(direct.center).toBeGreaterThan(0.1);
    const environment = [0.25, 0.25, 0.25] as const;
    const render = async (gi: StandardDiffuseGi) => {
      h.setGi(gi);
      await h.settle(32);
      return h.image();
    };
    const exactGi = (maxBounces: number): Extract<StandardDiffuseGi, { gather: 'exact' }> => ({
      gather: 'exact',
      maxBounces,
      maxDistance: 100,
      seed: 47,
      environment,
      reconstruction: 'combined',
    });
    /** Error of the indirect term (image minus direct) against a reference. */
    const errorOf = (image: FieldImage, exact: FieldImage) => {
      let sum = 0;
      let signed = 0;
      let reference = 0;
      let max = 0;
      for (let i = 0; i < image.red.length; i++) {
        const a = (image.red[i] ?? 0) - (direct.red[i] ?? 0);
        const b = (exact.red[i] ?? 0) - (direct.red[i] ?? 0);
        sum += Math.abs(a - b);
        signed += a - b;
        reference += b;
        max = Math.max(max, Math.abs(a - b));
      }
      return {
        meanAbsolute: sum / image.red.length,
        meanBias: signed / image.red.length,
        meanExact: reference / image.red.length,
        meanRelative: sum / reference,
        max,
      };
    };
    const exactOne = await render(exactGi(1));
    const exactMulti = await render(exactGi(4));
    const fieldImage = await render(irradianceFieldGi({ environment, radiosity: false }));
    const probeImage = await render(screenProbeGi({ environment }));
    // Screen hits read the lit previous frame and the embedded field keeps
    // radiosity, so the probe lane is multi-bounce: its matched reference is
    // the 4-bounce exact lane; the radiosity-free field matches 1 bounce.
    const error = {
      screenProbe: errorOf(probeImage, exactMulti),
      screenProbeVsOneBounce: errorOf(probeImage, exactOne),
      irradianceField: errorOf(fieldImage, exactOne),
      vsField: stats(probeImage, fieldImage),
    };
    save('comparison-error.json', error);
    expect(error.screenProbe.meanExact).toBeGreaterThan(0.02);
    // Measured 0.067 against 4 bounces (0.24 against 1 bounce, biased bright).
    expect(error.screenProbe.meanRelative).toBeLessThan(0.15);
    expect(error.irradianceField.meanRelative).toBeLessThan(0.3);

    const steadyPasses = await h.steadyPasses();
    if (Array.isArray(steadyPasses))
      for (const names of steadyPasses) expect(names).toEqual(expect.arrayContaining(PROBE_PASSES));

    // Energy of a compact source: the offscreen emitter lights wall and floor
    // through world rays only, where a probe's octahedral texels are far from
    // equal-area (solid angle varies 2.8x), so the probe cosine convolution
    // must weight texels by solid angle.
    h.setSun(0);
    h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
    const emitterExact = await render({ ...exactGi(4), environment: [0, 0, 0] });
    const emitterProbe = await render(screenProbeGi());
    const emitterField = await render(irradianceFieldGi({}));
    const energy = {
      exact: emitterExact.mean,
      screenProbe: emitterProbe.mean / emitterExact.mean,
      irradianceField: emitterField.mean / emitterExact.mean,
    };
    expect(h.errors).toEqual([]);
    save('comparison.json', {
      backend: 'dawn',
      resolution: [32, 32],
      probes: { downsample: 8, uniform: 16, adaptive: 8, raysPerProbe: 64 },
      error,
      energy,
      steadyPasses,
    });
    // The shared world trace already reads 1.10x on the field lane; the probe
    // gather measures 1.21x (equal-texel weighting measured 1.36x).
    expect(energy.screenProbe).toBeGreaterThan(0.9);
    expect(energy.screenProbe).toBeLessThan(1.28);
  } finally {
    save('comparison-state.json', { errors: h.errors, inspection: h.renderer.inspect() });
    await h.dispose();
  }
});
