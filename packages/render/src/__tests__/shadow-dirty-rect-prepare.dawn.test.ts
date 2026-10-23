import { World } from '@forgeax/engine-ecs';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RhiDevice,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import type { ParamSchemaEntry, TextureAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { GpuResidencyCache } from '../device/gpu-residency';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import { createSkylightFallback, skylightBindGroupResources } from '../ibl/skylight-bind-group';
import { buildBindGroupLayoutDescriptor } from '../pbr-pipeline';
import type { PipelineSpec } from '../pipeline-spec-types';
import { worldRenderResources } from '../publication/resource-scope';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';
import { MaterialBgAssemblyCache } from '../record/material-bg-assembly-cache';
import { getOrCreateFromChain } from '../record/mesh-ssbo';
import { MATERIAL_PER_ENTITY_STRIDE, MATERIAL_UNIFORM_BYTES } from '../record/render-context';
import { encodeStaticShadowPass } from '../record/shadow-pass';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { updateShadowView } from './helpers/gpu-input-read-domain';
import { testAssets } from './helpers/runtime-assets';
import { nativeDeviceFixture } from './native-device-fixture';
import { shadowBundleCommands } from './shadow-bundle.fixture';
import { preparedShadowFixture } from './shadow-indirect.fixture';
import { shadowSourceFixture, shadowSourceSnapshot } from './shadow-source-content.fixture';

const SIZE = 64;
const ROW_BYTES = 256;
const MATERIAL_OFFSET = 2048;
const WITNESS = `
@group(1) @binding(0) var<uniform> depth: vec4<f32>;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], depth.x, 1.0);
}
`;
const TEXTURED_WITNESS = `${WITNESS.replace('fn vs_main', 'fn vs_scene_index')}
@group(1) @binding(1) var depthSampler: sampler;
@group(1) @binding(2) var depthTexture: texture_2d<f32>;
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @builtin(frag_depth) f32 {
  return position.z * textureSample(depthTexture, depthSampler, vec2<f32>(0.5)).r;
}
`;

/** Real material assembly and residency; the native pass below consumes its returned group. */
function customMaterialFixture(device: RhiDevice) {
  const world = new World();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = testAssets(world);
  const fallback = createSkylightFallback(device, device.queue);
  const materialBuffer = device
    .createBuffer({ size: 2 * MATERIAL_PER_ENTITY_STRIDE, usage: 8 | 64 })
    .unwrap();
  const sceneBuffer = device.createBuffer({ size: 256, usage: 128 }).unwrap();
  const schema: ParamSchemaEntry[] = [
    { name: 'depth', type: 'f32' },
    { name: 'depthTexture', type: 'texture2d' },
  ];
  let parameters = { depth: 0 };
  const shaderId = 'test::accepted-shadow-material';
  const layout = device
    .createBindGroupLayout(
      buildBindGroupLayoutDescriptor(
        {
          shader: { id: shaderId, passKind: 'shadow-caster', variantSet: undefined },
        } as PipelineSpec,
        {
          kind: 'pbr-material-merged',
          materialParamSchema: schema,
          caps: {
            storageBuffer: true,
            transmissionBackdrop: transmissionBackdropAvailable(
              device.limits.maxSampledTexturesPerShaderStage,
            ),
          },
        },
      ),
    )
    .unwrap();
  const source: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array([255, 255, 255, 255]),
  };
  const texture = assets.create(source).unwrap();
  const material = {
    ...defaultMaterialSnapshot(17),
    materialShaderId: shaderId,
    materialParamSchema: schema,
    textureHandles: new Map([['depthTexture', texture]]),
  };
  const receipt = createStandardPbrArtifactReceipt();
  const artifact = {
    material: shaderId,
    pass: 'ShadowCaster',
    program: createMaterialShaderProgram(TEXTURED_WITNESS),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: [],
    receipt,
    variantSet: 'GPU_SCENE_AVAILABLE=true',
  };
  const queries = {
    artifact: vi.fn(() => artifact),
    schema: vi.fn(() => schema),
    layout: vi.fn(() => layout),
  };
  const deps = {
    runtime: {
      device,
      preparedMaterialParameters: () => parameters,
      getMaterialShaderArtifact: queries.artifact,
      getParamSchema: queries.schema,
      getMaterialBindGroupLayout: queries.layout,
    },
    pipelineState: {
      materialBindGroupLayout: layout,
      materialUniformBuffer: { buffer: materialBuffer },
      meshStorageBuffer: { buffer: sceneBuffer },
      defaultSampler: fallback.sampler,
      defaultWhiteTextureView: fallback.brdfLutView,
      defaultNormalTextureView: fallback.brdfLutView,
      fallbackTextureView: fallback.brdfLutView,
      skylightFallback: fallback,
    },
    world: worldRenderResources(world),
    store,
    materialSlice: MATERIAL_UNIFORM_BYTES,
    videoHighPerfAvailable: false,
    skylightResources: skylightBindGroupResources(fallback),
    sceneMaterialBuffer: sceneBuffer,
    materialBgShared: new Map(),
    materialBgAssemblyCache: new MaterialBgAssemblyCache(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
  } as unknown as PerSubmeshMaterialBgDeps;
  const group = buildPerSubmeshMaterialBg(deps, material, 1);
  const neutralGroup = buildPerSubmeshMaterialBg(
    deps,
    {
      ...defaultMaterialSnapshot(18),
      materialShaderId: shaderId,
      materialParamSchema: schema,
    },
    0,
  );
  return {
    deps,
    material,
    artifact,
    queries,
    group,
    neutralGroup,
    layout,
    materialBuffer,
    sceneBuffer,
    fallback,
    setDepth(depth: number) {
      parameters = { depth };
    },
    replaceTexture() {
      const previous = store.getTextureGpuView(texture, worldRenderResources(world));
      store.invalidateTexture(texture, worldRenderResources(world));
      const replacement = store
        .ensureResident(texture, source, worldRenderResources(world))
        .unwrap();
      expect(replacement.view).not.toBe(previous);
    },
    dispose() {
      store.destroyAll();
      for (const buffer of [materialBuffer, sceneBuffer, fallback.intensityBuffer])
        device.destroyBuffer(buffer).unwrap();
      for (const texture of [
        fallback.irradianceTexture,
        fallback.prefilterTexture,
        fallback.brdfLutTexture,
      ])
        device.destroyTexture(texture).unwrap();
    },
  };
}

type CustomMaterial = ReturnType<typeof customMaterialFixture>;
type ShadowFixture = ReturnType<typeof preparedShadowFixture>;
type ShadowSource = ReturnType<typeof shadowSourceFixture>;
type ShaderModuleFactory = Parameters<typeof preparedShadowFixture>[0]['shaderModuleFactory'];

const EXPLICIT_DIRTY = {
  size: SIZE,
  rects: [
    { x0: 0, y0: 0, x1: 0.25, y1: 0.5 },
    { x0: 0.75, y0: 0.5, x1: 1, y1: 1 },
  ],
};

function createWitnessPipeline(
  device: RhiDevice,
  shaderModuleFactory: ShaderModuleFactory,
  custom: CustomMaterial | undefined,
  bindGroupLayouts: readonly BindGroupLayout[],
) {
  const module = shaderModuleFactory
    .createShaderModule({ code: custom === undefined ? WITNESS : TEXTURED_WITNESS })
    .unwrap();
  return device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [...bindGroupLayouts] }).unwrap(),
      vertex: {
        module,
        entryPoint: custom === undefined ? 'vs_main' : 'vs_scene_index',
        buffers: [],
      },
      ...(custom === undefined ? {} : { fragment: { module, entryPoint: 'fs_main', targets: [] } }),
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    })
    .unwrap();
}

/**
 * The existing prepared-frame fixture carries real physical groups here.
 * Only its material is a depth witness; encodeStaticShadowPass, its clear,
 * binding preparation and every indirect draw are the production functions.
 */
function createShadowRig(device: RhiDevice, custom: CustomMaterial | undefined) {
  const buffer = device.createBuffer({ size: 4096, usage: 8 | 32 | 64 | 256 }).unwrap();
  const dynamicLayout = (count: number) =>
    device
      .createBindGroupLayout({
        entries: Array.from({ length: count }, (_, binding) => ({
          binding,
          visibility: 1,
          buffer: { type: 'uniform' as const, hasDynamicOffset: true, minBindingSize: 16 },
        })),
      })
      .unwrap();
  const group = (layout: BindGroupLayout, count: number, offset = 0) =>
    device
      .createBindGroup({
        layout,
        entries: Array.from({ length: count }, (_, binding) => ({
          binding,
          resource: { kind: 'buffer' as const, value: { buffer, offset, size: 16 } },
        })),
      })
      .unwrap();
  const viewLayout = dynamicLayout(2);
  const materialLayout = custom?.layout ?? dynamicLayout(1);
  const meshLayout = dynamicLayout(1);
  const visibleLayout = dynamicLayout(0);
  const shaderModuleFactory = {
    createShaderModule: (desc: Parameters<typeof createShaderModuleImmediate>[1]) =>
      createShaderModuleImmediate(device, desc),
  };
  const fixture = preparedShadowFixture({
    device,
    buffer,
    layout: materialLayout,
    view: group(viewLayout, 2),
    shaderModuleFactory,
    shared: {
      indirectOffset: 0,
      pipeline: createWitnessPipeline(device, shaderModuleFactory, custom, [
        viewLayout,
        materialLayout,
        meshLayout,
        visibleLayout,
      ]),
      vertexBuffer: buffer,
      materialGroup: custom?.neutralGroup ?? group(materialLayout, 1, MATERIAL_OFFSET),
      meshBindGroup: group(meshLayout, 1),
      visibleBindGroups: [group(visibleLayout, 0)],
      deformation: 'rigid',
    },
  });
  if (custom !== undefined) adoptCustomMaterial(fixture, custom);
  const commands = new Uint32Array(fixture.batches.length * 5);
  for (let index = 0; index < fixture.batches.length; index++)
    commands.set([3, 1, 0, 0, 0], index * 5);
  device.queue.writeBuffer(buffer, 0, commands).unwrap();
  return { buffer, fixture, shaderModuleFactory };
}

/** Route the prepared fixture through the custom material's real assembly path. */
function adoptCustomMaterial(fixture: ShadowFixture, custom: CustomMaterial): void {
  const { deps } = custom;
  Object.assign(fixture.context.pipelineState, deps.pipelineState);
  Object.assign(fixture.context.runtime, deps.runtime);
  Object.assign(fixture.context, {
    world: deps.world,
    store: deps.store,
    materialBgAssemblyCache: deps.materialBgAssemblyCache,
    gpuDrivenStandardPbrFrameResources: { sceneMaterialBuffer: custom.sceneBuffer },
  });
  Object.assign(fixture.context.frameState, { materialBgShared: deps.materialBgShared });
  const projections = fixture.projections as unknown as Map<number, GpuDrivenShadowBatchProjection>;
  for (const [id, projection] of projections)
    projections.set(id, {
      ...projection,
      material: custom.material,
      shadowArtifact: custom.artifact,
    });
  const state = fixture.context.pipelineState;
  // Seed the already prepared opaque binding with its actual physical
  // resources. The custom branch must still call the real material builder.
  getOrCreateFromChain(
    fixture.shadowMaterialBindGroups,
    [
      state.materialBindGroupLayout,
      meshSsboBufferBinding(state.materialUniformBuffer, 0).buffer,
      state.defaultSampler,
      state.defaultNormalTextureView,
      state.fallbackTextureView,
      custom.sceneBuffer,
      custom.fallback,
    ],
    'shadow-material-singleton',
    () => custom.neutralGroup,
    fixture.context.bindGroupCounts,
  );
}

/**
 * Move, create and remove casters on the changed-source path and assert the
 * pool's invalidation evidence. Returns frame 0's resource generation.
 */
function advanceShadowSource(
  source: ShadowSource,
  frame: number,
  sourceResourceGeneration: number | undefined,
): number | undefined {
  if (frame === 1) source.update(shadowSourceSnapshot(1, -14, 4));
  else if (frame > 1 && frame % 2 === 0)
    source.update({ ...shadowSourceSnapshot(3, 20, 5), mobility: 'static' });
  else if (frame > 1) source.apply([{ kind: 'remove', worldId: 0, entityKey: 3 }]);
  const input = source.input();
  const update = updateShadowView(source.pool, input).unwrap();
  expect(update.cache).toBe('invalidated');
  if (frame === 0) return update.view.inspect().resourceGeneration;
  if (frame === 1) {
    expect(input.ignoredChangeSlots.size).toBe(1);
    expect(source.pool.invalidationReason(source.identity)).toBe('membership-changed');
    expect(source.pool.dirtyRects(source.identity)).toHaveLength(2);
  }
  if (frame === 2) {
    // Adding a different static batch grows caster input allocations,
    // while the retained depth attachment below remains the same.
    expect(update.view.inspect().resourceGeneration).toBeGreaterThan(
      sourceResourceGeneration ?? -1,
    );
    expect(source.pool.dirtyRects(source.identity)).toHaveLength(1);
  }
  return sourceResourceGeneration;
}

/** Frame 0 redraws everything; later frames redraw only explicit or source-derived regions. */
function shadowDirtyRegion(frame: number, source: ShadowSource | undefined) {
  if (frame === 0) return undefined;
  if (source === undefined) return EXPLICIT_DIRTY;
  return { size: SIZE, rects: source.pool.dirtyRects(source.identity) ?? [] };
}

/** Observe the material group a custom-material shadow pass binds, directly or through bundles. */
function spyMaterialBinding(pass: RhiRenderPassEncoder) {
  const bindings = vi.spyOn(pass, 'setBindGroup');
  const bundles = vi.spyOn(pass, 'executeBundles');
  return {
    bound: (): unknown => {
      const encoded = bundles.mock.calls.flatMap(([handles]) => shadowBundleCommands(handles));
      return (
        encoded.filter((row) => row.method === 'setBindGroup' && row.args[0] === 1).at(-1)
          ?.args[1] ?? bindings.mock.calls.filter(([index]) => index === 1).at(-1)?.[1]
      );
    },
    restore: () => {
      bindings.mockRestore();
      bundles.mockRestore();
    },
  };
}

/**
 * The custom material keeps its prepared group on every frame except the
 * frame-30 texture replacement, which must rebuild it once. Returns the bound group.
 */
function expectCustomMaterialBinding(
  custom: CustomMaterial,
  frame: number,
  observations: number,
  bound: unknown,
  previousMaterial: BindGroup | undefined,
): BindGroup {
  for (const [name, query] of Object.entries(custom.queries))
    expect(query, name).toHaveBeenCalledTimes(observations);
  expect(bound).toBeDefined();
  if (frame === 30) expect(bound).not.toBe(previousMaterial);
  else expect(bound).toBe(previousMaterial ?? custom.group);
  return bound as BindGroup;
}

/**
 * These pixel footprints are independent of the rectangles returned by the
 * pool: x=-10 -> -14 spans columns 16..23, and the created/removed x=20
 * caster spans columns 50..53.
 */
function expectedShadowDepth(
  x: number,
  y: number,
  frame: number,
  value: number,
  changedSource: boolean,
): number {
  if (!changedSource) {
    const explicit =
      frame > 0 && ((x < SIZE / 4 && y < SIZE / 2) || (x >= (3 * SIZE) / 4 && y >= SIZE / 2));
    return explicit ? value : 0.75;
  }
  const row = y >= 30 && y < 34;
  if (frame > 1 && x >= 50 && x < 54 && row) return value;
  if (frame > 0 && x >= 16 && x < 24 && row) return 0.25;
  return 0.75;
}

function expectShadowDepthPixels(
  pixels: Float32Array,
  frame: number,
  value: number,
  changedSource: boolean,
): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      expect(pixels[y * (ROW_BYTES / 4) + x], `frame ${frame}, pixel ${x},${y}`).toBeCloseTo(
        expectedShadowDepth(x, y, frame, value, changedSource),
        5,
      );
    }
  }
}

async function expectReadbackDepth(
  readback: Buffer,
  frame: number,
  value: number,
  changedSource: boolean,
): Promise<void> {
  const mapped = (await readback.mapAsync(1)).unwrap();
  try {
    expectShadowDepthPixels(
      new Float32Array(mapped.getMappedRange().unwrap()),
      frame,
      value,
      changedSource,
    );
  } finally {
    mapped.unmap();
  }
}

it.each([
  { mode: 'explicit regions', reuseAdjacentShadow: false },
  { mode: 'changed scene source', reuseAdjacentShadow: false },
  { mode: 'explicit regions', reuseAdjacentShadow: true },
  { mode: 'changed scene source', reuseAdjacentShadow: true },
])('records real static shadow partial updates from $mode for 60 frames (owned reuse: $reuseAdjacentShadow)', async ({
  mode,
  reuseAdjacentShadow,
}) => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const custom = mode === 'explicit regions' ? customMaterialFixture(device) : undefined;
  const { buffer, fixture, shaderModuleFactory } = createShadowRig(device, custom);
  const depth = device
    .createTexture({
      size: { width: SIZE, height: SIZE },
      format: 'depth32float',
      usage: 16 | 1,
    })
    .unwrap();
  const depthView = device.createTextureView(depth, {}).unwrap();
  const readback = device.createBuffer({ size: ROW_BYTES * SIZE, usage: 1 | 8 }).unwrap();
  const source =
    mode === 'changed scene source' ? shadowSourceFixture(device, shaderModuleFactory) : undefined;
  let sourceResourceGeneration: number | undefined;
  let previousMaterial: BindGroup | undefined;
  try {
    for (let frame = 0; frame < 60; frame++) {
      if (custom !== undefined) {
        for (const query of Object.values(custom.queries)) query.mockClear();
        if (frame === 30) custom.replaceTexture();
      }
      if (source !== undefined)
        sourceResourceGeneration = advanceShadowSource(source, frame, sourceResourceGeneration);
      const value = frame === 0 ? 0.75 : frame % 2 === 1 ? 0.25 : 0.5;
      custom?.setDepth(value);
      device.queue
        .writeBuffer(
          custom?.materialBuffer ?? buffer,
          custom === undefined ? MATERIAL_OFFSET : 0,
          Float32Array.of(value, 0, 0, 0),
        )
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depthView,
          depthLoadOp: frame === 0 ? 'clear' : 'load',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      const binding = custom === undefined ? undefined : spyMaterialBinding(pass);
      fixture.pipelineLookup.mockClear();
      encodeStaticShadowPass(
        fixture.context,
        pass,
        { kind: 'directional', index: 0 },
        shadowDirtyRegion(frame, source),
        reuseAdjacentShadow ? true : undefined,
      );
      // Raw calls retain every observation. The Renderer-owned path can
      // reuse adjacent accepted facts across the same 64 physical draws.
      const observations = reuseAdjacentShadow ? 1 : fixture.batches.length;
      expect(fixture.pipelineLookup).toHaveBeenCalledTimes(observations);
      if (custom !== undefined && binding !== undefined) {
        previousMaterial = expectCustomMaterialBinding(
          custom,
          frame,
          observations,
          binding.bound(),
          previousMaterial,
        );
        binding.restore();
      }
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: depth },
        { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: SIZE },
        { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      source?.pool._commitResourceReplacement();
      await expectReadbackDepth(readback, frame, value, source !== undefined);
    }
    if (source !== undefined)
      expect(updateShadowView(source.pool, source.input()).unwrap().cache).toBe('hit');
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    source?.dispose();
    custom?.dispose();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(depth).unwrap();
    device.destroyBuffer(buffer).unwrap();
  }
});
