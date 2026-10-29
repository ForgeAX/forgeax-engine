import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  deriveVertexBufferLayoutFromProjection,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import {
  type CompiledRenderGraph,
  type GraphBuffer,
  type GraphTexture,
  type GraphTextureView,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  RenderPipeline,
  RhiDevice,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';
import { type GpuDrivenPbrProgram, standardPbrProgramKey } from '../gpu-driven/pbr-program';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import {
  shadowViewHasStaticLayer,
  shadowViewIdentityKey,
  shadowViewRasterAccesses,
} from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import type { ShadowViewIdentity } from '../inspection-types';
import { MaterialResource } from '../material-resource';
import {
  buildGpuDrivenPbrInstancesBindGroupLayout,
  buildGpuDrivenPbrPipelineLayout,
  buildPbrPipelineLayouts,
  omittedStandardMaterialBindings,
} from '../pbr-pipeline';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import { BUILTIN_USER_REGION_TEXTURE_FIELDS } from '../record/main-pass-material';
import { MATERIAL_PER_ENTITY_STRIDE } from '../record/render-context';
import {
  type GpuDrivenShadowBatch,
  type GpuDrivenShadowSubmission,
  recordGpuDrivenShadowIndirect,
} from '../record/shadow-pass';
import { VIEW_UNIFORM_BUFFER_SIZE, writeViewUbo } from '../record/view-ubo';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenProjection } from '../render-pipeline';
import type {
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { PersistentRenderScene } from '../scene/render-scene';
import {
  admitPbrDawnFixture,
  verifyRetainedRasterClass,
} from './gpu-driven-raster-class-dawn-fixture';
import { verifyRetainedRasterRouting } from './gpu-driven-raster-routing-dawn-fixture';
import { nativeDeviceFixture } from './native-device-fixture';

const STANDARD_PBR_RECEIPT = createStandardPbrArtifactReceipt();
const ENGINE_SHADER_MANIFEST = await buildEngineShaderManifest();
const STANDARD_PBR_PRODUCER = ENGINE_SHADER_MANIFEST.materialShaders.find(
  ({ identifier }) => identifier === 'forgeax::default-standard-pbr',
);
const STANDARD_PBR_GPU_VARIANT = STANDARD_PBR_PRODUCER?.variants.find(
  ({ defines }) =>
    defines.STORAGE_BUFFER_AVAILABLE === true &&
    defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
    defines.COVERAGE_ONLY === false &&
    defines.VISIBLE_SURFACE_AVAILABLE === false &&
    defines.CLUSTER_FORWARD_AVAILABLE === false &&
    defines.VERTEX_COLOR_AVAILABLE === false &&
    defines.PROBE_BLEND_AVAILABLE === false &&
    defines.EXTENDED_LIGHTING_AVAILABLE === false &&
    defines.TRANSMISSION_AVAILABLE === false &&
    defines.DIRECTIONAL_PCSS_AVAILABLE === false &&
    defines.PROJECTOR_AVAILABLE === false,
);
const STANDARD_PBR_COLORED_GPU_VARIANT = STANDARD_PBR_PRODUCER?.variants.find(
  ({ defines }) =>
    defines.STORAGE_BUFFER_AVAILABLE === true &&
    defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
    defines.COVERAGE_ONLY === false &&
    defines.VISIBLE_SURFACE_AVAILABLE === false &&
    defines.CLUSTER_FORWARD_AVAILABLE === false &&
    defines.VERTEX_COLOR_AVAILABLE === true &&
    defines.PROBE_BLEND_AVAILABLE === false &&
    defines.EXTENDED_LIGHTING_AVAILABLE === false &&
    defines.TRANSMISSION_AVAILABLE === false &&
    defines.DIRECTIONAL_PCSS_AVAILABLE === false &&
    defines.PROJECTOR_AVAILABLE === false,
);
const STANDARD_PBR_COLORED_RECEIPT = createStandardPbrArtifactReceipt(false, true);
const SHADOW_CASTER_PRODUCER = ENGINE_SHADER_MANIFEST.materialShaders.find(
  ({ identifier }) => identifier === 'forgeax::default-shadow-caster',
);
const SHADOW_CASTER_GPU_ALPHA_VARIANT = SHADOW_CASTER_PRODUCER?.variants.find(
  ({ defines }) =>
    defines.STORAGE_BUFFER_AVAILABLE === true &&
    defines.SKINNING_DISABLED === true &&
    defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
    defines.GPU_DRIVEN_SCENE_INDEX_EXPLICIT === false &&
    defines.ALPHA_MASK === true &&
    defines.VERTEX_COLOR_AVAILABLE === false,
);

// Keep the existing 60-frame local/native window and CI lightweight profile.
const STABLE_FRAME_COUNT = 60;

function alphaMaskSnapshot(
  coordinateSet: 1 | 7 | undefined,
  vertexColorAvailable = false,
  assets: AssetRegistry,
): RenderableSnapshot {
  const receipt = vertexColorAvailable ? STANDARD_PBR_COLORED_RECEIPT : STANDARD_PBR_RECEIPT;
  const material = new MaterialResource({
    baseColor: new Float32Array([1, 1, 1]),
    metallic: 0,
    roughness: 1,
    materialHandle: assets
      .create({
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
        values: { baseColor: [1, 1, 1, 1] },
      })
      .unwrap(),
    materialShaderId: 'forgeax::default-standard-pbr',
    passes: [
      {
        name: 'forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' } },
      },
      {
        name: 'shadow',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialProgramKeys: {
      forward: 'forgeax::default-standard-pbr',
      shadow: 'forgeax::default-standard-pbr',
    },
    // Flat normals and disabled displacement isolate the alpha-mask pixel assertion.
    paramSnapshot: { alphaCutoff: 0.5, normalScale: [0, 0], displacementScale: 0 },
    textureHandles: new Map([['baseColorTexture', 1]]) as never,
    samplerHandles: new Map([['baseColorTexture', 2]]) as never,
    ...(coordinateSet !== undefined
      ? {
          textureCoordinates: new Map([
            [
              'baseColorTexture',
              {
                set: coordinateSet,
                transform: { offset: [0.8, 0.1], scale: [0.5, 0.5], rotation: Math.PI / 2 },
              },
            ],
          ]),
        }
      : {}),
  } as unknown as MaterialSnapshot);
  const secondaryUv = coordinateSet === 7 ? 0.1 : 0.8;
  const positions = [-0.8, -0.8, -2, 0.8, -0.8, -2, 0, 0.8, -2];
  const attributes = {
    position: new Float32Array(positions),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array(6).fill(0.1),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    uv1: new Float32Array(6).fill(secondaryUv),
    uv7: new Float32Array(6).fill(0.8),
    ...(vertexColorAvailable
      ? { color: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]) }
      : {}),
  };
  const layout = deriveVertexLayoutProjection(attributes);
  const assetHandle = assets
    .create({
      kind: 'mesh',
      attributes,
      materialSlots: [{ slotName: 'Default' }],
      vertices: new Float32Array(
        [0, 1, 2].flatMap((index) => [
          ...positions.slice(index * 3, index * 3 + 3),
          0,
          0,
          1,
          0.1,
          0.1,
          1,
          0,
          0,
          1,
          secondaryUv,
          secondaryUv,
          0.8,
          0.8,
          ...(vertexColorAvailable ? [1, 0, 0, 1] : []),
        ]),
      ),
      indices: new Uint16Array([0, 1, 2]),
      aabb: new Float32Array([-0.8, -0.8, -2, 0.8, 0.8, -2]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    })
    .unwrap();
  const world = new Float32Array(16);
  world[0] = 1;
  world[5] = 1;
  world[10] = 1;
  world[15] = 1;
  return {
    assetHandle,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey: 1,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'forgeax::default-standard-pbr|triangle-list|rigid',
        materialResourceClass: 'standard-pbr-resources',
        geometry: {
          receipt: {
            identity: `0:${assetHandle}:${layout.digest}`,
            vertexInputs: layout.attributes.map((attribute) => ({
              semantic: attribute.key,
              location: attribute.shaderLocation,
              format: attribute.format,
            })),
            topology: 'triangle-list',
            indexed: true,
          },
          layout,
          draw: { kind: 'indexed', first: 0, count: 3, baseVertex: 0, topology: 'triangle-list' },
          deformation: 'rigid',
        },
        prepared: {
          identity: {
            material: 'forgeax::default-standard-pbr',
            geometry: 'triangle',
            deformation: 'rigid',
          },
          receiptGeneration: receipt.generation,
          directEntry: receipt.directEntry,
          sceneIndexEntry: receipt.sceneIndexEntry,
          materialRow: receipt.materialRow,
          resourceSlots: receipt.resourceSlots,
          uvSets: receipt.uvSets,
          vertexInputs: receipt.vertexInputs,
          alphaMask: receipt.alphaMask,

          topology: 'triangle-list',
          indexed: true,
          first: 0,
          count: 3,
          baseVertex: 0,
        },
      },
    ],
  };
}

function mesh(device: RhiDevice, coordinateSet: 1 | 7 | undefined, vertexColorAvailable = false) {
  const secondaryUv = coordinateSet === 7 ? 0.1 : 0.8;
  const vertexStride = vertexColorAvailable ? 80 : 64;
  const vertex = device
    .createBuffer({
      size: vertexStride * 3,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const index = device
    .createBuffer({
      size: 8,
      usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  device.queue
    .writeBuffer(
      vertex,
      0,
      new Float32Array([
        -0.8,
        -0.8,
        -2,
        0,
        0,
        1,
        0.1,
        0.1,
        1,
        0,
        0,
        1,
        secondaryUv,
        secondaryUv,
        0.8,
        0.8,
        ...(vertexColorAvailable ? [1, 0, 0, 1] : []),
        0.8,
        -0.8,
        -2,
        0,
        0,
        1,
        0.1,
        0.1,
        1,
        0,
        0,
        1,
        secondaryUv,
        secondaryUv,
        0.8,
        0.8,
        ...(vertexColorAvailable ? [1, 0, 0, 1] : []),
        0,
        0.8,
        -2,
        0,
        0,
        1,
        0.1,
        0.1,
        1,
        0,
        0,
        1,
        secondaryUv,
        secondaryUv,
        0.8,
        0.8,
        ...(vertexColorAvailable ? [1, 0, 0, 1] : []),
      ]),
    )
    .unwrap();
  // Dawn requires queue.writeBuffer payloads to be four-byte aligned; the
  // fourth index is padding because the indirect draw consumes only three.
  device.queue.writeBuffer(index, 0, new Uint16Array([0, 1, 2, 0])).unwrap();
  return {
    vertexBuffer: new GpuBuffer(device, vertex),
    indexBuffer: new GpuBuffer(device, index),
    contentEpoch: 0,
    vboBytes: vertexStride * 3,
    iboBytes: 8,
    indexCount: 3,
    indexFormat: 'uint16' as const,
    layout: '12F' as const,
    layoutProjection: deriveVertexLayoutProjection({
      position: new Float32Array(9),
      normal: new Float32Array(9),
      uv: new Float32Array(6),
      tangent: new Float32Array(12),
      uv1: new Float32Array(6),
      uv7: new Float32Array(6),
      ...(vertexColorAvailable ? { color: new Float32Array(12) } : {}),
    }),
    uvSetCount: 8,
    vertexCount: 3,
    indexed: true,
    topology: 'triangle-list' as const,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list' as const,
      },
    ],
  };
}

const ALPHA_MASK_SHADOW_IDENTITIES = [
  { kind: 'directional' as const, index: 0 },
  { kind: 'point' as const, index: 0, face: 0 },
  { kind: 'spot' as const, index: 0 },
] as const;
type AlphaMaskShadowIdentity = (typeof ALPHA_MASK_SHADOW_IDENTITIES)[number];
type AlphaMaskShadowKind = AlphaMaskShadowIdentity['kind'];
type AlphaMaskGraph = RenderGraphBuilder<RenderPipelineFrame>;
type AlphaMaskGpuState = NonNullable<
  ReturnType<PersistentRenderScene['compositionGpuDrivenState']>
>;
type AlphaMaskShadowResources = Parameters<typeof shadowViewRasterAccesses>[0];
type AlphaMaskShaders = NonNullable<Awaited<ReturnType<typeof compileAlphaMaskShaders>>>;
type AlphaMaskMaterialInputs = ReturnType<typeof createAlphaMaskMaterialInputs>;
type AlphaMaskShadowView = {
  readonly identity: AlphaMaskShadowIdentity;
  readonly planes: Float32Array;
};
type AlphaMaskShadowDepthReadback = {
  readonly identity: AlphaMaskShadowIdentity;
  readonly buffer: Buffer;
};
const READBACK_USAGE = GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST;

/**
 * Compile the exact cooked Standard PBR scene-index producer variant on
 * native Dawn. This is the same manifest branch selected by the renderer
 * for the storage-backed GPU-driven lane, including its production material
 * ABI and Alpha Mask discard path.
 */
async function compileAlphaMaskShaders(device: RhiDevice, vertexColorAvailable: boolean) {
  const variant = vertexColorAvailable
    ? STANDARD_PBR_COLORED_GPU_VARIANT
    : STANDARD_PBR_GPU_VARIANT;
  const defaultVariant = STANDARD_PBR_GPU_VARIANT;
  expect(STANDARD_PBR_PRODUCER).toBeDefined();
  if (STANDARD_PBR_PRODUCER === undefined) return undefined;
  expect(variant).toBeDefined();
  if (variant === undefined) return undefined;
  expect(variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE).toBe(true);
  if (vertexColorAvailable) {
    expect(defaultVariant).toBeDefined();
    if (defaultVariant === undefined) return undefined;
  }
  const producer = await createShaderModule(device, {
    code: variant.composedWgsl,
    label: `standard-pbr-gpu-driven-producer-alpha-mask${vertexColorAvailable ? '-vertex-color' : ''}`,
  });
  expect(
    producer.ok,
    producer.ok
      ? undefined
      : JSON.stringify({
          defines: variant.defines,
          error: producer.error,
        }),
  ).toBe(true);
  if (!producer.ok) return undefined;
  const defaultProducer = vertexColorAvailable
    ? await createShaderModule(device, {
        code: defaultVariant?.composedWgsl ?? '',
        label: 'standard-pbr-gpu-driven-producer-alpha-mask-default',
      })
    : producer;
  expect(defaultProducer.ok).toBe(true);
  if (!defaultProducer.ok) return undefined;
  expect(SHADOW_CASTER_PRODUCER).toBeDefined();
  expect(SHADOW_CASTER_GPU_ALPHA_VARIANT).toBeDefined();
  if (SHADOW_CASTER_GPU_ALPHA_VARIANT === undefined) return undefined;
  const shadowCaster = (
    await createShaderModule(device, {
      code: SHADOW_CASTER_GPU_ALPHA_VARIANT.composedWgsl,
      label: 'shadow-caster-gpu-driven-producer-alpha-mask',
    })
  ).unwrap();
  expect(STANDARD_PBR_RECEIPT.alphaMask).toEqual({
    cutoff: 'alphaCutoff',
    source: 'baseColor.a',
  });
  return {
    variant,
    defaultVariant,
    producer: producer.value,
    defaultProducer: defaultProducer.value,
    shadowCaster,
  };
}

function createUniformBuffer(device: RhiDevice, size: number): Buffer {
  return device
    .createBuffer({ size, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST })
    .unwrap();
}

function createReadbackBuffer(device: RhiDevice, label: string): Buffer {
  return device.createBuffer({ label, size: 256, usage: READBACK_USAGE }).unwrap();
}

function importReadback(graph: AlphaMaskGraph, name: string, buffer: Buffer): GraphBuffer {
  return graph.importBuffer(name, { size: 256, usage: READBACK_USAGE }, () => buffer).unwrap();
}

function writeDirectionalViewUbo(
  device: RhiDevice,
  uniform: Buffer,
  lightViewProj: Float32Array,
): void {
  writeViewUbo(
    device.queue,
    uniform,
    makeZeroCameraFallbackSnapshot(),
    {
      kind: 'directional',
      // The triangle faces +Z; choose a light direction whose incoming
      // vector (`-view.lightDir`) illuminates that normal so the opaque
      // readback proves the fragment path rather than a black fixture.
      direction: new Float32Array([0, 0, -1]) as never,
      color: new Float32Array([1, 1, 1]) as never,
      intensity: 1,
      contactShadowLength: 0,
    },
    { cascades: { lightViewProj: [lightViewProj] }, point: [], spot: [], rect: [] } as never,
    [],
  );
}

/** Main and per-kind shadow view groups over shared 1x1 depth arrays and their uniforms. */
function createAlphaMaskViews(device: RhiDevice, viewLayout: BindGroupLayout) {
  const viewUniform = createUniformBuffer(device, VIEW_UNIFORM_BUFFER_SIZE);
  const shadowViewUniform = createUniformBuffer(device, VIEW_UNIFORM_BUFFER_SIZE);
  const directionalCascadeUniform = createUniformBuffer(device, 256);
  const pointCascadeUniform = createUniformBuffer(device, 256);
  const spotCascadeUniform = createUniformBuffer(device, 256);
  const viewDepthTexture = device
    .createTexture({
      label: 'gpu-driven-alpha-mask.view-depth',
      format: 'depth32float',
      size: { width: 1, height: 1, depthOrArrayLayers: 2 },
      usage: 0x14,
      dimension: '2d',
      textureBindingViewDimension: '2d-array',
    })
    .unwrap();
  const pointShadowTexture = device
    .createTexture({
      label: 'gpu-driven-alpha-mask.point-shadow-depth',
      format: 'depth32float',
      size: { width: 1, height: 1, depthOrArrayLayers: 6 },
      usage: 0x14,
      dimension: '2d',
      textureBindingViewDimension: 'cube-array',
    })
    .unwrap();
  const viewDepth = device.createTextureView(viewDepthTexture, { dimension: '2d-array' }).unwrap();
  const pointShadowDepth = device
    .createTextureView(pointShadowTexture, { dimension: 'cube-array' })
    .unwrap();
  const comparisonSampler = device.createSampler({ compare: 'less' }).unwrap();
  const viewBindGroup = device
    .createBindGroup({
      layout: viewLayout,
      entries: [
        { binding: 0, resource: { kind: 'buffer', value: { buffer: viewUniform, size: 4096 } } },
        { binding: 3, resource: { kind: 'textureView', value: viewDepth } },
        { binding: 4, resource: { kind: 'sampler', value: comparisonSampler } },
        { binding: 5, resource: { kind: 'textureView', value: pointShadowDepth } },
        { binding: 6, resource: { kind: 'buffer', value: { buffer: viewUniform, size: 4096 } } },
        { binding: 7, resource: { kind: 'buffer', value: { buffer: viewUniform, size: 4096 } } },
        { binding: 8, resource: { kind: 'textureView', value: viewDepth } },
        { binding: 10, resource: { kind: 'buffer', value: { buffer: viewUniform, size: 4096 } } },
      ],
    })
    .unwrap();
  const createShadowViewBindGroup = (cascadeBuffer: Buffer) =>
    device
      .createBindGroup({
        layout: viewLayout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: shadowViewUniform, size: 4096 } },
          },
          { binding: 3, resource: { kind: 'textureView', value: viewDepth } },
          { binding: 4, resource: { kind: 'sampler', value: comparisonSampler } },
          { binding: 5, resource: { kind: 'textureView', value: pointShadowDepth } },
          {
            binding: 6,
            resource: { kind: 'buffer', value: { buffer: shadowViewUniform, size: 4096 } },
          },
          { binding: 7, resource: { kind: 'buffer', value: { buffer: cascadeBuffer } } },
          { binding: 8, resource: { kind: 'textureView', value: viewDepth } },
          {
            binding: 10,
            resource: { kind: 'buffer', value: { buffer: shadowViewUniform, size: 4096 } },
          },
        ],
      })
      .unwrap();
  const shadowViewBindGroups = new Map([
    ['directional', createShadowViewBindGroup(directionalCascadeUniform)],
    ['point', createShadowViewBindGroup(pointCascadeUniform)],
    ['spot', createShadowViewBindGroup(spotCascadeUniform)],
  ] as const);
  const identityLightMatrix = new Float32Array(16);
  identityLightMatrix[0] = 1;
  identityLightMatrix[5] = 1;
  identityLightMatrix[10] = 1;
  identityLightMatrix[15] = 1;
  writeDirectionalViewUbo(device, viewUniform, identityLightMatrix);
  const shadowLightMatrix = new Float32Array(identityLightMatrix);
  shadowLightMatrix[10] = -1;
  shadowLightMatrix[14] = -1;
  writeDirectionalViewUbo(device, shadowViewUniform, shadowLightMatrix);
  device.queue.writeBuffer(directionalCascadeUniform, 0, new Uint32Array([0, 0, 0, 0])).unwrap();
  device.queue.writeBuffer(pointCascadeUniform, 0, new Uint32Array([0, 0, 0, 0])).unwrap();
  device.queue.writeBuffer(spotCascadeUniform, 0, new Uint32Array([0, 1, 0, 0])).unwrap();
  device.queue.writeBuffer(spotCascadeUniform, 16, shadowLightMatrix).unwrap();
  return {
    viewUniform,
    viewBindGroup,
    shadowViewBindGroups,
    buffers: [
      viewUniform,
      shadowViewUniform,
      directionalCascadeUniform,
      pointCascadeUniform,
      spotCascadeUniform,
    ],
    textures: [viewDepthTexture, pointShadowTexture],
  };
}

function createBaseColorTexture(device: RhiDevice, label: string, width: number): Texture {
  return device
    .createTexture({
      label,
      format: 'rgba8unorm',
      size: { width, height: 1, depthOrArrayLayers: 1 },
      usage: 0x06,
      dimension: '2d',
      textureBindingViewDimension: undefined,
    })
    .unwrap();
}

/** An opaque and an alpha-discarded material over the same Standard bindings. */
function createAlphaMaskMaterialInputs(device: RhiDevice, transformed: boolean) {
  const opaqueMaterialBuffer = createUniformBuffer(device, MATERIAL_PER_ENTITY_STRIDE);
  const discardedMaterialBuffer = createUniformBuffer(device, MATERIAL_PER_ENTITY_STRIDE);
  const opaqueWidth = transformed ? 4 : 1;
  const opaqueBaseColorTexture = createBaseColorTexture(
    device,
    'gpu-driven-alpha-mask.opaque-base-color',
    opaqueWidth,
  );
  const discardedBaseColorTexture = createBaseColorTexture(
    device,
    'gpu-driven-alpha-mask.discarded-base-color',
    1,
  );
  const opaqueBaseColorView = device
    .createTextureView(opaqueBaseColorTexture, { dimension: '2d' })
    .unwrap();
  const discardedBaseColorView = device
    .createTextureView(discardedBaseColorTexture, { dimension: '2d' })
    .unwrap();
  const materialCubeTexture = device
    .createTexture({
      label: 'gpu-driven-alpha-mask.material-fallback-cube',
      format: 'rgba8unorm',
      size: { width: 1, height: 1, depthOrArrayLayers: 6 },
      usage: 0x06,
      dimension: '2d',
      textureBindingViewDimension: 'cube',
    })
    .unwrap();
  const materialCubeView = device
    .createTextureView(materialCubeTexture, { dimension: 'cube' })
    .unwrap();
  const baseColorSampler = device
    .createSampler({ magFilter: 'nearest', minFilter: 'nearest' })
    .unwrap();
  expect(
    device.queue.writeTexture(
      { texture: opaqueBaseColorTexture },
      // Only transformed UV1 reaches the opaque texel. UV0, ignoring
      // rotation, or ignoring the offset each reaches a transparent texel.
      new Uint8Array(
        transformed
          ? [255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0]
          : [255, 255, 255, 255],
      ),
      { bytesPerRow: opaqueWidth * 4, rowsPerImage: 1 },
      { width: opaqueWidth, height: 1, depthOrArrayLayers: 1 },
    ).ok,
  ).toBe(true);
  expect(
    device.queue.writeTexture(
      { texture: discardedBaseColorTexture },
      new Uint8Array([255, 255, 255, 64]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    ).ok,
  ).toBe(true);
  device.queue.writeBuffer(opaqueMaterialBuffer, 0, new Float32Array([1, 1, 1, 1, 0.5])).unwrap();
  device.queue
    .writeBuffer(discardedMaterialBuffer, 0, new Float32Array([1, 1, 1, 0.25, 0.5]))
    .unwrap();
  return {
    opaque: { buffer: opaqueMaterialBuffer, baseColorView: opaqueBaseColorView },
    discarded: { buffer: discardedMaterialBuffer, baseColorView: discardedBaseColorView },
    materialCubeView,
    baseColorSampler,
    buffers: [opaqueMaterialBuffer, discardedMaterialBuffer],
    textures: [opaqueBaseColorTexture, discardedBaseColorTexture, materialCubeTexture],
  };
}

function createAlphaMaskMaterialGroup(
  device: RhiDevice,
  layout: BindGroupLayout,
  inputs: AlphaMaskMaterialInputs,
  material: { readonly buffer: Buffer; readonly baseColorView: TextureView },
  viewUniform: Buffer,
  sceneMaterialBuffer: Buffer,
): BindGroup {
  const iblStart = 1 + BUILTIN_USER_REGION_TEXTURE_FIELDS.length * 2;
  const omitted = omittedStandardMaterialBindings(
    BUILTIN_USER_REGION_TEXTURE_FIELDS,
    false,
    true,
    true,
  );
  const { baseColorSampler } = inputs;
  const { baseColorView } = material;
  const entries = [
    { binding: 0, resource: { kind: 'buffer' as const, value: { buffer: material.buffer } } },
    ...Array.from({ length: BUILTIN_USER_REGION_TEXTURE_FIELDS.length }, (_, index) => [
      {
        binding: index * 2 + 1,
        resource: { kind: 'sampler' as const, value: baseColorSampler },
      },
      {
        binding: index * 2 + 2,
        resource: { kind: 'textureView' as const, value: baseColorView },
      },
    ]).flat(),
    {
      binding: iblStart + 0,
      resource: { kind: 'textureView' as const, value: inputs.materialCubeView },
    },
    { binding: iblStart + 1, resource: { kind: 'sampler' as const, value: baseColorSampler } },
    {
      binding: iblStart + 2,
      resource: { kind: 'textureView' as const, value: baseColorView },
    },
    { binding: 47, resource: { kind: 'textureView' as const, value: baseColorView } },
    { binding: iblStart + 3, resource: { kind: 'sampler' as const, value: baseColorSampler } },
    { binding: iblStart + 4, resource: { kind: 'textureView' as const, value: baseColorView } },
    {
      binding: iblStart + 5,
      resource: { kind: 'buffer' as const, value: { buffer: viewUniform, size: 4096 } },
    },
    {
      binding: 46,
      resource: {
        kind: 'buffer' as const,
        value: { buffer: sceneMaterialBuffer },
      },
    },
  ].filter((entry) => !omitted.has(entry.binding));
  return device.createBindGroup({ layout, entries }).unwrap();
}

function alphaMaskExtractedFrame(source: RenderableSnapshot): ExtractedFrame {
  return {
    cameras: [makeZeroCameraFallbackSnapshot()],
    auxiliaryCameras: [],
    cubeCameras: [],
    lights: { directional: undefined, directionalCount: 0, point: [], spot: [], rect: [] },
    environment: undefined,
    environmentReady: true,
    renderables: [source],
    dispatch: [],
    shadowCasterEntityKeys: new Set<number>(),
    shadowCasterDrawKeys: new Set<string>(),
    skylight: undefined,
    skylightCount: 0,
    skybox: undefined,
    skyboxCount: 0,
    fog: undefined,
    frustumStats: { culled: 0, total: 1 },
    visibilityStats: { explicitlyHidden: 0 },
    postProcessParams: new Map(),
    visibilitySnapshots: [],
    featureVisibilitySnapshots: [],
    hiddenEntityReports: [],
  } as unknown as ExtractedFrame;
}

/** The selected producer program and, for vertex color, the default program it falls back to. */
function alphaMaskPrograms(shaders: AlphaMaskShaders, vertexColorAvailable: boolean) {
  const receipt = vertexColorAvailable ? STANDARD_PBR_COLORED_RECEIPT : STANDARD_PBR_RECEIPT;
  const artifact = {
    material: 'forgeax::default-standard-pbr',
    pass: 'forward',
    program: createMaterialShaderProgram(shaders.variant.composedWgsl),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: receipt.vertexInputs as unknown as readonly Readonly<Record<string, unknown>>[],
    receipt,
  } satisfies MaterialShaderArtifact;
  const programKey = standardPbrProgramKey(artifact.material, vertexColorAvailable);
  expect(programKey).toBeDefined();
  if (programKey === undefined) return undefined;
  const defaultProgramKey = standardPbrProgramKey(artifact.material);
  expect(defaultProgramKey).toBeDefined();
  if (defaultProgramKey === undefined) return undefined;
  const defaultArtifact: MaterialShaderArtifact = vertexColorAvailable
    ? {
        ...artifact,
        program: createMaterialShaderProgram(shaders.defaultVariant?.composedWgsl ?? ''),
        layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
        vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
          Record<string, unknown>
        >[],
        receipt: STANDARD_PBR_RECEIPT,
      }
    : artifact;
  const programs = new Map<string, GpuDrivenPbrProgram>([
    [programKey, { module: shaders.producer, artifact }],
  ]);
  if (defaultProgramKey !== programKey) {
    programs.set(defaultProgramKey, {
      module: shaders.defaultProducer,
      artifact: defaultArtifact,
    });
  }
  return { artifact, programs };
}

function expectPreparedAlphaMask(
  prepared: PreparedGpuDrivenFrame,
  source: RenderableSnapshot,
  projection: ReturnType<PersistentRenderScene['compositionSlots']>,
  sceneMaterialBuffer: Buffer,
  artifact: NonNullable<ReturnType<typeof alphaMaskPrograms>>['artifact'],
): void {
  const sourceSlot = projection.at(0);
  if (sourceSlot === undefined) throw Error('missing source slot');
  expect(prepared.selection.ownsSlot(source, 0, sourceSlot.slot, sourceSlot.generation)).toBe(true);
  expect(prepared.standardPbrFrameResources.sceneMaterialBuffer).toBe(sceneMaterialBuffer);
  expect(typeof prepared.standardPbrFrameResources.prepareMaterialBinding).toBe('function');
  expect(artifact.receipt.alphaMask).toEqual({ cutoff: 'alphaCutoff', source: 'baseColor.a' });
}

function createAlphaMaskShadowPipeline(
  device: RhiDevice,
  layout: ReturnType<typeof buildGpuDrivenPbrPipelineLayout>,
  module: ShaderModule,
  gpuMesh: ReturnType<typeof mesh>,
): RenderPipeline | undefined {
  const shadowVertexLayout = deriveVertexBufferLayoutFromProjection(gpuMesh.layoutProjection, {
    shaderUvSetCount: 8,
  })[0];
  expect(shadowVertexLayout).toBeDefined();
  if (shadowVertexLayout === undefined) return undefined;
  return device
    .createRenderPipeline({
      label: 'gpu-driven-alpha-mask-production-shadow-caster',
      layout,
      vertex: {
        module,
        entryPoint: 'vs_scene_index',
        buffers: [
          {
            arrayStride: shadowVertexLayout.arrayStride,
            stepMode: 'vertex',
            attributes: shadowVertexLayout.attributes.map(({ shaderLocation, offset, format }) => ({
              shaderLocation,
              offset,
              format: format as GPUVertexFormat,
            })),
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'greater',
      },
    })
    .unwrap();
}

/** The unmoved caster settles into each available static layer. */
function alphaMaskRasterIdentity(identity: AlphaMaskShadowIdentity): ShadowViewIdentity {
  return shadowViewHasStaticLayer(identity) ? { ...identity, layer: 'static' } : identity;
}

/** Project every shadow kind's production culling; any missing kind ends the case. */
function projectAlphaMaskShadows(
  prepared: PreparedGpuDrivenFrame,
  graph: AlphaMaskGraph,
): Readonly<Record<AlphaMaskShadowKind, AlphaMaskShadowResources>> | undefined {
  const [directionalIdentity, pointIdentity, spotIdentity] = ALPHA_MASK_SHADOW_IDENTITIES;
  const directional = prepared.projectShadow?.(graph, alphaMaskRasterIdentity(directionalIdentity));
  expect(directional?.ok).toBe(true);
  if (directional === undefined || !directional.ok || directional.value === undefined) return;
  if (directional.value.graphResources === undefined) return;
  const point = prepared.projectShadow?.(graph, alphaMaskRasterIdentity(pointIdentity));
  const spot = prepared.projectShadow?.(graph, alphaMaskRasterIdentity(spotIdentity));
  expect(point?.ok).toBe(true);
  expect(spot?.ok).toBe(true);
  if (
    point === undefined ||
    !point.ok ||
    point.value === undefined ||
    point.value.graphResources === undefined ||
    spot === undefined ||
    !spot.ok ||
    spot.value === undefined ||
    spot.value.graphResources === undefined
  )
    return;
  return {
    directional: directional.value.graphResources,
    point: point.value.graphResources,
    spot: spot.value.graphResources,
  };
}

function alphaMaskShadowSubmission(
  prepared: PreparedGpuDrivenFrame,
  identity: AlphaMaskShadowIdentity,
  pipeline: RenderPipeline,
  materialGroup: BindGroup,
): GpuDrivenShadowSubmission | undefined {
  const raster = alphaMaskRasterIdentity(identity);
  const submission = prepared.shadowViewPool?.submission(raster);
  const projections = prepared.shadowBatchProjections?.()?.get(shadowViewIdentityKey(raster));
  if (submission === undefined || projections === undefined) return undefined;
  const batches: GpuDrivenShadowBatch[] = [];
  for (const batch of submission.plan.batches) {
    const projection = projections.get(batch.batchId);
    if (projection === undefined) return undefined;
    const indexBuffer = projection.mesh.indexBuffer;
    batches.push({
      indirectOffset: batch.indirectOffset,
      pipeline,
      meshBindGroup: projection.meshBindGroup,
      visibleBindGroups: projection.visibleBindGroups,
      deformation: projection.deformation,
      materialGroup,
      vertexBuffer: projection.mesh.vertexBuffer.handle,
      ...(indexBuffer === null
        ? {}
        : {
            indexBuffer: indexBuffer.handle,
            indexFormat: projection.mesh.indexFormat,
          }),
    });
  }
  return { view: submission.view, batches };
}

function addTextureReadbackPass(
  graph: AlphaMaskGraph,
  name: string,
  texture: GraphTexture,
  view: GraphTextureView,
  readback: GraphBuffer,
): void {
  graph
    .addCopyPass(name, {
      accesses: [
        { resource: view, usage: 'copy-src' },
        { resource: readback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) =>
        encoder.copyTextureToBuffer(
          { texture: resources.texture(texture).unwrap() },
          {
            buffer: resources.buffer(readback).unwrap(),
            bytesPerRow: 256,
            rowsPerImage: 1,
          },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        ),
    })
    .unwrap();
}

function addIndirectReadbackPass(
  graph: AlphaMaskGraph,
  name: string,
  indirect: GraphBuffer,
  readback: GraphBuffer,
): void {
  graph
    .addCopyPass(name, {
      accesses: [
        { resource: indirect, usage: 'copy-src' },
        { resource: readback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) =>
        encoder.copyBufferToBuffer(
          resources.buffer(indirect).unwrap(),
          0,
          resources.buffer(readback).unwrap(),
          0,
          20,
        ),
    })
    .unwrap();
}

function addAlphaMaskRaster(
  graph: AlphaMaskGraph,
  main: RenderPipelineGpuDrivenProjection,
  frame: {
    readonly depthView: GraphTextureView;
    readonly viewBindGroup: BindGroup;
    readonly frameResources: PreparedGpuDrivenFrame['standardPbrFrameResources'];
  },
  name: string,
  outputView: GraphTextureView,
  materialBindGroup: () => BindGroup,
): void {
  graph
    .addRasterPass(name, {
      accesses: [
        ...main.accesses,
        { resource: outputView, usage: 'color-attachment' },
        { resource: frame.depthView, usage: 'depth-stencil-write' },
      ],
      colorAttachments: [
        {
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: frame.depthView,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
      },
      encode: ({ pass, resources }) =>
        main.encode(frame.viewBindGroup, pass, resources, {
          ...frame.frameResources,
          prepareMaterialBinding: (
            (groups: readonly (BindGroup | undefined)[]) => (slot: number) => {
              const group = groups[slot];
              return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
            }
          )([materialBindGroup()]),
        }),
    })
    .unwrap();
}

/**
 * Rasterize each shadow kind's production indirect submission into its own
 * depth target and copy one texel back. Returns false when a kind is missing.
 */
function addAlphaMaskShadowDepthRasters(
  graph: AlphaMaskGraph,
  targets: readonly {
    readonly identity: AlphaMaskShadowIdentity;
    readonly texture: GraphTexture;
    readonly view: GraphTextureView;
  }[],
  readbacks: readonly {
    readonly identity: AlphaMaskShadowIdentity;
    readonly resource: GraphBuffer;
  }[],
  shadows: Readonly<Record<AlphaMaskShadowKind, AlphaMaskShadowResources>>,
  shadowViewBindGroups: ReadonlyMap<AlphaMaskShadowKind, BindGroup>,
  submissionFor: (identity: AlphaMaskShadowIdentity) => GpuDrivenShadowSubmission | undefined,
): boolean {
  for (const target of targets) {
    const submission = submissionFor(target.identity);
    const resources = shadows[target.identity.kind];
    const shadowViewGroup = shadowViewBindGroups.get(target.identity.kind);
    const readback = readbacks.find(({ identity }) => identity.kind === target.identity.kind);
    expect(submission).toBeDefined();
    expect(resources).toBeDefined();
    expect(shadowViewGroup).toBeDefined();
    expect(readback).toBeDefined();
    if (submission === undefined || shadowViewGroup === undefined || readback === undefined)
      return false;
    graph
      .addRasterPass(`gpu-driven.alpha-mask.${target.identity.kind}-shadow-depth-raster`, {
        accesses: [
          ...shadowViewRasterAccesses(resources),
          { resource: target.view, usage: 'depth-stencil-write' },
        ],
        colorAttachments: [],
        depthStencilAttachment: {
          view: target.view,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
        encode: ({ pass }) => {
          pass.setBindGroup(0, shadowViewGroup, [0, 0]);
          recordGpuDrivenShadowIndirect(pass, submission);
        },
      })
      .unwrap();
    addTextureReadbackPass(
      graph,
      `gpu-driven.alpha-mask.${target.identity.kind}-shadow-depth-readback`,
      target.texture,
      target.view,
      readback.resource,
    );
  }
  return true;
}

interface AlphaMaskRun {
  readonly device: RhiDevice;
  readonly native: Awaited<ReturnType<typeof nativeDeviceFixture>>['native'];
  readonly compiled: CompiledRenderGraph<RenderPipelineFrame>;
  readonly production: GpuDrivenProduction;
  readonly prepared: PreparedGpuDrivenFrame;
  readonly prepareInput: Parameters<typeof admitPbrDawnFixture>[0];
  readonly source: RenderableSnapshot;
  readonly persistentAssets: AssetRegistry;
  readonly persistentScene: PersistentRenderScene;
  readonly persistentWorld: World;
  readonly persistentLease: ReturnType<typeof createRenderReadLease>;
  readonly persistentFrame: ExtractedFrame;
  readonly shadowViews: readonly AlphaMaskShadowView[];
  readonly readbacks: Readonly<Record<'opaque' | 'discarded' | AlphaMaskShadowKind, Buffer>>;
  readonly shadowDepthReadbackBuffers: readonly AlphaMaskShadowDepthReadback[];
  readonly viewBindGroup: BindGroup;
  readonly opaqueMaterialBindGroup: BindGroup;
  readonly setDiscardedTexture: (discarded: boolean) => void;
  readonly coordinateSet: 1 | 7 | undefined;
  readonly vertexColorAvailable: boolean;
}

function extractAlphaMaskComposition(run: AlphaMaskRun): void {
  run.persistentScene.extractComposition(
    [run.persistentWorld],
    { cameraOwner: 0, resourceOwner: 0 },
    run.persistentAssets,
    () => run.persistentFrame,
    [run.persistentLease],
  );
}

function expectAlphaMaskPasses(compiled: CompiledRenderGraph<RenderPipelineFrame>): void {
  const names = compiled.inspect().passes.map((pass) => pass.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'gpu-driven.view-reset',
      'gpu-driven.frustum-compact',
      'gpu-driven.finalize-indirect',
      'gpu-driven.shadow.directional-cascade-0.static.view-reset',
      'gpu-driven.shadow.directional-cascade-0.static.finalize-indirect',
      'gpu-driven.shadow.point-cube-face-0-0.static.view-reset',
      'gpu-driven.shadow.point-cube-face-0-0.static.finalize-indirect',
      'gpu-driven.shadow.spot-atlas-0.static.view-reset',
      'gpu-driven.shadow.spot-atlas-0.static.finalize-indirect',
      'gpu-driven.alpha-mask.opaque',
      'gpu-driven.alpha-mask.discarded',
    ]),
  );
}

async function executeAlphaMaskFrame(run: AlphaMaskRun, label: string): Promise<void> {
  const encoder = run.device.createCommandEncoder({ label }).unwrap();
  expect(run.compiled.execute({ encoder } as unknown as RenderPipelineFrame).ok).toBe(true);
  run.device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await run.device.queue.onSubmittedWorkDone();
}

/** Admit the same binding-input domain before measuring stable frames. */
function prepareStableAlphaMask(run: AlphaMaskRun): PreparedGpuDrivenFrame | undefined {
  extractAlphaMaskComposition(run);
  const stableGpuState = run.persistentScene.compositionGpuDrivenState();
  expect(stableGpuState).toBeDefined();
  if (stableGpuState === undefined) return undefined;
  const stableMetrics = stableGpuState.structureMetrics;
  if (stableMetrics === undefined) return undefined;
  expect(stableMetrics).toEqual({
    worldEntitiesScanned: 0,
    sceneTableUploadBytes: 0,
  });
  const stablePrepared = run.production.prepare(
    admitPbrDawnFixture({
      ...run.prepareInput,
      scene: stableGpuState,
      structureMetrics: stableMetrics,
      // No-map inputs do not observe source binding keys; a first map must.
    }),
  );
  expect(stablePrepared.ok).toBe(true);
  if (!stablePrepared.ok || stablePrepared.value === undefined) return undefined;
  const stableShadowUpdated = stablePrepared.value.updateShadowViews?.(run.shadowViews);
  expect(stableShadowUpdated?.ok).toBe(true);
  stablePrepared.value._commitResourceReplacement();
  return stablePrepared.value;
}

function stableFrameInspection(inspection: ReturnType<GpuDrivenProduction['inspect']>) {
  return {
    gpuOwnedSnapshotsMaterialized: inspection.gpuOwnedSnapshotsMaterialized,
    filteredPlanBuilds: inspection.filteredPlanBuilds,
    sharedInputUploadBytes: inspection.sharedInputUploadBytes,
    batchUploadBytes: inspection.batchUploadBytes,
    batchBindGroupCreates: inspection.batchBindGroupCreates,
    validatedGpuOwnedRows: inspection.validatedGpuOwnedRows,
    cpuFallbackDrawItems: inspection.cpuFallbackDrawItems,
    cpuValidationScans: inspection.cpuValidationScans,
    cpuValidationCacheHits: inspection.cpuValidationCacheHits,
    worldEntitiesScanned: inspection.worldEntitiesScanned,
    sceneTableUploadBytes: inspection.sceneTableUploadBytes,
    paletteUploadBytes: inspection.paletteUploadBytes,
    overflow: inspection.overflow,
  };
}

/**
 * Prepare and submit every stable frame to detect topology/upload leaks.
 * Returns undefined when a frame's GPU state or preparation is missing.
 */
async function recordStableAlphaMaskFrames(run: AlphaMaskRun) {
  const inspections: ReturnType<typeof stableFrameInspection>[] = [];
  const metrics: NonNullable<AlphaMaskGpuState['structureMetrics']>[] = [];
  for (let frame = 0; frame < STABLE_FRAME_COUNT; frame += 1) {
    extractAlphaMaskComposition(run);
    const frameGpuState = run.persistentScene.compositionGpuDrivenState();
    expect(frameGpuState).toBeDefined();
    if (frameGpuState === undefined || frameGpuState.structureMetrics === undefined) return;
    metrics.push(frameGpuState.structureMetrics);
    const framePrepared = run.production.prepare(
      admitPbrDawnFixture({
        ...run.prepareInput,
        scene: frameGpuState,
        structureMetrics: frameGpuState.structureMetrics,
        // CPU-only material publication changes cannot invalidate this GPU plan.
      }),
    );
    expect(framePrepared.ok).toBe(true);
    if (!framePrepared.ok || framePrepared.value === undefined) return;
    expect(framePrepared.value.updateShadowViews?.(run.shadowViews)?.ok).toBe(true);
    framePrepared.value._commitResourceReplacement();
    await executeAlphaMaskFrame(run, `gpu-driven-alpha-mask-stable-${frame}`);
    inspections.push(stableFrameInspection(run.production.inspect()));
  }
  return { inspections, metrics };
}

function expectStableAlphaMaskFrames(
  run: AlphaMaskRun,
  stable: NonNullable<Awaited<ReturnType<typeof recordStableAlphaMaskFrames>>>,
  baseline: ReturnType<GpuDrivenProduction['inspect']>,
): void {
  expect(stable.inspections).toHaveLength(STABLE_FRAME_COUNT);
  expect(stable.metrics).toHaveLength(STABLE_FRAME_COUNT);
  for (const metrics of stable.metrics) {
    expect(metrics).toEqual({
      worldEntitiesScanned: 0,
      sceneTableUploadBytes: 0,
    });
  }
  for (const inspection of stable.inspections) {
    expect(inspection).toEqual({
      gpuOwnedSnapshotsMaterialized: 0,
      filteredPlanBuilds: 0,
      sharedInputUploadBytes: 0,
      batchUploadBytes: 0,
      batchBindGroupCreates: 0,
      validatedGpuOwnedRows: 0,
      cpuFallbackDrawItems: 0,
      cpuValidationScans: baseline.cpuValidationScans,
      cpuValidationCacheHits: expect.any(Number),
      worldEntitiesScanned: 0,
      sceneTableUploadBytes: 0,
      paletteUploadBytes: 0,
      overflow: false,
    });
  }
  expect(run.production.inspect().cpuValidationScans).toBe(baseline.cpuValidationScans);
  expect(run.production.inspect().cpuValidationCacheHits).toBe(baseline.cpuValidationCacheHits);
}

async function readFirstBytes(buffer: Buffer, bytes: number): Promise<ArrayBuffer> {
  const mapped = (await buffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
  const data = mapped.getMappedRange().unwrap().slice(0, bytes);
  mapped.unmap();
  return data;
}

/** Opaque coverage, discarded coverage, every shadow kind's indirect draw and depth texel. */
async function expectAlphaMaskReadbacks(run: AlphaMaskRun): Promise<void> {
  const opaquePixel = [...new Uint8Array(await readFirstBytes(run.readbacks.opaque, 4))];
  const discardedPixel = [...new Uint8Array(await readFirstBytes(run.readbacks.discarded, 4))];
  const shadowIndirect = new Uint32Array(await readFirstBytes(run.readbacks.directional, 20));
  const pointShadowIndirect = new Uint32Array(await readFirstBytes(run.readbacks.point, 20));
  const spotShadowIndirect = new Uint32Array(await readFirstBytes(run.readbacks.spot, 20));
  expect(opaquePixel[0]).toBeGreaterThan(0);
  if (run.vertexColorAvailable) {
    expect(opaquePixel[0]).toBeGreaterThan(opaquePixel[1] ?? Number.NaN);
  } else {
    expect(opaquePixel[1]).toBeGreaterThan(0);
  }
  expect(discardedPixel).toEqual([0, 0, 0, 0]);
  expect(Array.from(shadowIndirect.slice(0, 2))).toEqual([3, 1]);
  expect(Array.from(pointShadowIndirect.slice(0, 2))).toEqual([3, 1]);
  expect(Array.from(spotShadowIndirect.slice(0, 2))).toEqual([3, 1]);
  for (const { identity, buffer } of run.shadowDepthReadbackBuffers) {
    const depth = new Float32Array(await readFirstBytes(buffer, 4))[0] ?? 1;
    expect(depth, `${identity.kind} shadow depth raster readback`).toBeGreaterThan(0);
  }
}

/**
 * Submit the compiled graph, hold 60 stable frames, then read every output.
 * Returns false when an intermediate frame state is missing.
 */
async function verifyCompiledAlphaMask(run: AlphaMaskRun): Promise<boolean> {
  expectAlphaMaskPasses(run.compiled);
  await executeAlphaMaskFrame(run, 'gpu-driven-alpha-mask-dawn');
  run.prepared._commitResourceReplacement();
  expect(run.production.inspect().worldEntitiesScanned).toBe(1);
  expect(run.production.inspect().sceneTableUploadBytes).toBeGreaterThan(0);
  expect(run.production.inspect().paletteUploadBytes).toBe(0);
  const stablePrepared = prepareStableAlphaMask(run);
  if (stablePrepared === undefined) return false;
  const stableBaseline = run.production.inspect();
  const stable = await recordStableAlphaMaskFrames(run);
  if (stable === undefined) return false;
  expectStableAlphaMaskFrames(run, stable, stableBaseline);
  if (run.coordinateSet === undefined && !run.vertexColorAvailable) {
    await verifyRetainedRasterClass({
      device: run.device,
      compiled: run.compiled,
      production: run.production,
      prepareInput: run.prepareInput,
      source: run.source,
      persistentScene: run.persistentScene,
      persistentWorld: run.persistentWorld,
      persistentLease: run.persistentLease,
      persistentFrame: run.persistentFrame,
      discardedReadbackBuffer: run.readbacks.discarded,
      opaqueReadbackBuffer: run.readbacks.opaque,
      setDiscardedTexture: run.setDiscardedTexture,
      shadowViews: run.shadowViews,
      topologySignature: stablePrepared.topologySignature(),
    });
  }
  await expectAlphaMaskReadbacks(run);
  if (run.coordinateSet === 1 && !run.vertexColorAvailable) {
    await verifyRetainedRasterRouting({
      device: run.device,
      native: run.native,
      production: run.production,
      prepareInput: run.prepareInput,
      source: run.source,
      persistentScene: run.persistentScene,
      persistentWorld: run.persistentWorld,
      persistentLease: run.persistentLease,
      persistentFrame: run.persistentFrame,
      viewBindGroup: run.viewBindGroup,
      materialBindGroup: run.opaqueMaterialBindGroup,
    });
  }
  (await run.compiled.retire()).unwrap();
  return true;
}

describe('GPU-driven production PBR Dawn regression', () => {
  it.each([
    { coordinateSet: undefined, vertexColorAvailable: false, firstInstanceIndirect: false },
    { coordinateSet: 1, vertexColorAvailable: false, firstInstanceIndirect: false },
    { coordinateSet: 7, vertexColorAvailable: true, firstInstanceIndirect: true },
  ] as const)('admits Alpha Mask into main and shadow production plans (transformed UV set=$coordinateSet, vertex color=$vertexColorAvailable, indirect first instance=$firstInstanceIndirect)', async ({
    coordinateSet,
    vertexColorAvailable,
    firstInstanceIndirect,
  }) => {
    const { device, native } = await nativeDeviceFixture({
      requiredFeatures: [
        'depth32float-stencil8',
        ...(firstInstanceIndirect ? (['indirect-first-instance'] as const) : []),
      ],
    });
    expect(native.features.has('indirect-first-instance')).toBe(firstInstanceIndirect);
    expect(device.caps.firstInstanceIndirect).toBe(firstInstanceIndirect);
    const shaders = await compileAlphaMaskShaders(device, vertexColorAvailable);
    if (shaders === undefined) return;
    const viewShader = (
      await createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL, label: 'gpu-driven-view' })
    ).unwrap();
    const pbrLayouts = buildPbrPipelineLayouts(device, {
      storageBuffer: true,
      extendedLighting: false,
      projectorAvailable: false,
      transmissionBackdrop: false,
    });
    const instancesLayout = buildGpuDrivenPbrInstancesBindGroupLayout(device, {
      storageBuffer: true,
    });
    const pipelineLayout = buildGpuDrivenPbrPipelineLayout(device, pbrLayouts, instancesLayout);
    const views = createAlphaMaskViews(device, pbrLayouts.viewBgl);
    const materials = createAlphaMaskMaterialInputs(device, coordinateSet !== undefined);
    const persistentAssets = new AssetRegistry();
    const source = alphaMaskSnapshot(coordinateSet, vertexColorAvailable, persistentAssets);
    const persistentWorld = new World({ assets: persistentAssets });
    const persistentLease = createRenderReadLease(persistentWorld);
    const persistentScene = new PersistentRenderScene({
      getDevice: () => device,
      assets: persistentAssets,
    });
    const persistentFrame = alphaMaskExtractedFrame(source);
    persistentScene.extractComposition(
      [persistentWorld],
      { cameraOwner: 0, resourceOwner: 0 },
      persistentAssets,
      () => persistentFrame,
      [persistentLease],
    );
    const initialGpuState = persistentScene.compositionGpuDrivenState();
    expect(initialGpuState).toBeDefined();
    if (initialGpuState === undefined) return;
    const projection = persistentScene.compositionSlots();
    const scene = initialGpuState.scene;
    const structureMetrics = initialGpuState.structureMetrics;
    if (structureMetrics === undefined) return;
    expect(structureMetrics).toEqual({
      worldEntitiesScanned: 1,
      sceneTableUploadBytes: expect.any(Number),
    });
    const opaqueMaterialBindGroup = createAlphaMaskMaterialGroup(
      device,
      pbrLayouts.materialBgl,
      materials,
      materials.opaque,
      views.viewUniform,
      scene.materialBuffer,
    );
    const discardedMaterialBindGroup = createAlphaMaskMaterialGroup(
      device,
      pbrLayouts.materialBgl,
      materials,
      materials.discarded,
      views.viewUniform,
      scene.materialBuffer,
    );
    expect(initialGpuState.plan).toMatchObject({
      candidateCount: 1,
    });
    const shadowViews = ALPHA_MASK_SHADOW_IDENTITIES.map((identity) => ({
      identity,
      planes: new Float32Array(24),
    }));
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(viewShader as ShaderModule),
    });
    const gpuMesh = mesh(device, coordinateSet, vertexColorAvailable);
    const programs = alphaMaskPrograms(shaders, vertexColorAvailable);
    if (programs === undefined) return;
    const { artifact } = programs;
    const prepareInput = {
      scene: {
        scene,
        plan: initialGpuState.plan,
        slots: projection,
        slotAt: (index: number) => projection.find((slot) => slot.slot === index),
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map(projection.map((slot) => [slot.slot, gpuMesh])),
      viewBindGroupLayout: pbrLayouts.viewBgl,
      meshResidencyEpoch: 1,

      materialArtifact: artifact,
      materialPipelineState: {
        pbrPipelineLayout: pipelineLayout,
        gpuDrivenPbrPipelineLayout: pipelineLayout,
        meshBindGroupLayout: pbrLayouts.meshArrayBgl,
        instancesBindGroupLayout: instancesLayout,
        gpuDrivenInstancesBindGroupLayout: instancesLayout,
        gpuDrivenPbrPrograms: programs.programs,
        // The composed producer keeps the canonical uv0..uv7 input ABI even
        // when this material only authored uv0. The geometry owner aliases the
        // missing sets to uv0 when the producer advertises the full ABI.
        standardPbrShaderUvSetCount: 8,
      } as never,
      shadowViews: true,
      structureMetrics: {
        ...structureMetrics,
      },
    } as const;
    const prepared = production.prepare(admitPbrDawnFixture(prepareInput));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value === undefined) return;
    const preparedFrame = prepared.value;
    expectPreparedAlphaMask(preparedFrame, source, projection, scene.materialBuffer, artifact);

    const shadowPipeline = createAlphaMaskShadowPipeline(
      device,
      pipelineLayout,
      shaders.shadowCaster,
      gpuMesh,
    );
    if (shadowPipeline === undefined) return;

    const shadowUpdated = preparedFrame.updateShadowViews?.(shadowViews);
    expect(shadowUpdated?.ok).toBe(true);
    expect(preparedFrame.shadowBatchProjections?.()?.get('directional:0:')).toBeDefined();
    expect(preparedFrame.shadowBatchProjections?.()?.get('point:0:0')).toBeDefined();
    expect(preparedFrame.shadowBatchProjections?.()?.get('spot:0:')).toBeDefined();

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const main = preparedFrame.project(graph, 'rgba8unorm', 1);
    expect(main.ok).toBe(true);
    if (!main.ok) return;
    const shadows = projectAlphaMaskShadows(preparedFrame, graph);
    if (shadows === undefined) return;

    const shadowDepthTargets = ALPHA_MASK_SHADOW_IDENTITIES.map((identity) => {
      const texture = graph
        .createTexture(`gpu-driven-alpha-mask.${identity.kind}-shadow-depth`, {
          format: 'depth32float',
          size: { width: 1, height: 1 },
        })
        .unwrap();
      return { identity, texture, view: graph.view(texture).unwrap() };
    });
    const shadowDepthReadbackBuffers = ALPHA_MASK_SHADOW_IDENTITIES.map((identity) => ({
      identity,
      buffer: createReadbackBuffer(
        device,
        `gpu-driven-alpha-mask.${identity.kind}-shadow-depth-readback`,
      ),
    }));
    const shadowDepthReadbackResources = shadowDepthReadbackBuffers.map(({ identity, buffer }) => ({
      identity,
      resource: importReadback(
        graph,
        `gpu-driven-alpha-mask.${identity.kind}-shadow-depth-readback`,
        buffer,
      ),
    }));

    const opaqueOutput = graph
      .createTexture('gpu-driven-alpha-mask-opaque', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const discardedOutput = graph
      .createTexture('gpu-driven-alpha-mask-discarded', {
        format: 'rgba8unorm',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const opaqueOutputView = graph.view(opaqueOutput).unwrap();
    const discardedOutputView = graph.view(discardedOutput).unwrap();
    const depth = graph
      .createTexture('gpu-driven-alpha-mask-depth', {
        format: 'depth32float-stencil8',
        size: { width: 1, height: 1 },
      })
      .unwrap();
    const depthView = graph.view(depth).unwrap();
    const readbacks = {
      opaque: createReadbackBuffer(device, 'gpu-driven-alpha-mask-opaque-readback'),
      discarded: createReadbackBuffer(device, 'gpu-driven-alpha-mask-discarded-readback'),
      directional: createReadbackBuffer(device, 'gpu-driven-alpha-mask-shadow-indirect-readback'),
      point: createReadbackBuffer(device, 'gpu-driven-alpha-mask-point-shadow-indirect-readback'),
      spot: createReadbackBuffer(device, 'gpu-driven-alpha-mask-spot-shadow-indirect-readback'),
    };
    const opaqueReadback = importReadback(
      graph,
      'gpu-driven-alpha-mask-opaque-readback',
      readbacks.opaque,
    );
    const discardedReadback = importReadback(
      graph,
      'gpu-driven-alpha-mask-discarded-readback',
      readbacks.discarded,
    );
    const shadowIndirectReadback = importReadback(
      graph,
      'gpu-driven-alpha-mask-shadow-indirect-readback',
      readbacks.directional,
    );
    const pointShadowIndirectReadback = importReadback(
      graph,
      'gpu-driven-alpha-mask-point-shadow-indirect-readback',
      readbacks.point,
    );
    const spotShadowIndirectReadback = importReadback(
      graph,
      'gpu-driven-alpha-mask-spot-shadow-indirect-readback',
      readbacks.spot,
    );
    let currentOpaqueMaterialGroup = opaqueMaterialBindGroup;
    const rasterFrame = {
      depthView,
      viewBindGroup: views.viewBindGroup,
      frameResources: preparedFrame.standardPbrFrameResources,
    };
    addAlphaMaskRaster(
      graph,
      main.value,
      rasterFrame,
      'gpu-driven.alpha-mask.opaque',
      opaqueOutputView,
      () => currentOpaqueMaterialGroup,
    );
    addAlphaMaskRaster(
      graph,
      main.value,
      rasterFrame,
      'gpu-driven.alpha-mask.discarded',
      discardedOutputView,
      () => discardedMaterialBindGroup,
    );
    const shadowDepthsAdded = addAlphaMaskShadowDepthRasters(
      graph,
      shadowDepthTargets,
      shadowDepthReadbackResources,
      shadows,
      views.shadowViewBindGroups,
      (identity) =>
        alphaMaskShadowSubmission(preparedFrame, identity, shadowPipeline, opaqueMaterialBindGroup),
    );
    if (!shadowDepthsAdded) return;
    addTextureReadbackPass(
      graph,
      'gpu-driven.alpha-mask.opaque-readback',
      opaqueOutput,
      opaqueOutputView,
      opaqueReadback,
    );
    addTextureReadbackPass(
      graph,
      'gpu-driven.alpha-mask.discarded-readback',
      discardedOutput,
      discardedOutputView,
      discardedReadback,
    );
    addIndirectReadbackPass(
      graph,
      'gpu-driven.alpha-mask.shadow-indirect-readback',
      shadows.directional.indirect,
      shadowIndirectReadback,
    );
    addIndirectReadbackPass(
      graph,
      'gpu-driven.alpha-mask.point-shadow-indirect-readback',
      shadows.point.indirect,
      pointShadowIndirectReadback,
    );
    addIndirectReadbackPass(
      graph,
      'gpu-driven.alpha-mask.spot-shadow-indirect-readback',
      shadows.spot.indirect,
      spotShadowIndirectReadback,
    );
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const completed = await verifyCompiledAlphaMask({
        device,
        native,
        compiled: compiled.value,
        production,
        prepared: preparedFrame,
        prepareInput,
        source,
        persistentAssets,
        persistentScene,
        persistentWorld,
        persistentLease,
        persistentFrame,
        shadowViews,
        readbacks,
        shadowDepthReadbackBuffers,
        viewBindGroup: views.viewBindGroup,
        opaqueMaterialBindGroup,
        setDiscardedTexture: (discarded) => {
          currentOpaqueMaterialGroup = discarded
            ? discardedMaterialBindGroup
            : opaqueMaterialBindGroup;
        },
        coordinateSet,
        vertexColorAvailable,
      });
      if (!completed) return;
    }
    for (const buffer of [
      ...views.buffers,
      ...materials.buffers,
      ...Object.values(readbacks),
      ...shadowDepthReadbackBuffers.map(({ buffer }) => buffer),
    ]) {
      device.destroyBuffer(buffer);
    }
    for (const texture of [...materials.textures, ...views.textures])
      device.destroyTexture(texture);
    production.dispose();
    persistentScene.dispose();
    persistentLease.dispose();
    persistentAssets.dispose();
  });
});
