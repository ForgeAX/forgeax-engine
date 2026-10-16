import { mkdirSync, writeFileSync } from 'node:fs';
import {
  encodeIrradianceVolume,
  IRRADIANCE_VOLUME_ARTIFACT,
  IRRADIANCE_VOLUME_KIND,
  IRRADIANCE_VOLUME_MEDIA_TYPE,
  integrateIrradianceProbes,
  irradianceVolumeDigest,
  sphericalFibonacci,
} from '@forgeax/engine-render/internal';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterEach, assert, expect, it, vi } from 'vitest';
import { createIrradianceFieldHarness } from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const LIT = '3c9e5a71-0d2b-4f6e-8a1c-7b4d2e9f0a35';
const DARK = '8e2f4b06-1c7d-4a9e-b35f-0d6a2c8e1b47';
const MISSING = 'd4a1c7e2-5b3f-4e8a-9c06-1f2b3d4e5a68';
const lattice = { origin: [-4, -4, -4], spacing: 1, dimensions: [9, 9, 9] } as const;

/** A converged volume of one constant environment: every probe stores D = L. */
function constantVolume(radiance: number): Uint8Array {
  const directions = sphericalFibonacci(64);
  const rays = 729 * 64;
  const volume = integrateIrradianceProbes(lattice, {
    directions,
    radiance: new Float32Array(rays * 3).fill(radiance),
    distance: new Float32Array(rays).fill(-1),
    status: new Uint8Array(rays),
  }).unwrap();
  return encodeIrradianceVolume(volume).unwrap();
}

const directory = 'artifacts/baked-field/dawn';
const TRACE_ENTRIES = [
  'cardSurface',
  'lightCards',
  'traceProbes',
  'updateProbes',
  'deriveProbes',
  'radiateCards',
];
const PASSES = ['baked-field.gather', 'baked-field.upsample', 'baked-field.composite'];
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

/**
 * The baked lane gathers a Catalog volume through the field sampler. A unit
 * environment volume lights the white wall to albedo * D with no trace or probe
 * update pass, a zero volume adds exactly nothing (falsifier), and an unknown GUID
 * fails with a structured error instead of silently rendering dark.
 */
it('gathers a cooked irradiance volume from the Catalog without tracing', {
  timeout: 600_000,
}, async () => {
  const volumes = new Map([
    [LIT, constantVolume(0.5)],
    [DARK, constantVolume(0)],
  ]);
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/pack-index.json')) {
      fetched.push(url);
      return new Response(
        JSON.stringify(
          [LIT, DARK].map((guid) => ({
            guid,
            packageUrl: `/baked/${guid}.pack.json`,
            kind: IRRADIANCE_VOLUME_KIND,
            sourcePath: `${guid}.fxiv`,
          })),
        ),
      );
    }
    const guid = [...volumes.keys()].find((key) => url.includes(key));
    if (guid !== undefined) {
      fetched.push(url);
      const bytes = volumes.get(guid) as Uint8Array;
      if (url.endsWith('.fxiv')) return new Response(Uint8Array.from(bytes).buffer);
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid,
              kind: IRRADIANCE_VOLUME_KIND,
              payload: {
                artifact: IRRADIANCE_VOLUME_ARTIFACT,
                digest: irradianceVolumeDigest(bytes),
              },
              refs: [],
              artifacts: {
                [IRRADIANCE_VOLUME_ARTIFACT]: {
                  path: `${guid}.fxiv`,
                  mediaType: IRRADIANCE_VOLUME_MEDIA_TYPE,
                  byteLength: bytes.byteLength,
                },
              },
            },
          ],
        }),
      );
    }
    return original(input, init);
  });
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
  try {
    h.assets.configurePackIndex('/pack-index.json');
    h.setGi(undefined);
    for (let i = 0; i < 4; i++) await h.draw();
    const off = await h.image();
    expect(off.mean).toBe(0);

    h.setGi({ gather: 'baked', volume: DARK, resolution: 'half' });
    await h.settle(2);
    expect((await h.image()).bytes).toEqual(off.bytes);

    h.setGi({ gather: 'baked', volume: LIT, resolution: 'half' });
    await h.settle(2);
    const lit = await h.image();
    expect(h.errors).toEqual([]);
    // White Lambert wall under D = 0.5 everywhere: outgoing radiance albedo * D.
    expect(lit.center).toBeGreaterThan(0.45);
    expect(lit.center).toBeLessThan(0.55);
    const passes = h.renderer.inspect().perFramePassNames;
    expect(passes).toEqual(expect.arrayContaining(PASSES));
    expect(passes.filter((name) => name.startsWith('irradiance-field.'))).toEqual([]);
    const state = h.inspection();
    expect(state).toMatchObject({
      gather: 'baked',
      state: 'ready',
      volume: {
        guid: LIT,
        digest: irradianceVolumeDigest(volumes.get(LIT) as Uint8Array),
        dimensions: [9, 9, 9],
        probes: 729,
      },
    });
    expect(state.submittedFrames).toBeGreaterThan(0);
    // The captured runtime frame gathers and composites; nothing traces or updates probes.
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const captured = await h.image();
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await pending).unwrap();
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const compute = model.works.flatMap((work) =>
      work.pipeline.shaders.filter((shader) => shader.stage === 'compute').map((s) => s.entryPoint),
    );
    expect(compute).toEqual(expect.arrayContaining(['gatherBakedField', 'upsampleBakedField']));
    expect(compute.filter((entry) => TRACE_ENTRIES.includes(entry ?? ''))).toEqual([]);
    const composite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) =>
          shader.stage === 'fragment' && shader.entryPoint === 'fs_ray_diffuse_reconstructed',
      ),
    );
    assert(composite, 'frame contains the shared diffuse composite');
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
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/baked.rhitape`, encoded.bytes);
    writeFileSync(
      `${directory}/baked-frame.json`,
      JSON.stringify(
        {
          digest: encoded.digest,
          works: model.works.length,
          compute,
          passes,
          center: lit.center,
          inspection: state,
        },
        null,
        2,
      ),
    );

    // Steady frames re-upload nothing: the probe artifacts were fetched once.
    const loads = fetched.filter((url) => url.endsWith(`${LIT}.fxiv`)).length;
    for (let i = 0; i < 4; i++) await h.draw();
    expect(fetched.filter((url) => url.endsWith(`${LIT}.fxiv`)).length).toBe(loads);

    h.setGi({ gather: 'baked', volume: MISSING, resolution: 'full' });
    const started = performance.now();
    while (h.inspection().state !== 'failed') {
      await h.draw();
      if (performance.now() - started > 60_000) throw new Error('missing volume never failed');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const failed = h.inspection();
    expect(failed).toMatchObject({ gather: 'baked', state: 'failed' });
    expect('error' in failed && typeof failed.error?.code).toBe('string');
    h.errors.length = 0;
  } finally {
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
