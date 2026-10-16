import { DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { VIDEO_SOURCE_PROVIDER_KEY } from '@forgeax/engine-graphics-extras';
import {
  type BindGroup,
  type BindGroupLayoutEntry,
  RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import {
  err,
  ok,
  type ParamSchemaEntry,
  type SamplerAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { GpuResidencyCache } from '../device/gpu-residency';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import { createSkylightFallback } from '../ibl/skylight-bind-group';
import { buildPbrPipelineLayouts } from '../pbr-pipeline';
import * as materialBuilder from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { encodeStaticShadowPass } from '../record/shadow-pass';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';
import { CanvasTexture } from '../textures/canvas-texture';
import { replayShadowBundles } from './shadow-bundle.fixture';
import { preparedShadowFixture } from './shadow-indirect.fixture';

vi.mock('../record/main-pass-material', async (importOriginal) => {
  const original = await importOriginal<typeof materialBuilder>();
  return { ...original, buildPerSubmeshMaterialBg: vi.fn(original.buildPerSubmeshMaterialBg) };
});

async function fixture(textured = false, reuseAdjacentShadow = true) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const fallback = createSkylightFallback(device, device.queue);
  const buffer = device.createBuffer({ size: 4096, usage: 8 | 64 | 128 | 256 }).unwrap();
  const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
    })
    .unwrap();
  const entries: BindGroupLayoutEntry[] = [
    { binding: 1, visibility: 4, texture: { viewDimension: 'cube', sampleType: 'float' } },
    { binding: 2, visibility: 4, sampler: { type: 'filtering' } },
    { binding: 3, visibility: 4, texture: { viewDimension: 'cube', sampleType: 'float' } },
    { binding: 4, visibility: 4, sampler: { type: 'filtering' } },
    { binding: 5, visibility: 4, texture: { viewDimension: '2d', sampleType: 'float' } },
    { binding: 6, visibility: 4, buffer: { type: 'uniform' } },
  ];
  if (transmissionBackdropAvailable(device.limits.maxSampledTexturesPerShaderStage))
    entries.push(
      { binding: 7, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 8, visibility: 4, texture: { viewDimension: '2d', sampleType: 'float' } },
    );
  if (textured) for (const entry of entries) entry.binding += 2;
  entries.push(
    { binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize: 256 } },
    { binding: 46, visibility: 4, buffer: { type: 'read-only-storage' } },
    { binding: 47, visibility: 4, texture: { viewDimension: 'cube', sampleType: 'float' } },
  );
  if (textured)
    entries.push(
      { binding: 1, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 2, visibility: 4, texture: { viewDimension: '2d', sampleType: 'float' } },
    );
  let layout = device.createBindGroupLayout({ entries }).unwrap();
  const f = preparedShadowFixture({
    device,
    buffer,
    layout: emptyLayout,
    view: group,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
    shared: {
      indirectOffset: 0,
      pipeline,
      vertexBuffer: buffer,
      materialGroup: group,
      meshBindGroup: group,
      visibleBindGroups: [group],
      deformation: 'rigid',
    },
  });
  const receipt = createStandardPbrArtifactReceipt();
  const artifact = {
    material: 'game::shadow',
    pass: 'ShadowCaster',
    program: createMaterialShaderProgram(''),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: [],
    receipt,
  };
  const material = { ...defaultMaterialSnapshot(17), materialShaderId: 'game::shadow' };
  const schema: ParamSchemaEntry[] = textured ? [{ name: 'surfaceMap', type: 'texture2d' }] : [];
  const queries = {
    artifact: vi.fn(() => artifact),
    schema: vi.fn(() => schema),
    layout: vi.fn(() => layout),
  };
  Object.assign(f.context.runtime, {
    getMaterialShaderArtifact: queries.artifact,
    getParamSchema: queries.schema,
    getMaterialBindGroupLayout: queries.layout,
  });
  Object.assign(f.context.pipelineState, {
    skylightFallback: fallback,
    defaultSampler: fallback.sampler,
    defaultWhiteTextureView: fallback.brdfLutView,
  });
  f.seedMaterial(group);
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused cubemap');
    },
    device.caps,
  );
  const world = new World();
  const dynamic = new DynamicTextureStore();
  dynamic.configureGpuDevice(device);
  Object.assign(f.context.runtime, {
    dynamicTextureStore: dynamic,
    errorRegistry: { fire: vi.fn() },
  });
  Object.assign(f.context, {
    world,
    store,
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    gpuDrivenStandardPbrFrameResources: { sceneMaterialBuffer: buffer },
  });
  Object.assign(f.context.frameState, { materialBgShared: new Map() });
  const projections = f.projections as unknown as Map<number, GpuDrivenShadowBatchProjection>;
  for (const [id, projection] of projections)
    projections.set(id, {
      ...projection,
      material,
      shadowArtifact: artifact,
      materialEntityKey: id,
    });
  let bound: BindGroup | undefined;
  let mesh: BindGroup | undefined;
  const draws: {
    offset: number;
    group: BindGroup | undefined;
    mesh: BindGroup | undefined;
  }[] = [];
  const pass = {
    executeBundles(bundles: Iterable<import('@forgeax/engine-rhi').RenderBundle>) {
      return replayShadowBundles(pass, bundles);
    },
    setPipeline() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    setBindGroup(index: number, value: BindGroup) {
      if (index === 1) bound = value;
      if (index === 2) mesh = value;
    },
    drawIndirect(_buffer: unknown, offset: number) {
      draws.push({ offset, group: bound, mesh });
    },
    drawIndexedIndirect(_buffer: unknown, offset: number) {
      draws.push({ offset, group: bound, mesh });
    },
  } as unknown as RhiRenderPassEncoder;
  vi.mocked(materialBuilder.buildPerSubmeshMaterialBg).mockClear();
  const create = vi.spyOn(device, 'createBindGroup');
  return {
    create,
    ...f,
    device,
    buffer,
    store,
    world,
    dynamic,
    fallback,
    projections,
    material,
    artifact,
    queries,
    draws,
    run: () =>
      encodeStaticShadowPass(
        f.context,
        pass,
        { kind: 'directional', index: 0 },
        undefined,
        reuseAdjacentShadow,
      ),
    replaceLayout() {
      layout = device.createBindGroupLayout({ entries }).unwrap();
    },
    setMaterial(material: MaterialSnapshot) {
      for (const [id, projection] of projections) projections.set(id, { ...projection, material });
    },
    beforeBatch(index: number, action: () => void) {
      const id = defined(f.batches[index]).batchId;
      const get = projections.get.bind(projections);
      vi.spyOn(projections, 'get').mockImplementation((key) => {
        if (key === id) action();
        return get(key);
      });
    },
    binding(group: BindGroup | undefined, binding: number) {
      const call = create.mock.calls.find((_, index) => {
        const result = create.mock.results[index];
        return result?.type === 'return' && result.value.ok && result.value.value === group;
      });
      return [...defined(call)[0].entries].find((entry) => entry.binding === binding)?.resource;
    },
    dispose() {
      dynamic.destroyAll();
      store.destroyAll();
      device.destroyBuffer(buffer).unwrap();
      device.destroyBuffer(fallback.intensityBuffer).unwrap();
      device.destroyTexture(fallback.irradianceTexture).unwrap();
      device.destroyTexture(fallback.prefilterTexture).unwrap();
      device.destroyTexture(fallback.brdfLutTexture).unwrap();
    },
  };
}

it('resolves shared shadow material bindings once per invocation while recording every batch', async () => {
  const f = await fixture();
  try {
    for (let frame = 0; frame < 60; frame++) f.run();
    expect(f.draws).toHaveLength(3840);
    expect(f.draws.every((draw) => draw.group === f.draws[0]?.group)).toBe(true);
    expect(
      f.create.mock.calls.filter(([descriptor]) => descriptor.label === 'pbr-material-skylight-bg'),
    ).toHaveLength(1);
    expect([
      vi.mocked(materialBuilder.buildPerSubmeshMaterialBg).mock.calls.length,
      f.queries.artifact.mock.calls.length,
      f.queries.schema.mock.calls.length,
      f.queries.layout.mock.calls.length,
    ]).toEqual([60, 60, 60, 60]);
  } finally {
    f.dispose();
  }
});

it.each([
  'alpha-mask',
  'displacement',
] as const)('reuses the canonical Standard binding for %s casters', async (kind) => {
  const f = await fixture();
  try {
    const layouts = buildPbrPipelineLayouts(f.device, {
      storageBuffer: true,
      transmissionBackdrop: transmissionBackdropAvailable(
        f.device.limits.maxSampledTexturesPerShaderStage,
      ),
    });
    f.queries.schema.mockReturnValue([...STANDARD_PIPELINE_PARAM_SCHEMA]);
    f.queries.layout.mockReturnValue(layouts.materialBgl);
    Object.assign(f.context.pipelineState, {
      defaultNormalTextureView: f.fallback.brdfLutView,
      fallbackTextureView: f.fallback.brdfLutView,
    });
    f.seedMaterial(
      f.device
        .createBindGroup({ layout: f.context.pipelineState.materialBindGroupLayout, entries: [] })
        .unwrap(),
    );
    const material = {
      ...f.material,
      ...(kind === 'displacement'
        ? { authoredTextureFields: new Set(['displacementTexture']) }
        : {}),
    };
    const shadowArtifact = { ...f.artifact, material: 'forgeax::default-shadow-caster' };
    for (const [id, projection] of f.projections)
      f.projections.set(id, { ...projection, material, shadowArtifact });
    if (kind === 'alpha-mask') for (const batch of f.batches) batch.key.admission = 'alpha-mask';
    for (let frame = 0; frame < 60; frame++) f.run();
    expect(f.draws).toHaveLength(3840);
    expect(f.draws.every((draw) => draw.group === f.draws[0]?.group)).toBe(true);
    expect(f.queries.layout).toHaveBeenCalledTimes(60);
    expect(f.queries.schema).toHaveBeenLastCalledWith('forgeax::default-standard-pbr');
  } finally {
    f.dispose();
  }
});

it('queries the layout again on the next invocation and preserves replacement errors and retry', async () => {
  const f = await fixture();
  try {
    f.run();
    const first = f.draws[0]?.group;
    f.replaceLayout();
    f.create.mockImplementationOnce(() => {
      throw new Error('replacement group unavailable');
    });
    expect(f.run).toThrow('replacement group unavailable');
    expect(f.draws).toHaveLength(64);
    f.run();
    expect(f.draws).toHaveLength(128);
    expect(f.draws[64]?.group).not.toBe(first);
    expect(f.draws.slice(64).every((draw) => draw.group === f.draws[64]?.group)).toBe(true);
    expect(f.queries.layout).toHaveBeenCalledTimes(3);
  } finally {
    f.dispose();
  }
});

it('binds A/B/A textures from each selected material instead of retaining the adjacent group', async () => {
  const f = await fixture(true);
  try {
    f.batches.length = 3;
    const textures = [texture(), texture()];
    const residents = textures.map((source) => {
      const handle = f.world.allocSharedRef('TextureAsset', source);
      return { handle, view: f.store.ensureResident(handle, source, f.world).unwrap().view };
    });
    const materials = residents.map(({ handle }) => ({
      ...f.material,
      textureHandles: new Map([['surfaceMap', handle]]),
    }));
    for (const [index, batch] of f.batches.entries()) {
      const projection = defined(f.projections.get(batch.batchId));
      f.projections.set(batch.batchId, { ...projection, material: defined(materials[index % 2]) });
    }
    f.run();
    expect(f.queries.layout).toHaveBeenCalledTimes(3);
    expect(f.draws.map((draw) => f.binding(draw.group, 2))).toEqual(
      [0, 1, 0].map((index) => ({ kind: 'textureView', value: defined(residents[index]).view })),
    );
    expect(f.draws[0]?.group).toBe(f.draws[2]?.group);
  } finally {
    f.dispose();
  }
});

it('keeps current material, mesh bindings and offsets while reusing the pipeline', async () => {
  const f = await fixture(true);
  try {
    f.batches.length = 3;
    const meshGroups = f.batches.map(() =>
      f.device
        .createBindGroup({
          layout: f.device.createBindGroupLayout({ entries: [] }).unwrap(),
          entries: [],
        })
        .unwrap(),
    );
    const textures = Array.from({ length: 4 }, () => {
      const source = texture();
      const handle = f.world.allocSharedRef('TextureAsset', source);
      return { handle, view: f.store.ensureResident(handle, source, f.world).unwrap().view };
    });
    const materials = textures.map(({ handle }, index) => ({
      ...f.material,
      materialHandle: index + 1,
      textureHandles: new Map([['surfaceMap', handle]]),
    }));
    for (const [index, batch] of f.batches.entries()) {
      f.projections.set(batch.batchId, {
        ...defined(f.projections.get(batch.batchId)),
        material: defined(materials[index]),
        meshBindGroup: defined(meshGroups[index]),
      });
      batch.indirectOffset = defined([120, 0, 80][index]);
    }
    f.run();
    expect(f.pipelineLookup).toHaveBeenCalledTimes(1);
    expect(f.draws.map((draw) => draw.mesh)).toEqual(meshGroups);
    expect(f.draws.map((draw) => draw.offset)).toEqual([120, 0, 80]);
    expect(f.draws.map((draw) => f.binding(draw.group, 2))).toEqual(
      textures.slice(0, 3).map(({ view }) => ({ kind: 'textureView', value: view })),
    );
    const middle = defined(f.batches[1]);
    f.projections.set(middle.batchId, {
      ...defined(f.projections.get(middle.batchId)),
      material: defined(materials[3]),
    });
    f.run();
    expect(f.pipelineLookup).toHaveBeenCalledTimes(2);
    expect(f.draws[4]?.group).not.toBe(f.draws[1]?.group);
    expect(f.binding(f.draws[4]?.group, 2)).toEqual({
      kind: 'textureView',
      value: defined(textures[3]).view,
    });
    expect(f.draws.slice(3).map((draw) => draw.mesh)).toEqual(meshGroups);
    expect(f.draws.slice(3).map((draw) => draw.offset)).toEqual([120, 0, 80]);
  } finally {
    f.dispose();
  }
});

it.each([
  'artifact',
  'admission',
] as const)('resolves A/B/A %s changes even when physical resources still match', async (change) => {
  const f = await fixture();
  try {
    f.batches.length = 3;
    const middle = defined(f.batches[1]);
    if (change === 'artifact') {
      const projection = defined(f.projections.get(middle.batchId));
      f.projections.set(middle.batchId, { ...projection, shadowArtifact: { ...f.artifact } });
    } else middle.key.admission = 'alpha-mask';
    f.run();
    expect(f.queries.layout).toHaveBeenCalledTimes(3);
    expect(f.draws).toHaveLength(3);
  } finally {
    f.dispose();
  }
});

it('observes a physical texture replacement within an invocation through the residency epoch', async () => {
  const f = await fixture(true);
  try {
    const source = texture();
    const handle = f.world.allocSharedRef('TextureAsset', source);
    const first = f.store.ensureResident(handle, source, f.world).unwrap();
    f.setMaterial({ ...f.material, textureHandles: new Map([['surfaceMap', handle]]) });
    f.beforeBatch(32, () => {
      f.store.invalidateTexture(handle, f.world);
      f.store.ensureResident(handle, source, f.world).unwrap();
    });
    f.run();
    const next = f.store.getTextureGpuView(handle, f.world);
    expect(next).not.toBe(first.view);
    expect(f.queries.layout).toHaveBeenCalledTimes(2);
    for (const [index, draw] of f.draws.entries())
      expect(f.binding(draw.group, 2)).toEqual({
        kind: 'textureView',
        value: index < 32 ? first.view : next,
      });
  } finally {
    f.dispose();
  }
});

it.each([
  'texture',
  'sampler',
] as const)('retries a temporarily unavailable static %s on the next batch', async (kind) => {
  const f = await fixture(true);
  try {
    const failure = new RhiError({
      code: 'rhi-not-available',
      expected: 'temporary allocation failure',
      hint: 'retry the next material admission',
    });
    if (kind === 'texture') {
      const source = texture();
      const handle = f.world.allocSharedRef('TextureAsset', source);
      f.setMaterial({ ...f.material, textureHandles: new Map([['surfaceMap', handle]]) });
      vi.spyOn(f.device, 'createTexture').mockReturnValueOnce(err(failure));
    } else {
      const source: SamplerAsset = { kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' };
      const handle = f.world.allocSharedRef('SamplerAsset', source);
      f.setMaterial({ ...f.material, samplerHandles: new Map([['surfaceMap', handle]]) });
      vi.spyOn(f.device, 'createSampler').mockReturnValueOnce(err(failure));
    }
    f.run();
    expect(f.draws).toHaveLength(64);
    expect(f.queries.layout).toHaveBeenCalledTimes(2);
    expect(f.draws[0]?.group).not.toBe(f.draws[1]?.group);
    expect(f.draws.slice(1).every((draw) => draw.group === f.draws[1]?.group)).toBe(true);
    expect(f.binding(f.draws[0]?.group, kind === 'texture' ? 2 : 1)).toEqual(
      kind === 'texture'
        ? { kind: 'textureView', value: f.fallback.brdfLutView }
        : { kind: 'sampler', value: f.fallback.sampler },
    );
  } finally {
    f.dispose();
  }
});

it.each([
  'uniform',
  'scene',
] as const)('observes a replaced %s material buffer within the invocation', async (kind) => {
  const f = await fixture();
  const replacement = f.device.createBuffer({ size: 4096, usage: 8 | 64 | 128 | 256 }).unwrap();
  try {
    f.beforeBatch(32, () => {
      if (kind === 'uniform') f.materialBuffer.buffer = replacement;
      else
        Object.assign(f.context, {
          gpuDrivenStandardPbrFrameResources: { sceneMaterialBuffer: replacement },
        });
    });
    f.run();
    expect(f.queries.layout).toHaveBeenCalledTimes(2);
    expect(f.draws[32]?.group).not.toBe(f.draws[0]?.group);
    expect(f.binding(f.draws[32]?.group, kind === 'uniform' ? 0 : 46)).toMatchObject({
      kind: 'buffer',
      value: { buffer: replacement },
    });
  } finally {
    f.device.destroyBuffer(replacement).unwrap();
    f.dispose();
  }
});

it.each([
  'fallback',
  'scene table',
] as const)('does not skip missing %s errors after a successful binding', async (kind) => {
  const f = await fixture();
  try {
    f.beforeBatch(32, () => {
      if (kind === 'fallback') Object.assign(f.context.pipelineState, { skylightFallback: null });
      else Object.assign(f.context, { gpuDrivenStandardPbrFrameResources: undefined });
    });
    expect(f.run).toThrow(kind === 'fallback' ? 'skylight resources' : 'scene material buffer');
    expect(f.draws).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it.each([
  'canvas',
  'video',
] as const)('visits the dynamic %s owner for each batch and binds its resized texture', async (kind) => {
  const f = await fixture(true);
  const canvas = { width: 4, height: 4 } as OffscreenCanvas;
  const canvasTexture = new CanvasTexture(canvas);
  const clip = toShared<'VideoAsset'>(23);
  const video = { videoWidth: 4, videoHeight: 4, readyState: 2 };
  const provider = { getSource: vi.fn(() => video as HTMLVideoElement) };
  try {
    f.world.insertResource(VIDEO_SOURCE_PROVIDER_KEY, provider);
    f.setMaterial({
      ...f.material,
      ...(kind === 'canvas'
        ? { textureSources: new Map([['surfaceMap', canvasTexture.source]]) }
        : { videoTextureFields: new Map([['surfaceMap', clip]]) }),
    });
    const uploads = vi.spyOn(f.dynamic, 'uploadFrame');
    f.beforeBatch(32, () => {
      canvas.width = 8;
      canvasTexture.update();
      video.videoWidth = 8;
    });
    f.run();
    expect(f.queries.layout).toHaveBeenCalledTimes(64);
    expect(uploads).toHaveBeenCalledTimes(64);
    expect(f.draws).toHaveLength(64);
    expect(f.draws[32]?.group).not.toBe(f.draws[0]?.group);
    const view = f.dynamic.getView(kind === 'canvas' ? canvasTexture.source : clip);
    expect(f.binding(f.draws[32]?.group, 2)).toEqual({ kind: 'textureView', value: view });
  } finally {
    canvasTexture.dispose();
    f.dispose();
  }
});

function texture(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64).fill(255),
  };
}

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing shadow test fixture value');
  return value;
}

it('retains every raw material-owner query for adjacent batches', async () => {
  const f = await fixture(false, false);
  try {
    f.run();
    expect(f.draws).toHaveLength(64);
    expect([
      vi.mocked(materialBuilder.buildPerSubmeshMaterialBg).mock.calls.length,
      f.queries.artifact.mock.calls.length,
      f.queries.schema.mock.calls.length,
      f.queries.layout.mock.calls.length,
    ]).toEqual([64, 64, 64, 64]);
  } finally {
    f.dispose();
  }
});
