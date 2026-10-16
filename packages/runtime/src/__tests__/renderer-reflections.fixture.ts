import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  ScreenSpaceReflection,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import type { RayPublicationSet } from '../../../render/src/__tests__/raytracing/path-tracer.commands';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
type Rgb = readonly [number, number, number];

const SIZE = 32;
const CENTER = SIZE / 2;

/** Directional albedo E(F0, NoV=1, alpha) of Schlick-GGX with height-correlated Smith,
 * by midpoint quadrature over the half-vector polar angle. Independent of the LUT. */
function ggxAlbedoAtNormalIncidence(f0: number, roughness: number): number {
  const a2 = Math.max(roughness * roughness, 1e-4) ** 2;
  const steps = 4096;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    // Sample H by the GGX NDF: cos(thetaH) from a uniform u; then L = reflect(V=N, H).
    const u = (i + 0.5) / steps;
    const nh = Math.sqrt((1 - u) / (1 + (a2 - 1) * u));
    const nl = 2 * nh * nh - 1;
    if (nl <= 0) continue;
    const lambda = (c: number) => (Math.sqrt(a2 + (1 - a2) * c * c) - c) / (2 * c);
    const g = 1 / (1 + lambda(1) + lambda(nl));
    const vh = nh;
    const fresnel = f0 + (1 - f0) * (1 - vh) ** 5;
    // pdf(L) = D*NoH/(4*VoH); estimator f*NoL/pdf = F*G*VoH/(NoV*NoH).
    sum += (fresnel * g * vh) / nh;
  }
  return sum / steps;
}

/** Ordinary Renderer, real cooked materials, production passes only. */
export async function verifyRendererReflections(
  fixture: RayPublicationSet,
  save: Save,
  manifestUrl?: string,
  reconstruction?: 'combined',
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const errors: unknown[] = [];
  const accumulations: GPUBuffer[] = [];
  let native: GPUDevice | undefined;
  let surface: GPUTexture | undefined;
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        native = config.device;
        native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const createBuffer = native.createBuffer.bind(native);
        native.createBuffer = (descriptor) => {
          const buffer = createBuffer(descriptor);
          if (descriptor.label === 'ray-path.accumulation') accumulations.push(buffer);
          return buffer;
        };
        surface?.destroy();
        const srgb = config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb';
        surface = native.createTexture({
          size: [SIZE, SIZE],
          format: config.format,
          viewFormats: [srgb],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const { renderer, assets } = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        gpuPassTiming: { maxPassesPerFrame: 256, maxFramesInFlight: 2, retentionFrames: 8 },
        ssrIdentity: {
          sourceHead: 'fixture:renderer-reflections',
          sourceTree: 'fixture:renderer-reflections',
          lockSha256: 'fixture:renderer-reflections',
          buildSha256: 'fixture:renderer-reflections',
        },
        rhiInstrumentation: {
          onDeviceLost: () => recorder.deviceLost(),
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      manifestUrl === undefined ? undefined : { shaderManifestUrl: manifestUrl },
    ),
  );
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const allocMaterial = (asset: RayPublicationSet['materials'][number]['asset']) =>
    world.allocSharedRef('MaterialAsset', asset);
  const materials = new Map<string, ReturnType<typeof allocMaterial>>();
  for (const material of fixture.materials) {
    if (!['mirror', 'glossy', 'metal', 'matte', 'emission'].includes(material.name)) continue;
    const record = validateCookedMaterialRecord(
      JSON.parse(material.cookedPublication.record),
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({
        guid: material.name,
        record,
        artifacts: Object.fromEntries(
          Object.entries(material.cookedPublication.artifacts).map(([path, bytes]) => [
            path,
            { bytes: new TextEncoder().encode(bytes) },
          ]),
        ),
      }),
    }).load({ guid: material.name, specializationKey: record.specializationKey ?? '' });
    assert(ready.status === 'Ready', JSON.stringify(ready));
    assets.catalog(material.name, material.asset).unwrap();
    assets.recordMaterialReadiness(material.name, ready);
    materials.set(material.name, allocMaterial(material.asset));
  }
  const use = (name: string) => {
    const handle = materials.get(name);
    assert(handle, name);
    return [handle];
  };
  const box = (x: number, y: number, z: number) =>
    world.allocSharedRef('MeshAsset', createBoxGeometry(x, y, z).unwrap());
  // A metallic wall fills the view; diffuse GI adds nothing to it, so every
  // HDR delta under reflections is specular indirect.
  const wall = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: box(8, 8, 0.1) } },
      { component: MeshRenderer, data: { materials: use('mirror') } },
    )
    .unwrap();
  // Off-screen emissive strip behind the camera: only a world trace can see it.
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      { component: MeshFilter, data: { assetHandle: box(20, 2, 0.1) } },
      { component: MeshRenderer, data: { materials: use('emission') } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 50,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, -0.6, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const directProfile = {
    ...renderer.inspect().profile,
    renderPath: 'deferred' as const,
    ibl: false,
    ssao: false,
    visibleSurface: true,
  };
  const gi = {
    ...(reconstruction === undefined ? {} : { reconstruction }),
    gather: 'exact' as const,
    maxBounces: 1,
    maxDistance: 100,
    seed: 91,
    environment: [0, 0, 0] as const,
  };
  const reflections = { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1 };
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: 'direct',
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const submitted = submit();
    if (!submitted.ok) throw new Error(JSON.stringify(submitted.error, null, 1));
    const receipt = submitted.value;
    renderValue(await receipt.completed);
    return receipt;
  };
  const inspectGi = () => {
    const state = renderer.inspect().diffuseGi;
    assert(state && !('gather' in state), 'exact GI inspection');
    return state;
  };
  const settled = async () => {
    const started = performance.now();
    while (performance.now() - started < 60000) {
      await draw();
      const state = inspectGi();
      if (state.state === 'failed') throw new Error(JSON.stringify({ state, errors }));
      if (state.state === 'ready' && state.submittedFrames > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`reflections did not settle: ${JSON.stringify(renderer.inspect().diffuseGi)}`);
  };
  /** Mean linear HDR over `frames` consecutive ordinary frames (1 spp each). */
  const hdr = async (name: string, frames = 1) => {
    assert(renderer.requestObservation);
    const sum = new Float64Array(SIZE * SIZE * 4);
    let last: Uint8Array | undefined;
    for (let frame = 0; frame < frames; frame++) {
      renderValue(renderer.requestObservation(['linear-hdr']));
      const receipt = await draw();
      const result = renderValue(
        await renderer.observe(receipt, { include: ['linear-hdr'] }),
      ).observations?.find((item) => item.domain === 'linear-hdr');
      assert(result);
      last = result.bytes;
      const data = new DataView(
        result.bytes.buffer,
        result.bytes.byteOffset,
        result.bytes.byteLength,
      );
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE * 4; x++)
          sum[y * SIZE * 4 + x] =
            (sum[y * SIZE * 4 + x] ?? 0) +
            halfToFloat(data.getUint16(y * result.metadata.bytesPerRow + x * 2, true));
    }
    assert(last);
    await save(`${name}.rgba16float`, last);
    const mean = sum.map((value) => value / frames);
    return {
      bytes: last,
      at: (x: number, y: number): Rgb => {
        const base = (y * SIZE + x) * 4;
        return [mean[base] ?? NaN, mean[base + 1] ?? NaN, mean[base + 2] ?? NaN];
      },
    };
  };
  const readBuffer = async (source: GPUBuffer) => {
    assert(native);
    const buffer = native.createBuffer({ size: source.size, usage: 8 | 1 });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, buffer, 0, buffer.size);
      native.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1);
      return new DataView(buffer.getMappedRange().slice(0));
    } finally {
      buffer.destroy();
    }
  };
  const minus = (a: Rgb, b: Rgb): Rgb => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const result: Record<string, unknown> = {};
  try {
    renderValue(renderer.setProfile(directProfile));
    for (let i = 0; i < 4; i++) await draw();
    const direct = await hdr('direct');
    // GI without reflections leaves a metal wall untouched: no specular source yet.
    renderValue(renderer.setProfile({ ...directProfile, diffuseGi: gi }));
    await settled();
    const giOnly = await hdr('gi-only');
    expect(giOnly.bytes).toEqual(direct.bytes);

    renderValue(renderer.setProfile({ ...directProfile, diffuseGi: { ...gi, reflections } }));
    await settled();
    expect(renderer.inspect().perFramePassNames).toEqual(
      expect.arrayContaining([
        'ray-reflection.generate',
        'ray-reflection.composite',
        ...(reconstruction === undefined
          ? []
          : ['ray-reflection.temporal', 'ray-reflection.spatial']),
      ]),
    );
    if (reconstruction !== undefined) {
      await draw();
      expect(inspectGi().reflectionReconstruction).toMatchObject({
        mode: reconstruction,
        historyUsed: true,
      });
    }
    // Mirror: the center reflection ray returns along +Z to the strip's emissive face.
    const mirror = await hdr('mirror');
    const accumulation = accumulations.at(-1);
    if (accumulation === undefined) throw new Error('ray-path.accumulation buffer was not created');
    const world0 = await readBuffer(accumulation);
    const ray = (CENTER * SIZE + CENTER) * 80;
    const radiance: Rgb = [0, 4, 8].map((o) => world0.getFloat32(ray + o, true)) as never;
    expect(world0.getUint32(ray + 12, true)).toBe(1);
    expect(world0.getUint32(ray + 28, true)).toBe(0);
    // Path-tracer radiance of the emissive strip: emissive [1,0.5,0.25] x intensity 2.
    for (const [channel, expected] of [2, 1, 0.5].entries())
      expect(radiance[channel]).toBeCloseTo(expected, 3);
    const mirrorDelta = minus(mirror.at(CENTER, CENTER), direct.at(CENTER, CENTER));
    const reference = ggxAlbedoAtNormalIncidence(0.9, 0.05);
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs((mirrorDelta[channel] ?? NaN) / ((radiance[channel] ?? NaN) * reference) - 1),
      ).toBeLessThan(0.06);

    // RHI capture of the mirror frame: exact replay, single-count fallback, falsifier.
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const captured = await hdr('captured');
    (await recorder.frameBoundary()).unwrap();
    const encoded = (await pending).unwrap();
    await save('renderer.rhitape', encoded.bytes);
    const tape = decodeTape(encoded.bytes).unwrap();
    const model = buildFrameModel(tape);
    const entry =
      reconstruction === undefined ? 'fs_ray_reflection' : 'fs_ray_reflection_reconstructed';
    const composite = model.works.find((work) =>
      work.pipeline.shaders.some(
        (shader) => shader.stage === 'fragment' && shader.entryPoint === entry,
      ),
    );
    assert(composite, 'ordinary frame contains the production reflection composite');
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
        dispose: async () => {
          (await replay.dispose()).unwrap();
          webgpu._internal_getRawDevice(device)?.destroy();
        },
      };
    };
    const exact = await replayOf(tape);
    let fallbackCenter: Rgb;
    try {
      const inspected = (
        await exact.replay.inspectWork(composite.workIndex, ['pipeline', 'bindings', 'pixels'])
      ).unwrap();
      assert(inspected.attachment);
      expect(inspected.attachment.bytes).toEqual(captured.bytes);
      const fallback = (
        await exact.replay.readResourceAtWork(fallbackHandle, composite.workIndex)
      ).unwrap();
      await save('reflection-fallback.rgba16float', fallback.bytes);
      const data = new DataView(
        fallback.bytes.buffer,
        fallback.bytes.byteOffset,
        fallback.bytes.byteLength,
      );
      const row = fallback.bytes.byteLength / SIZE;
      fallbackCenter = [0, 1, 2].map((c) =>
        halfToFloat(data.getUint16(CENTER * row + CENTER * 8 + c * 2, true)),
      ) as never;
    } finally {
      await exact.dispose();
    }
    // The SSR-replaceable fallback carries exactly the specular that scene color gained.
    for (let channel = 0; channel < 3; channel++)
      expect(fallbackCenter[channel]).toBeCloseTo(mirrorDelta[channel] ?? NaN, 2);
    const omitted = {
      ...tape,
      events: tape.events.filter((_, index) => index !== composite.eventIndex),
    };
    const omittedModel = buildFrameModel(omitted);
    const falsifier = await replayOf(omitted);
    try {
      const last = omittedModel.works.at(-1);
      assert(last);
      const without = (
        await falsifier.replay.readResourceAtWork(sceneHandle, last.workIndex)
      ).unwrap();
      expect(without.bytes).toEqual(direct.bytes);
      expect(without.bytes).not.toEqual(captured.bytes);
    } finally {
      await falsifier.dispose();
    }

    // GPU pass timings of the same ordinary frame shape.
    const timed = await draw();
    const observed = renderValue(await renderer.observe(timed, { include: ['timings'] })).timings;
    const timings: Record<string, number> = {};
    if (observed?.status === 'complete' || observed?.status === 'partial')
      for (const pass of observed.frame.passes)
        if (pass.status === 'measured' && pass.passName.startsWith('ray-'))
          timings[pass.passName] = (timings[pass.passName] ?? 0) + pass.durationNanoseconds / 1e6;
    result.timingStatus = observed?.status;
    result.timingsMs = timings;

    // Roughness: a row profile through the strip. The mirror keeps a sharp band;
    // the glossy GGX lobe and the rough cosine lobe spread and lower it.
    const frames = reconstruction === undefined ? 16 : 8;
    // Each receiver has its own direct specular highlight, so each gets its own baseline.
    const profile = async (name: string) => {
      world.set(wall, MeshRenderer, { materials: use(name) }).unwrap();
      renderValue(renderer.setProfile(directProfile));
      for (let i = 0; i < 4; i++) await draw();
      const baseline = await hdr(`${name}-direct`);
      renderValue(renderer.setProfile({ ...directProfile, diffuseGi: { ...gi, reflections } }));
      await settled();
      for (let i = 0; i < 4; i++) await draw();
      const image = await hdr(name, frames);
      return Array.from(
        { length: SIZE },
        (_, y) => (image.at(CENTER, y)[0] ?? NaN) - (baseline.at(CENTER, y)[0] ?? NaN),
      );
    };
    const rows = {
      mirror: await profile('mirror'),
      glossy: await profile('glossy'),
      metal: await profile('metal'),
    };
    result.rows = rows;
    const peak = (values: number[]) => Math.max(...values);
    const tail = (values: number[]) => (values[2] ?? NaN) + (values[SIZE - 3] ?? NaN);
    expect(peak(rows.mirror)).toBeGreaterThan(peak(rows.glossy));
    expect(peak(rows.glossy)).toBeGreaterThan(peak(rows.metal));
    expect(Math.abs(tail(rows.mirror))).toBeLessThan(0.02);
    expect(tail(rows.metal)).toBeGreaterThan(0.02);

    // Leak falsifier: a matte occluder between the wall and the strip must remove
    // the reflection; screen-space or probe interpolation would leak it.
    world.set(wall, MeshRenderer, { materials: use('mirror') }).unwrap();
    const occluder = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        { component: MeshFilter, data: { assetHandle: box(20, 4, 0.1) } },
        { component: MeshRenderer, data: { materials: use('matte') } },
      )
      .unwrap();
    await settled();
    const occluded = await hdr('occluded');
    const leak = minus(occluded.at(CENTER, CENTER), direct.at(CENTER, CENTER));
    result.leak = leak;
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(leak[channel] ?? NaN)).toBeLessThan(
        0.01 * Math.max(mirrorDelta[0], 1e-3) + 1e-3,
      );
    world.despawn(occluder).unwrap();
    await settled();

    // SSR first, world fallback second: the strip is behind the camera, so SSR
    // misses and replacing by confidence must leave exactly the world specular.
    world.addComponent(camera, { component: ScreenSpaceReflection, data: {} }).unwrap();
    await settled();
    for (let i = 0; i < 4; i++) await draw();
    const withSsr = await hdr('mirror-ssr');
    const ssrDelta = minus(withSsr.at(CENTER, CENTER), direct.at(CENTER, CENTER));
    result.ssrDelta = ssrDelta;
    // The SSR passes must really execute on this frame shape, or the check is vacuous.
    const ssrTimed = renderValue(
      await renderer.observe(await draw(), { include: ['timings'] }),
    ).timings;
    const ssrPasses =
      ssrTimed?.status === 'complete' || ssrTimed?.status === 'partial'
        ? ssrTimed.frame.passes
            .filter((pass) => pass.passName.startsWith('ssr-'))
            .map((pass) => pass.passName)
        : [];
    result.ssrPasses = ssrPasses;
    result.ssr = renderer.inspect().ssr;
    await save('ssr-state.json', new TextEncoder().encode(JSON.stringify(result, null, 2)));
    expect(ssrPasses).toEqual(expect.arrayContaining(['ssr-trace', 'ssr-compose']));
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs((ssrDelta[channel] ?? NaN) - (mirrorDelta[channel] ?? NaN))).toBeLessThan(
        0.03 * (mirrorDelta[channel] ?? NaN) + 1e-3,
      );
    expect(errors).toEqual([]);
    Object.assign(result, {
      reconstruction: reconstruction ?? 'raw',
      resolution: [SIZE, SIZE],
      raysPerPixelPerFrame: 1,
      worldRadiance: radiance,
      ggxReference: reference,
      mirrorDelta,
      fallbackCenter,
      replayExact: true,
      missingCompositeFalsifier: true,
    });
    await save('result.json', new TextEncoder().encode(JSON.stringify(result, null, 2)));
  } finally {
    await save(
      'latest-state.json',
      new TextEncoder().encode(
        JSON.stringify({ result, errors, inspection: renderer.inspect().diffuseGi }, null, 2),
      ),
    );
    unsubscribe();
    lease.dispose();
    renderValue(await renderer.dispose());
    (await recorder.dispose()).unwrap();
    surface?.destroy();
    native?.destroy();
  }
}
