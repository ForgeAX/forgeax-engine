import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { RenderPipeline, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import type { RhiBackendPack } from '../assembly/backend-contract';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

function distinctVariantManifest(): string {
  const data = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(data.slice(data.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    for (const variant of entry.variants) {
      variant.composedWgsl += `\n// first-use variant: ${variant.definesKey}`;
    }
  }
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

it.each([
  false,
  true,
])('builds a first-use PBR variant synchronously (backend immediate=%s)', async (immediate) => {
  const asynchronous: string[] = [];
  const synchronous: Array<{ device: RhiDevice; code: string }> = [];
  let lose: ((info: { reason: 'unknown'; message: string }) => void) | undefined;
  const loss = new Promise<{ reason: 'unknown'; message: string }>((resolve) => {
    lose = resolve;
  });
  let initialDevice: RhiDevice | undefined;
  const backend: RhiBackendPack = {
    rhi,
    instrumentation: {
      deviceLost: (device) => {
        initialDevice ??= device;
        return device === initialDevice ? loss : device.lost;
      },
    },
    createShaderModule: async (device, descriptor) => {
      asynchronous.push(descriptor.code);
      return rhi.createShaderModule(device, descriptor);
    },
    ...(immediate
      ? ({
          createShaderModuleImmediate: (device, descriptor) => {
            synchronous.push({ device, code: descriptor.code });
            return rhi.createShaderModuleImmediate(device, descriptor);
          },
        } satisfies Partial<RhiBackendPack>)
      : {}),
  };
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    undefined,
    { shaderManifestUrl: distinctVariantManifest() },
    backend,
  );
  const indexedDraws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  try {
    expect((await renderer.initialization).ok).toBe(true);
    expect(synchronous).toHaveLength(0);
    const beforeDraw = asynchronous.length;
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const attached = attachment.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: DirectionalLight,
          data: { castShadow: true, direction: [0, -1, -1], color: [1, 1, 1], intensity: 1 },
        },
      )
      .unwrap();
    const material = assets
      .create(
        Materials.standard({
          baseColor: [1, 1, 1, 1],
          renderState: { blend: { color: {}, alpha: {} } },
        }),
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update().unwrap();
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    const draw = () =>
      renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
    indexedDraws.mockClear();
    expect(draw().ok).toBe(true);
    expect(indexedDraws).toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(asynchronous).toHaveLength(beforeDraw);
    expect(synchronous.length).toBe(immediate ? 1 : 0);
    const firstModuleDevice = synchronous[0]?.device;
    lose?.({ reason: 'unknown', message: 'first-use recovery regression' });
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.health().reason).toBe('device-lost');
    const recovered = await renderer.recover();
    if (!recovered.ok) throw new Error(JSON.stringify(recovered.error));
    errors.length = 0;
    const beforeRecoveredDraw = asynchronous.length;
    world.update().unwrap();
    indexedDraws.mockClear();
    expect(draw().ok).toBe(true);
    expect(indexedDraws).toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(asynchronous).toHaveLength(beforeRecoveredDraw);
    expect(synchronous).toHaveLength(immediate ? 2 : 0);
    if (immediate) expect(synchronous[1]?.device).not.toBe(firstModuleDevice);
  } finally {
    indexedDraws.mockRestore();
    await renderer.dispose();
  }
});

it.each([
  false,
  true,
])('records first-use Standard transmission at 16 texture slots (backend immediate=%s)', async (immediate) => {
  const productionPrepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepare');
  const fixtureUrl = distinctVariantManifest();
  const manifest = JSON.parse(decodeURIComponent(fixtureUrl.slice(fixtureUrl.indexOf(',') + 1)));
  const standard = manifest.materialShaders.find(
    (entry: { identifier: string }) => entry.identifier === 'forgeax::default-standard-pbr',
  );
  // Opaque extraction prepares a producer-owned scene-index artifact before selecting
  // the direct geometry lane. Supply that variant through ordinary manifest assembly.
  standard.variants = standard.variants.flatMap(
    (variant: { defines: Record<string, boolean>; composedWgsl: string }) =>
      [false, true].map((sceneIndex) => {
        const defines = {
          ...variant.defines,
          GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
          EXTENDED_LIGHTING_AVAILABLE: false,
        };
        const sorted = Object.entries(defines).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        const definesKey = sorted.every(([, value]) => value)
          ? ''
          : sorted.map(([key, value]) => `${key}=${value}`).join('+');
        return {
          defines,
          definesKey,
          receipt: createStandardPbrArtifactReceipt(false, variant.defines.VERTEX_COLOR_AVAILABLE),
          composedWgsl: `${variant.composedWgsl}\n// scene-index: ${sceneIndex}`,
        };
      }),
  );
  const manifestUrl = `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  const transmissionSources = new Set<string>(
    standard.variants
      .filter(
        (variant: { defines: Record<string, boolean> }) =>
          variant.defines.TRANSMISSION_AVAILABLE &&
          !variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE,
      )
      .map((variant: { composedWgsl: string }) => variant.composedWgsl),
  );
  const modules: Array<{
    device: RhiDevice;
    mode: 'async' | 'immediate';
    label: string;
    source: string;
    module: ShaderModule;
  }> = [];
  const requests: Array<{
    device: RhiDevice;
    mode: 'async' | 'immediate';
    label: string;
    source: string;
  }> = [];
  const pipelines = new Map<RenderPipeline, ShaderModule>();
  const devices: RhiDevice[] = [];
  let lose: ((info: { reason: 'unknown'; message: string }) => void) | undefined;
  const loss = new Promise<{ reason: 'unknown'; message: string }>((resolve) => {
    lose = resolve;
  });
  const backend: RhiBackendPack = {
    rhi: {
      ...rhi,
      requestAdapter: async (...args) => {
        const result = await rhi.requestAdapter(...args);
        if (!result.ok) return result;
        const adapter = result.value;
        Object.defineProperty(adapter, 'limits', {
          value: { ...adapter.limits, maxSampledTexturesPerShaderStage: 16 },
        });
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (...request) => {
          const created = await requestDevice(...request);
          if (!created.ok) return created;
          const device = created.value;
          Object.defineProperty(device, 'limits', {
            value: { ...device.limits, maxSampledTexturesPerShaderStage: 16 },
          });
          devices.push(device);
          const createPipeline = device.createRenderPipeline.bind(device);
          device.createRenderPipeline = (descriptor) => {
            const pipeline = createPipeline(descriptor);
            if (pipeline.ok && descriptor.fragment !== undefined)
              pipelines.set(pipeline.value, descriptor.fragment.module);
            return pipeline;
          };
          return created;
        };
        return result;
      },
    },
    instrumentation: { deviceLost: (device) => (device === devices[0] ? loss : device.lost) },
    createShaderModule: async (device, descriptor) => {
      requests.push({
        device,
        mode: 'async',
        label: descriptor.label ?? '',
        source: descriptor.code,
      });
      const result = await rhi.createShaderModule(device, descriptor);
      if (result.ok)
        modules.push({
          device,
          mode: 'async',
          label: descriptor.label ?? '',
          source: descriptor.code,
          module: result.value,
        });
      return result;
    },
    ...(immediate
      ? ({
          createShaderModuleImmediate: (device, descriptor) => {
            requests.push({
              device,
              mode: 'immediate',
              label: descriptor.label ?? '',
              source: descriptor.code,
            });
            const result = rhi.createShaderModuleImmediate(device, descriptor);
            if (result.ok)
              modules.push({
                device,
                mode: 'immediate',
                label: descriptor.label ?? '',
                source: descriptor.code,
                module: result.value,
              });
            return result;
          },
        } satisfies Partial<RhiBackendPack>)
      : {}),
  };
  const targetModules = (device: RhiDevice | undefined, mode: 'async' | 'immediate') =>
    modules.filter(
      (entry) =>
        entry.device === device &&
        entry.mode === mode &&
        entry.label.startsWith('module-forgeax::default-standard-pbr#') &&
        transmissionSources.has(entry.source),
    );
  const asyncTargetRequests = () =>
    requests.filter(
      (entry) =>
        entry.mode === 'async' &&
        entry.label.startsWith('module-forgeax::default-standard-pbr#') &&
        transmissionSources.has(entry.source),
    );
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    undefined,
    { shaderManifestUrl: manifestUrl },
    backend,
  );
  const indexedDraws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  const boundPipelines = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'setPipeline');
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const attached = attachment.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: DirectionalLight,
          data: { castShadow: true, direction: [0, -1, -1], color: [1, 1, 1], intensity: 1 },
        },
      )
      .unwrap();
    const material = assets
      .create(Materials.standard({ transmission: 1, roughness: 0, baseColor: [1, 1, 1, 1] }))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    for (let generation = 0; generation < 2; generation++) {
      if (generation === 1) {
        lose?.({ reason: 'unknown', message: '16-slot transmission recovery regression' });
        await Promise.resolve();
        await Promise.resolve();
        expect(renderer.health().reason).toBe('device-lost');
        const recovery = await renderer.recover();
        if (!recovery.ok) throw new Error(JSON.stringify(recovery.error));
        errors.length = 0;
      }
      const device = devices[generation];
      expect(device?.limits.maxSampledTexturesPerShaderStage).toBe(16);
      const beforeRequests = requests.length;
      const beforeAsyncRequests = asyncTargetRequests().length;
      const beforeAsync = targetModules(device, 'async').length;
      if (immediate) expect(beforeAsync).toBe(0);
      else if (generation === 0) expect(beforeAsync).toBeGreaterThan(0);
      else expect(beforeAsync).toBe(1);
      // Boot and recovery keep synchronous lanes lazy; each generation's first
      // recorded frame prepares the lane it actually uses.
      expect(targetModules(device, 'immediate')).toHaveLength(0);
      world.update().unwrap();
      indexedDraws.mockClear();
      boundPipelines.mockClear();
      // RhiNull verifies module selection and recording; Dawn owns binding and pixel acceptance.
      const draw = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
        geometryLane: 'direct',
      });
      if (!draw.ok) throw new Error(JSON.stringify(draw.error));
      expect(productionPrepare.mock.results.at(-1)?.value).toMatchObject({
        ok: true,
        value: undefined,
      });
      expect(productionPrepare.mock.calls.at(-1)?.[0].scene?.plan.batches.length).toBeGreaterThan(
        0,
      );
      expect(errors).toEqual([]);
      expect(asyncTargetRequests()).toHaveLength(beforeAsyncRequests);
      if (generation === 1) expect(requests).toHaveLength(beforeRequests + (immediate ? 1 : 0));
      expect(targetModules(device, 'async')).toHaveLength(beforeAsync);
      expect(targetModules(device, 'immediate')).toHaveLength(immediate ? 1 : 0);
      const targetHandles = new Set(
        targetModules(device, immediate ? 'immediate' : 'async').map((entry) => entry.module),
      );
      const drawPasses = indexedDraws.mock.contexts as readonly RhiNullRenderPassEncoder[];
      const drewTransmission = drawPasses.some((pass, drawIndex) => {
        if (pass.passName !== 'transmission-forward') return false;
        const prior = boundPipelines.mock.contexts
          .flatMap((context, index) =>
            context === pass &&
            (boundPipelines.mock.invocationCallOrder[index] ?? Infinity) <
              (indexedDraws.mock.invocationCallOrder[drawIndex] ?? -1)
              ? [index]
              : [],
          )
          .at(-1);
        const pipeline = prior === undefined ? undefined : boundPipelines.mock.calls[prior]?.[0];
        const module = pipeline === undefined ? undefined : pipelines.get(pipeline);
        return module !== undefined && targetHandles.has(module);
      });
      expect(
        drewTransmission,
        JSON.stringify({
          generation,
          requested: requests.slice(beforeRequests).map(({ mode, label }) => ({ mode, label })),
          draws: drawPasses.map((pass) => pass.passName),
        }),
      ).toBe(true);
    }
    expect(devices).toHaveLength(2);
    expect(devices[1]).not.toBe(devices[0]);
  } finally {
    indexedDraws.mockRestore();
    boundPipelines.mockRestore();
    productionPrepare.mockRestore();
    await renderer.dispose();
  }
});
