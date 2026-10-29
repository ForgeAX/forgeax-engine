import { mkdirSync, writeFileSync } from 'node:fs';
import { halfFloat } from '@forgeax/engine-math';
import { Materials, MeshRenderer, type StandardDiffuseGi } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { observeReplaySubmissions } from './native-replay-work.fixture';
import {
  createIrradianceFieldHarness,
  type FieldImage,
  irradianceFieldGi,
  SIZE,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/radiance-cache/dawn';
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(
    `${directory}/${name}`,
    value instanceof Uint8Array ? value : JSON.stringify(value, null, 2),
  );

const REFLECTIONS = { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 } as const;
const REFLECTION_PASSES = [
  'irradiance-field.reflection-generate',
  'irradiance-field.reflection-trace',
  'irradiance-field.reflection-composite',
];
type Rgb = readonly [number, number, number];

/** Directional albedo E(F0=1, NoV=1, alpha) of the GGX/Smith lobe (independent of the LUT). */
function ggxAlbedoAtNormalIncidence(roughness: number): number {
  const a2 = Math.max(roughness * roughness, 1e-4) ** 2;
  const lambda = (c: number) => (Math.sqrt(a2 + (1 - a2) * c * c) - c) / (2 * c);
  const steps = 4096;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) / steps;
    const nh = Math.sqrt((1 - u) / (1 + (a2 - 1) * u));
    const nl = 2 * nh * nh - 1;
    if (nl > 0) sum += 1 / (1 + lambda(1) + lambda(nl));
  }
  return sum / steps;
}

const field = (environment: Rgb = [0, 0, 0]): StandardDiffuseGi => ({
  ...irradianceFieldGi({ environment, radiosity: false }),
  reflections: REFLECTIONS,
});
const exact = (environment: Rgb = [0, 0, 0]): StandardDiffuseGi => ({
  gather: 'exact',
  maxBounces: 1,
  maxDistance: 100,
  seed: 53,
  environment,
  reflections: REFLECTIONS,
});
const screenProbe = (environment: Rgb = [0, 0, 0]): StandardDiffuseGi => {
  const base = irradianceFieldGi({ environment, radiosity: false });
  assert(base.gather === 'irradiance-field');
  return {
    gather: 'screen-probe',
    maxDistance: base.maxDistance,
    environment: base.environment,
    field: base.field,
    probes: {
      downsample: 8,
      adaptiveFraction: 0.5,
      importance: 'brdf',
      screenTrace: { maxSteps: 32, thickness: 0.02 },
      filterPasses: 2,
      shortRangeAo: 0,
      maxFrames: 10,
    },
    reflections: REFLECTIONS,
  };
};

/** 4x4 blocks of 8x8 pixels: per-block mean of `a - b`. */
const blocks = (a: ArrayLike<number>, b?: ArrayLike<number>) =>
  Array.from({ length: 16 }, (_, k) => {
    let sum = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const i = ((k >> 2) * 8 + y) * SIZE + (k & 3) * 8 + x;
        sum += (a[i] ?? NaN) - (b === undefined ? 0 : (b[i] ?? NaN));
      }
    return sum / 64;
  });
const relative = (a: readonly number[], b: readonly number[]) => {
  let error = 0;
  let reference = 0;
  for (let i = 0; i < a.length; i++) {
    error += Math.abs((a[i] ?? NaN) - (b[i] ?? NaN));
    reference += Math.abs(b[i] ?? NaN);
  }
  return error / reference;
};
const mean = (values: readonly number[]) => values.reduce((s, v) => s + v, 0) / values.length;

it('serves Lite reflections from the directional radiance cache under field gathers', {
  timeout: 1_800_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    host: { gpuPassTiming: { maxPassesPerFrame: 128, maxFramesInFlight: 2, retentionFrames: 8 } },
    instrumentation: {
      onDeviceLost: () => recorder.deviceLost(),
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  const result: Record<string, unknown> = {};
  const metal = (roughness: number) =>
    h.publish(Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 1, roughness }));
  /** Mean linear HDR red over `frames` ordinary frames. */
  const average = async (frames: number) => {
    const sum = new Float64Array(SIZE * SIZE);
    let last: FieldImage | undefined;
    for (let f = 0; f < frames; f++) {
      last = await h.image();
      for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] ?? 0) + (last.red[i] ?? 0) / frames;
    }
    assert(last);
    return { sum, last };
  };
  const reflected = async (gi: StandardDiffuseGi, direct: FieldImage, frames: number) => {
    h.setGi(gi);
    await h.settle(gi.gather === 'exact' ? 8 : 16);
    const { sum, last } = await average(frames);
    return { blocks: blocks(sum, direct.red), last };
  };
  const directionalBlocks = async () => {
    const signal = await h.read('reflection-denoised');
    expect(signal.length).toBe(SIZE * SIZE * 4);
    return blocks(
      Float64Array.from({ length: SIZE * SIZE }, (_, i) => {
        expect(signal[i * 4 + 3]).toBe(1);
        return signal[i * 4] ?? NaN;
      }),
    );
  };
  try {
    h.setSun(0);
    const rough = await metal(0.7);
    const glossy = await metal(0.3);
    h.world.set(h.wall, MeshRenderer, { materials: [rough] }).unwrap();
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const dark = await h.image();

    // Furnace: a uniform environment L over the metal's open hemisphere. The rough
    // lane combines directional single scattering with multiple scattering from
    // cosine-weighted GI once; IBL is off, so nothing may add a second copy. The exact
    // lane under the same furnace is the reference, and no lane may exceed L.
    const L = 0.5;
    h.setGi({ ...irradianceFieldGi({ environment: [L, L, L], radiosity: false }) });
    await h.settle(16);
    const furnaceOff = await h.image();
    expect(Math.max(...furnaceOff.red.map((v, i) => Math.abs(v - (dark.red[i] ?? NaN))))).toBe(0);
    const center = (values: readonly number[]) =>
      mean(values.filter((_, k) => [5, 6, 9, 10].includes(k)));
    const furnaceExact = await reflected(exact([L, L, L]), dark, 32);
    const furnace = await reflected(field([L, L, L]), dark, 2);
    result.furnace = {
      L,
      roughness: 0.7,
      singleScatterGgx: L * ggxAlbedoAtNormalIncidence(0.7),
      exactCenter: center(furnaceExact.blocks),
      fieldCenter: center(furnace.blocks),
      field: furnace.blocks,
      exact: furnaceExact.blocks,
    };
    expect(Math.abs(center(furnace.blocks) / center(furnaceExact.blocks) - 1)).toBeLessThan(0.1);
    expect(Math.max(...furnace.blocks, ...furnaceExact.blocks)).toBeLessThan(L * 1.02);
    expect(center(furnace.blocks)).toBeGreaterThan(L * ggxAlbedoAtNormalIncidence(0.7));

    // Rough (cache) and glossy (Global SDF -> Card trace) metal next to an emissive
    // wall behind the camera, against the exact transport lane.
    const emitter = h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
    const comparison: Record<string, unknown> = {};
    result.comparison = comparison;
    for (const [name, material, tolerance] of [
      ['rough', rough, 0.25],
      ['glossy', glossy, 0.35],
    ] as const) {
      h.world.set(h.wall, MeshRenderer, { materials: [material] }).unwrap();
      const reference = await reflected(exact(), dark, 48);
      const cache = await reflected(field(), dark, 2);
      const fieldDirectional = await directionalBlocks();
      // Same field history as the field lane: a gather switch keeps the prepared
      // field, so start the Screen Probe lane from a fresh one.
      h.setGi(undefined);
      await h.draw();
      const probes = await reflected(screenProbe(), dark, 2);
      const screenProbeDirectional = await directionalBlocks();
      const error = relative(cache.blocks, reference.blocks);
      comparison[name] = {
        tolerance,
        meanRelativeBlockError: error,
        exactMean: mean(reference.blocks),
        fieldMean: mean(cache.blocks),
        screenProbeMean: mean(probes.blocks),
        exact: reference.blocks,
        field: cache.blocks,
        screenProbe: probes.blocks,
        fieldDirectional,
        screenProbeDirectional,
      };
    }
    for (const lane of Object.values(comparison) as {
      tolerance: number;
      meanRelativeBlockError: number;
      exact: number[];
      field: number[];
      screenProbe: number[];
      fieldDirectional: number[];
      screenProbeDirectional: number[];
    }[]) {
      expect(mean(lane.exact)).toBeGreaterThan(0.05);
      expect(lane.meanRelativeBlockError).toBeLessThan(lane.tolerance);
      // Directional reflections share the field lane. Broad multiple scattering
      // follows each gather's diffuse irradiance, so total metal radiance can differ.
      expect(relative(lane.screenProbeDirectional, lane.fieldDirectional)).toBeLessThan(0.02);
    }
    expect(h.renderer.inspect().perFramePassNames).toEqual(
      expect.arrayContaining(REFLECTION_PASSES),
    );

    // RHI capture of the rough-metal field frame: exact replay of the composite and
    // removing both indirect lobes must fall back to the unreflected frame.
    h.world.set(h.wall, MeshRenderer, { materials: [rough] }).unwrap();
    h.setGi(irradianceFieldGi({ radiosity: false }));
    await h.settle(16);
    const unreflected = await h.image();
    h.setGi(field());
    await h.settle(16);
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
        (shader) => shader.stage === 'fragment' && shader.entryPoint === 'fs_ray_reflection_field',
      ),
    );
    assert(composite, 'frame contains the field reflection composite');
    const diffuseComposite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' &&
          shader.entryPoint === 'fs_ray_diffuse_reconstructed_reflections',
      ),
    );
    assert(diffuseComposite, 'frame contains the broad multiple-scattering composite');
    expect(
      model.works.flatMap((work) =>
        work.pipeline.shaders.filter((s) => s.stage === 'compute').map((s) => s.entryPoint),
      ),
    ).toEqual(expect.arrayContaining(['generateFieldReflections', 'traceReflections']));
    const [sceneHandle, fallbackHandle] = composite.attachments?.colorViewHandleIds ?? [];
    assert(sceneHandle && fallbackHandle);
    const replayOf = async (frameTape: typeof tape) => {
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(
          replayDeviceRequest(frameTape, adapter.features, adapter.limits),
        )
      ).unwrap();
      const replay = (
        await openReplay(frameTape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      return {
        replay,
        submissions: observeReplaySubmissions(device),
        dispose: async () => {
          (await replay.dispose()).unwrap();
          webgpu._internal_getRawDevice(device)?.destroy();
        },
      };
    };
    const exactReplay = await replayOf(tape);
    try {
      const output = workOutputs(composite).find((row) => row.role === 'color');
      assert(output);
      const reads = (
        await exactReplay.replay.readAtWorks([
          { resourceId: sceneHandle, workIndex: diffuseComposite.workIndex },
          { resourceId: fallbackHandle, workIndex: composite.workIndex },
          { ...output.request, workIndex: composite.workIndex },
        ])
      ).unwrap();
      const composed = reads[2]?.unwrap();
      assert(composed);
      expect(composed.provenance.selectedWorkIndex).toBe(composite.workIndex);
      expect(composed.bytes).toEqual(captured.bytes);
      const broad = reads[0]?.unwrap();
      const directional = reads[1]?.unwrap();
      assert(broad && directional);
      expect(broad.provenance.selectedWorkIndex).toBe(diffuseComposite.workIndex);
      expect(directional.provenance.selectedWorkIndex).toBe(composite.workIndex);
      const channel = (bytes: Uint8Array, i: number) =>
        halfFloat.f16ToF32(
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(i * 8, true),
        );
      let multiMean = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        multiMean += channel(broad.bytes, i) / (SIZE * SIZE);
        expect(
          Math.abs(
            channel(captured.bytes, i) - channel(broad.bytes, i) - channel(directional.bytes, i),
          ),
        ).toBeLessThan(0.002);
      }
      exactReplay.submissions.assertMaximum(12);
      expect(multiMean).toBeGreaterThan(0.01);
      result.multipleScattering = { mean: multiMean, ssrFallbackContainsOnlyDirectional: true };
    } finally {
      exactReplay.submissions.restore();
      await exactReplay.dispose();
    }
    const omitted = {
      ...tape,
      events: tape.events.filter(
        (_, index) => index !== composite.eventIndex && index !== diffuseComposite.eventIndex,
      ),
    };
    const omittedModel = buildFrameModel(omitted);
    const falsifier = await replayOf(omitted);
    try {
      const last = omittedModel.works.at(-1);
      assert(last);
      const without = (
        await falsifier.replay.readResourceAtWork(sceneHandle, last.workIndex)
      ).unwrap();
      expect(without.bytes).toEqual(unreflected.bytes);
      expect(without.bytes).not.toEqual(captured.bytes);
    } finally {
      falsifier.submissions.restore();
      await falsifier.dispose();
    }
    result.replay = { digest: encoded.digest, works: model.works.length, exact: true };

    // Memory: every live irradiance-field buffer, by label.
    const memory = Object.fromEntries(
      [...new Set(h.liveBuffers())].map((buffer) => [buffer.label, buffer.size]),
    );
    result.memory = memory;
    expect(memory['irradiance-field.irradiance']).toBe(512 * 144 * 16);
    expect(memory['irradiance-field.reflection-rays']).toBe(SIZE * SIZE * 48);
    expect(memory['irradiance-field.reflection-signal']).toBe(SIZE * SIZE * 16);

    const steadyPasses = await h.steadyPasses();
    result.steadyPasses = steadyPasses;
    if (Array.isArray(steadyPasses))
      for (const names of steadyPasses)
        expect(names).toEqual(expect.arrayContaining(REFLECTION_PASSES));

    // Specular leak falsifier: the emitter moves behind the 0.25 wall. Probes behind
    // the wall are lit, yet neither the cache nor the trace may carry it to the front.
    h.world.despawn(emitter).unwrap();
    const visible = comparison.rough as { fieldMean: number };
    const hidden = h.spawn(h.emitterMesh, h.emissive, [0, 0, -5]);
    const leaks: unknown[] = [];
    result.leak = leaks;
    for (const material of [rough, glossy]) {
      h.world.set(h.wall, MeshRenderer, { materials: [material] }).unwrap();
      const leak = await reflected(field(), dark, 2);
      const lit = (await h.read('irradiance')).reduce((max, value) => Math.max(max, value), 0);
      expect(lit).toBeGreaterThan(0.5);
      const worst = Math.max(...leak.blocks.map(Math.abs));
      leaks.push({ worst, visible: visible.fieldMean, fieldMax: lit });
      if (worst >= 0.02 * visible.fieldMean) {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        await h.image();
        (await recorder.frameBoundary()).unwrap();
        const failure = (await pending).unwrap();
        save('hidden-emitter-failed.rhitape', failure.bytes);
        save('hidden-emitter-failed.json', {
          digest: failure.digest,
          worst,
          state: h.inspection(),
        });
      }
      expect(worst).toBeLessThan(0.02 * visible.fieldMean);
    }
    h.world.despawn(hidden).unwrap();
    expect(h.errors).toEqual([]);
    save('result.json', result);
  } finally {
    save('latest-state.json', { result, errors: h.errors, inspection: h.renderer.inspect() });
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
