import { mkdirSync, writeFileSync } from 'node:fs';
import { Materials, MeshRenderer, type StandardDiffuseGi } from '@forgeax/engine-render';
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
  irradianceFieldGi,
  SIZE,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/radiance-cache/denoise';
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(
    `${directory}/${name}`,
    value instanceof Uint8Array ? value : JSON.stringify(value, null, 2),
  );

const PIXELS = SIZE * SIZE;
const MAX_HISTORY = 8;
const gi: StandardDiffuseGi = {
  ...irradianceFieldGi({ radiosity: false }),
  reflections: { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 },
};
/** Red channel of a 16-byte-per-pixel signal; NaN where the pixel is invalid. */
const red = (signal: Float32Array) =>
  Float64Array.from({ length: PIXELS }, (_, i) =>
    signal[i * 4 + 3] === 1 ? (signal[i * 4] ?? Number.NaN) : Number.NaN,
  );
const mean = (values: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] ?? Number.NaN;
  return sum / values.length;
};
/** Mean per-pixel standard deviation across frames, and the mean signal. */
const temporalNoise = (frames: readonly Float64Array[]) => {
  const deviation = new Float64Array(PIXELS);
  const average = new Float64Array(PIXELS);
  for (let i = 0; i < PIXELS; i++) {
    let m1 = 0;
    let m2 = 0;
    for (const frame of frames) {
      const value = frame[i] ?? Number.NaN;
      m1 += value / frames.length;
      m2 += (value * value) / frames.length;
    }
    average[i] = m1;
    deviation[i] = Math.sqrt(Math.max(m2 - m1 * m1, 0));
  }
  return { stddev: mean(deviation), mean: mean(average), average };
};
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < PIXELS; i++) sum += Math.abs((a[i] ?? Number.NaN) - (b[i] ?? Number.NaN));
  return sum / PIXELS;
};

it('denoises traced Lite reflections without ghosting under camera motion', {
  timeout: 1_800_000,
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
  /** History is a ping-pong pair; the one written last holds the larger ages. */
  const ages = async () => {
    const pair = await Promise.all([
      h.read('reflection-history-0'),
      h.read('reflection-history-1'),
    ]);
    return pair.map((history) =>
      Float64Array.from({ length: PIXELS }, (_, i) => history[i * 12 + 3] ?? Number.NaN),
    );
  };
  try {
    h.setSun(0);
    // Fully traced glossy metal: one GGX ray per pixel and frame is the noise source.
    const glossy = await h.publish(
      'reflection-denoise-glossy',
      Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 1, roughness: 0.3 }),
    );
    h.world.set(h.wall, MeshRenderer, { materials: [glossy] }).unwrap();
    h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
    h.setGi(gi);
    await h.settle(16);

    // Static noise: per-pixel temporal standard deviation of the raw traced
    // signal against the denoised signal, over the same frames.
    const raw: Float64Array[] = [];
    const denoised: Float64Array[] = [];
    for (let f = 0; f < 16; f++) {
      await h.draw();
      raw.push(red(await h.read('reflection-signal')));
      denoised.push(red(await h.read('reflection-denoised')));
    }
    const before = temporalNoise(raw);
    const after = temporalNoise(denoised);
    const settledAges = await ages();
    result.noise = {
      frames: raw.length,
      rawStddev: before.stddev,
      denoisedStddev: after.stddev,
      reduction: before.stddev / after.stddev,
      rawMean: before.mean,
      denoisedMean: after.mean,
      maxAge: Math.max(...settledAges.map((a) => Math.max(...a))),
    };
    // The scene is genuinely noisy, the denoiser removes most of it, keeps the
    // energy, and accumulates the whole bounded history when nothing moves.
    expect(before.stddev).toBeGreaterThan(0.02 * before.mean);
    expect(after.stddev).toBeLessThan(0.35 * before.stddev);
    // The 3x3 clamp trims the 1 spp fireflies, a small downward bias.
    expect(Math.abs(after.mean / before.mean - 1)).toBeLessThan(0.05);
    expect(Math.max(...settledAges.map((a) => Math.max(...a)))).toBe(MAX_HISTORY);

    // RHI Debug: capture the steady frame, replay it, rank its passes by GPU
    // time and read the denoiser's storage output back from the replay.
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await h.draw();
    (await recorder.frameBoundary()).unwrap();
    const live = await h.read('reflection-denoised');
    const encoded = (await pending).unwrap();
    save('renderer.rhitape', encoded.bytes);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const workOf = (entryPoint: string) => {
      const work = model.works.find((candidate) =>
        candidate.pipeline.shaders.some((shader) => shader.entryPoint === entryPoint),
      );
      assert(work, `frame contains ${entryPoint}`);
      return work;
    };
    const temporalWork = workOf('accumulateFieldReflections');
    const filterWork = workOf('filterFieldReflections');
    expect(workOf('traceReflections').workIndex).toBeLessThan(temporalWork.workIndex);
    expect(temporalWork.workIndex).toBeLessThan(filterWork.workIndex);
    expect(filterWork.workIndex).toBeLessThan(workOf('fs_ray_reflection_field').workIndex);
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const inspected = (await replay.inspectWork(filterWork.workIndex, ['outputs'])).unwrap();
      const output = inspected.outputs?.find((entry) => entry.name === '@group(0)@binding(19)');
      assert(output, 'the spatial filter exposes its denoised storage output');
      const bytes = output.result.unwrap().bytes;
      expect(bytes).toEqual(new Uint8Array(live.buffer, live.byteOffset, live.byteLength));
      const history = (await replay.inspectWork(temporalWork.workIndex, ['outputs']))
        .unwrap()
        .outputs?.find((entry) => entry.name === '@group(0)@binding(16)');
      assert(history, 'temporal accumulation exposes its history storage output');
      const records = new Float32Array(history.result.unwrap().bytes.slice().buffer);
      let oldest = 0;
      for (let i = 0; i < PIXELS; i++) oldest = Math.max(oldest, records[i * 12 + 3] ?? 0);
      expect(oldest).toBe(MAX_HISTORY);
      const timing = await replay.timePasses();
      result.replay = {
        digest: encoded.digest,
        works: model.works.length,
        denoisedOutputExact: true,
        historyMaxAge: oldest,
        timing: timing.ok
          ? timing.value.passes
              .filter((pass) => pass.label?.startsWith('irradiance-field.'))
              .map((pass) => ({
                label: pass.label,
                microseconds: pass.gpuNanoseconds === null ? null : pass.gpuNanoseconds / 1000,
              }))
          : { unavailable: timing.error.code },
      };
    } finally {
      (await replay.dispose()).unwrap();
      webgpu._internal_getRawDevice(device)?.destroy();
    }

    // Ghosting falsifier. The camera strafes: the wall shifts by its own motion
    // but the reflected emitter by its parallax, so surface-motion reprojection
    // drags a stale blob (measured 0.35 first-frame error before hit-distance
    // reprojection). The first moved frame must already match the converged
    // moved view, while the stale history blended without reprojection or
    // clamp does not.
    const stale = after.average;
    h.world.set(h.camera, Transform, { pos: [1, 0, 0] }).unwrap();
    await h.draw();
    const first = red(await h.read('reflection-denoised'));
    const firstRaw = red(await h.read('reflection-signal'));
    // The history written by the moved frame is the younger of the pair.
    const movedAges = (await ages()).reduce((a, b) => (mean(a) < mean(b) ? a : b));
    await h.settle(12);
    const settled: Float64Array[] = [];
    for (let f = 0; f < 16; f++) {
      await h.draw();
      settled.push(red(await h.read('reflection-denoised')));
    }
    const reference = temporalNoise(settled);
    save('motion-pixels.json', {
      stale: [...stale],
      first: [...first],
      firstRaw: [...firstRaw],
      reference: [...reference.average],
      ages: [...movedAges],
    });
    const ghost = distance(first, reference.average) / reference.mean;
    const unclamped = Float64Array.from(
      { length: PIXELS },
      (_, i) => ((MAX_HISTORY - 1) * (stale[i] ?? 0) + (firstRaw[i] ?? 0)) / MAX_HISTORY,
    );
    const naive = distance(unclamped, reference.average) / reference.mean;
    const moved = distance(stale, reference.average) / reference.mean;
    result.motion = {
      cameraOffset: [1, 0, 0],
      viewChange: moved,
      firstFrameError: ghost,
      staleBlendError: naive,
      restartedPixels: movedAges.filter((age) => age === 1).length,
      reusedPixels: movedAges.filter((age) => age > 1).length,
    };
    // The move really changes the reflection; disoccluded pixels restart while
    // the rest of the wall keeps reprojected history.
    expect(moved).toBeGreaterThan(0.2);
    expect(movedAges.filter((age) => age === 1).length).toBeGreaterThan(0);
    expect(movedAges.filter((age) => age > 1).length).toBeGreaterThan(PIXELS / 2);
    expect(ghost).toBeLessThan(0.5 * naive);
    expect(ghost).toBeLessThan(0.15);
    expect(h.errors).toEqual([]);
    save('result.json', result);
  } finally {
    save('latest-state.json', { result, errors: h.errors });
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
