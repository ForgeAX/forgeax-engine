import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  deriveVertexBufferLayoutFromProjection,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
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
import { GpuDrivenProduction } from '../gpu-driven/production-raster';
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
import type { RenderPipelineFrame } from '../render-pipeline';
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
          skinPaletteAddress: receipt.skinPaletteAddress,
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
    const transformed = coordinateSet !== undefined;
    const standardPbrGpuVariant = vertexColorAvailable
      ? STANDARD_PBR_COLORED_GPU_VARIANT
      : STANDARD_PBR_GPU_VARIANT;
    const defaultGpuVariant = STANDARD_PBR_GPU_VARIANT;
    const { device, native } = await nativeDeviceFixture({
      requiredFeatures: [
        'depth32float-stencil8',
        ...(firstInstanceIndirect ? (['indirect-first-instance'] as const) : []),
      ],
    });
    expect(native.features.has('indirect-first-instance')).toBe(firstInstanceIndirect);
    expect(device.caps.firstInstanceIndirect).toBe(firstInstanceIndirect);
    expect(STANDARD_PBR_PRODUCER).toBeDefined();
    if (STANDARD_PBR_PRODUCER === undefined) return;
    expect(standardPbrGpuVariant).toBeDefined();
    if (standardPbrGpuVariant === undefined) return;
    expect(standardPbrGpuVariant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE).toBe(true);
    if (vertexColorAvailable) {
      expect(defaultGpuVariant).toBeDefined();
      if (defaultGpuVariant === undefined) return;
    }
    // Compile the exact cooked Standard PBR scene-index producer variant on
    // native Dawn. This is the same manifest branch selected by the renderer
    // for the storage-backed GPU-driven lane, including its production material
    // ABI and Alpha Mask discard path.
    const producerShader = await createShaderModule(device, {
      code: standardPbrGpuVariant.composedWgsl,
      label: `standard-pbr-gpu-driven-producer-alpha-mask${vertexColorAvailable ? '-vertex-color' : ''}`,
    });
    expect(
      producerShader.ok,
      producerShader.ok
        ? undefined
        : JSON.stringify({
            defines: standardPbrGpuVariant.defines,
            error: producerShader.error,
          }),
    ).toBe(true);
    if (!producerShader.ok) return;
    const defaultProducerShader = vertexColorAvailable
      ? await createShaderModule(device, {
          code: defaultGpuVariant?.composedWgsl ?? '',
          label: 'standard-pbr-gpu-driven-producer-alpha-mask-default',
        })
      : producerShader;
    expect(defaultProducerShader.ok).toBe(true);
    if (!defaultProducerShader.ok) return;
    expect(SHADOW_CASTER_PRODUCER).toBeDefined();
    expect(SHADOW_CASTER_GPU_ALPHA_VARIANT).toBeDefined();
    if (SHADOW_CASTER_GPU_ALPHA_VARIANT === undefined) return;
    const shadowCasterShader = (
      await createShaderModule(device, {
        code: SHADOW_CASTER_GPU_ALPHA_VARIANT.composedWgsl,
        label: 'shadow-caster-gpu-driven-producer-alpha-mask',
      })
    ).unwrap();
    expect(STANDARD_PBR_RECEIPT.alphaMask).toEqual({
      cutoff: 'alphaCutoff',
      source: 'baseColor.a',
    });
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
    const viewLayout = pbrLayouts.viewBgl;
    const materialLayout = pbrLayouts.materialBgl;
    const meshLayout = pbrLayouts.meshArrayBgl;
    const viewUniform = device
      .createBuffer({
        size: VIEW_UNIFORM_BUFFER_SIZE,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const shadowViewUniform = device
      .createBuffer({
        size: VIEW_UNIFORM_BUFFER_SIZE,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const directionalCascadeUniform = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const pointCascadeUniform = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const spotCascadeUniform = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
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
    const viewDepth = device
      .createTextureView(viewDepthTexture, { dimension: '2d-array' })
      .unwrap();
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
    const createShadowViewBindGroup = (cascadeBuffer: typeof directionalCascadeUniform) =>
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
    const directionalShadowViewBindGroup = createShadowViewBindGroup(directionalCascadeUniform);
    const pointShadowViewBindGroup = createShadowViewBindGroup(pointCascadeUniform);
    const spotShadowViewBindGroup = createShadowViewBindGroup(spotCascadeUniform);
    const camera = makeZeroCameraFallbackSnapshot();
    const identityLightMatrix = new Float32Array(16);
    identityLightMatrix[0] = 1;
    identityLightMatrix[5] = 1;
    identityLightMatrix[10] = 1;
    identityLightMatrix[15] = 1;
    writeViewUbo(
      device.queue,
      viewUniform,
      camera,
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
      { lightViewProj: [identityLightMatrix], point: [], spot: [], rect: [] } as never,
      [],
    );
    const shadowLightMatrix = new Float32Array(identityLightMatrix);
    shadowLightMatrix[10] = -1;
    shadowLightMatrix[14] = -1;
    writeViewUbo(
      device.queue,
      shadowViewUniform,
      camera,
      {
        kind: 'directional',
        direction: new Float32Array([0, 0, -1]) as never,
        color: new Float32Array([1, 1, 1]) as never,
        intensity: 1,
        contactShadowLength: 0,
      },
      { lightViewProj: [shadowLightMatrix], point: [], spot: [], rect: [] } as never,
      [],
    );
    device.queue.writeBuffer(directionalCascadeUniform, 0, new Uint32Array([0, 0, 0, 0])).unwrap();
    device.queue.writeBuffer(pointCascadeUniform, 0, new Uint32Array([0, 0, 0, 0])).unwrap();
    device.queue.writeBuffer(spotCascadeUniform, 0, new Uint32Array([0, 1, 0, 0])).unwrap();
    device.queue.writeBuffer(spotCascadeUniform, 16, shadowLightMatrix).unwrap();
    const opaqueMaterialBuffer = device
      .createBuffer({
        size: MATERIAL_PER_ENTITY_STRIDE,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const discardedMaterialBuffer = device
      .createBuffer({
        size: MATERIAL_PER_ENTITY_STRIDE,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const opaqueBaseColorTexture = device
      .createTexture({
        label: 'gpu-driven-alpha-mask.opaque-base-color',
        format: 'rgba8unorm',
        size: { width: transformed ? 4 : 1, height: 1, depthOrArrayLayers: 1 },
        usage: 0x06,
        dimension: '2d',
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const discardedBaseColorTexture = device
      .createTexture({
        label: 'gpu-driven-alpha-mask.discarded-base-color',
        format: 'rgba8unorm',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        usage: 0x06,
        dimension: '2d',
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    const opaqueBaseColorView = device
      .createTextureView(opaqueBaseColorTexture, {
        dimension: '2d',
      })
      .unwrap();
    const discardedBaseColorView = device
      .createTextureView(discardedBaseColorTexture, {
        dimension: '2d',
      })
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
        { bytesPerRow: transformed ? 16 : 4, rowsPerImage: 1 },
        { width: transformed ? 4 : 1, height: 1, depthOrArrayLayers: 1 },
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
    const persistentAssets = new AssetRegistry();
    const source = alphaMaskSnapshot(coordinateSet, vertexColorAvailable, persistentAssets);
    const persistentWorld = new World({ assets: persistentAssets });
    const persistentLease = createRenderReadLease(persistentWorld);
    const persistentScene = new PersistentRenderScene({
      getDevice: () => device,
      assets: persistentAssets,
    });
    const persistentFrame = {
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
      paletteUploadBytes: 0,
    });
    const iblStart = 1 + BUILTIN_USER_REGION_TEXTURE_FIELDS.length * 2;
    const omitted = omittedStandardMaterialBindings(
      BUILTIN_USER_REGION_TEXTURE_FIELDS,
      false,
      true,
      true,
    );
    const createMaterialEntries = (
      materialBuffer: typeof opaqueMaterialBuffer,
      baseColorView: typeof opaqueBaseColorView,
    ) =>
      [
        { binding: 0, resource: { kind: 'buffer' as const, value: { buffer: materialBuffer } } },
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
          resource: { kind: 'textureView' as const, value: materialCubeView },
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
            value: { buffer: scene.materialBuffer },
          },
        },
      ].filter((entry) => !omitted.has(entry.binding));
    const opaqueMaterialBindGroup = device
      .createBindGroup({
        layout: materialLayout,
        entries: createMaterialEntries(opaqueMaterialBuffer, opaqueBaseColorView),
      })
      .unwrap();
    const discardedMaterialBindGroup = device
      .createBindGroup({
        layout: materialLayout,
        entries: createMaterialEntries(discardedMaterialBuffer, discardedBaseColorView),
      })
      .unwrap();
    expect(initialGpuState.plan).toMatchObject({
      candidateCount: 1,
    });
    const shadowIdentities = [
      { kind: 'directional' as const, index: 0 },
      { kind: 'point' as const, index: 0, face: 0 },
      { kind: 'spot' as const, index: 0 },
    ] as const;
    const shadowViews = shadowIdentities.map((identity) => ({
      identity,
      planes: new Float32Array(24),
    }));
    const production = new GpuDrivenProduction(device, {
      createShaderModule: () => ok(viewShader as ShaderModule),
    });
    const gpuMesh = mesh(device, coordinateSet, vertexColorAvailable);
    const receipt = vertexColorAvailable ? STANDARD_PBR_COLORED_RECEIPT : STANDARD_PBR_RECEIPT;
    const artifact = {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram(standardPbrGpuVariant.composedWgsl),
      layoutIdentity: receipt.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: receipt.vertexInputs as unknown as readonly Readonly<Record<string, unknown>>[],
      receipt,
    } satisfies MaterialShaderArtifact;
    const programKey = standardPbrProgramKey(artifact.material, vertexColorAvailable);
    expect(programKey).toBeDefined();
    if (programKey === undefined) return;
    const defaultProgramKey = standardPbrProgramKey(artifact.material);
    expect(defaultProgramKey).toBeDefined();
    if (defaultProgramKey === undefined) return;
    const defaultArtifact: MaterialShaderArtifact = vertexColorAvailable
      ? {
          ...artifact,
          program: createMaterialShaderProgram(defaultGpuVariant?.composedWgsl ?? ''),
          layoutIdentity: STANDARD_PBR_RECEIPT.reflection.layoutIdentity,
          vertexInputs: STANDARD_PBR_RECEIPT.vertexInputs as unknown as readonly Readonly<
            Record<string, unknown>
          >[],
          receipt: STANDARD_PBR_RECEIPT,
        }
      : artifact;
    const gpuDrivenPbrPrograms = new Map<string, GpuDrivenPbrProgram>([
      [programKey, { module: producerShader.value, artifact }],
    ]);
    if (defaultProgramKey !== programKey) {
      gpuDrivenPbrPrograms.set(defaultProgramKey, {
        module: defaultProducerShader.value,
        artifact: defaultArtifact,
      });
    }
    const prepareInput = {
      scene: {
        scene,
        plan: initialGpuState.plan,
        slots: projection,
        slotAt: (index: number) => projection.find((slot) => slot.slot === index),
      },
      camera: makeZeroCameraFallbackSnapshot(),
      meshBySlot: new Map(projection.map((slot) => [slot.slot, gpuMesh])),
      viewBindGroupLayout: viewLayout,
      meshResidencyEpoch: 1,

      materialArtifact: artifact,
      materialPipelineState: {
        pbrPipelineLayout: pipelineLayout,
        gpuDrivenPbrPipelineLayout: pipelineLayout,
        meshBindGroupLayout: meshLayout,
        instancesBindGroupLayout: instancesLayout,
        gpuDrivenInstancesBindGroupLayout: instancesLayout,
        gpuDrivenPbrPrograms,
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
    const sourceSlot = projection.at(0);
    if (sourceSlot === undefined) throw Error('missing source slot');
    expect(
      prepared.value.selection.ownsSlot(source, 0, sourceSlot.slot, sourceSlot.generation),
    ).toBe(true);
    expect(prepared.value.standardPbrFrameResources.sceneMaterialBuffer).toBe(scene.materialBuffer);
    expect(typeof prepared.value.standardPbrFrameResources.prepareMaterialBinding).toBe('function');
    expect(artifact.receipt.alphaMask).toEqual({ cutoff: 'alphaCutoff', source: 'baseColor.a' });

    const shadowVertexLayout = deriveVertexBufferLayoutFromProjection(gpuMesh.layoutProjection, {
      shaderUvSetCount: 8,
    })[0];
    expect(shadowVertexLayout).toBeDefined();
    if (shadowVertexLayout === undefined) return;
    const shadowPipeline = device
      .createRenderPipeline({
        label: 'gpu-driven-alpha-mask-production-shadow-caster',
        layout: pipelineLayout,
        vertex: {
          module: shadowCasterShader,
          entryPoint: 'vs_scene_index',
          buffers: [
            {
              arrayStride: shadowVertexLayout.arrayStride,
              stepMode: 'vertex',
              attributes: shadowVertexLayout.attributes.map(
                ({ shaderLocation, offset, format }) => ({
                  shaderLocation,
                  offset,
                  format: format as GPUVertexFormat,
                }),
              ),
            },
          ],
        },
        fragment: {
          module: shadowCasterShader,
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

    const shadowUpdated = prepared.value.updateShadowViews?.(shadowViews);
    expect(shadowUpdated?.ok).toBe(true);
    expect(prepared.value.shadowBatchProjections?.get('directional:0:')).toBeDefined();
    expect(prepared.value.shadowBatchProjections?.get('point:0:0')).toBeDefined();
    expect(prepared.value.shadowBatchProjections?.get('spot:0:')).toBeDefined();

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const main = prepared.value.project(graph, 'rgba8unorm', 1);
    expect(main.ok).toBe(true);
    if (!main.ok) return;
    // The unmoved caster settles into each available static layer.
    const rasterIdentity = (identity: (typeof shadowIdentities)[number]): ShadowViewIdentity =>
      shadowViewHasStaticLayer(identity) ? { ...identity, layer: 'static' } : identity;
    const shadow = prepared.value.projectShadow?.(graph, rasterIdentity(shadowIdentities[0]));
    expect(shadow?.ok).toBe(true);
    if (shadow === undefined || !shadow.ok || shadow.value === undefined) return;
    if (shadow.value.graphResources === undefined) return;
    const shadowProjection = shadow.value;
    const shadowGraphResources = shadowProjection.graphResources;
    if (shadowGraphResources === undefined) return;
    const pointShadow = prepared.value.projectShadow?.(graph, rasterIdentity(shadowIdentities[1]));
    const spotShadow = prepared.value.projectShadow?.(graph, rasterIdentity(shadowIdentities[2]));
    expect(pointShadow?.ok).toBe(true);
    expect(spotShadow?.ok).toBe(true);
    if (
      pointShadow === undefined ||
      !pointShadow.ok ||
      pointShadow.value === undefined ||
      pointShadow.value.graphResources === undefined ||
      spotShadow === undefined ||
      !spotShadow.ok ||
      spotShadow.value === undefined ||
      spotShadow.value.graphResources === undefined
    )
      return;
    const pointShadowGraphResources = pointShadow.value.graphResources;
    const spotShadowGraphResources = spotShadow.value.graphResources;
    const frameResources = prepared.value.standardPbrFrameResources;

    const shadowDepthTargets = shadowIdentities.map((identity) => {
      const texture = graph
        .createTexture(`gpu-driven-alpha-mask.${identity.kind}-shadow-depth`, {
          format: 'depth32float',
          size: { width: 1, height: 1 },
        })
        .unwrap();
      return { identity, texture, view: graph.view(texture).unwrap() };
    });
    const shadowDepthReadbackBuffers = shadowIdentities.map((identity) => ({
      identity,
      buffer: device
        .createBuffer({
          label: `gpu-driven-alpha-mask.${identity.kind}-shadow-depth-readback`,
          size: 256,
          usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
        })
        .unwrap(),
    }));
    const shadowDepthReadbackResources = shadowDepthReadbackBuffers.map(({ identity, buffer }) => ({
      identity,
      buffer,
      resource: graph
        .importBuffer(
          `gpu-driven-alpha-mask.${identity.kind}-shadow-depth-readback`,
          { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
          () => buffer,
        )
        .unwrap(),
    }));
    const makeShadowSubmission = (
      identity: (typeof shadowIdentities)[number],
    ): GpuDrivenShadowSubmission | undefined => {
      const preparedFrame = prepared.value;
      if (preparedFrame === undefined) return undefined;
      const raster = rasterIdentity(identity);
      const submission = preparedFrame.shadowViewPool?.submission(raster);
      const projections = preparedFrame.shadowBatchProjections?.get(shadowViewIdentityKey(raster));
      if (submission === undefined || projections === undefined) return undefined;
      const batches: GpuDrivenShadowBatch[] = [];
      for (const batch of submission.plan.batches) {
        const projection = projections.get(batch.batchId);
        if (projection === undefined) return undefined;
        const indexBuffer = projection.mesh.indexBuffer;
        batches.push({
          indirectOffset: batch.indirectOffset,
          pipeline: shadowPipeline,
          meshBindGroup: projection.meshBindGroup,
          visibleBindGroups: projection.visibleBindGroups,
          deformation: projection.deformation,
          materialGroup: opaqueMaterialBindGroup,
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
    };

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
    const opaqueReadbackBuffer = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const discardedReadbackBuffer = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const shadowIndirectReadbackBuffer = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const pointShadowIndirectReadbackBuffer = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const spotShadowIndirectReadbackBuffer = device
      .createBuffer({
        size: 256,
        usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
      })
      .unwrap();
    const opaqueReadback = graph
      .importBuffer(
        'gpu-driven-alpha-mask-opaque-readback',
        { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => opaqueReadbackBuffer,
      )
      .unwrap();
    const discardedReadback = graph
      .importBuffer(
        'gpu-driven-alpha-mask-discarded-readback',
        { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => discardedReadbackBuffer,
      )
      .unwrap();
    const shadowIndirectReadback = graph
      .importBuffer(
        'gpu-driven-alpha-mask-shadow-indirect-readback',
        { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => shadowIndirectReadbackBuffer,
      )
      .unwrap();
    const pointShadowIndirectReadback = graph
      .importBuffer(
        'gpu-driven-alpha-mask-point-shadow-indirect-readback',
        { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => pointShadowIndirectReadbackBuffer,
      )
      .unwrap();
    const spotShadowIndirectReadback = graph
      .importBuffer(
        'gpu-driven-alpha-mask-spot-shadow-indirect-readback',
        { size: 256, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
        () => spotShadowIndirectReadbackBuffer,
      )
      .unwrap();
    let currentOpaqueMaterialGroup = opaqueMaterialBindGroup;
    const addAlphaMaskRaster = (
      name: string,
      outputView: typeof opaqueOutputView,
      materialBindGroup: () => typeof opaqueMaterialBindGroup,
    ) =>
      graph
        .addRasterPass(name, {
          accesses: [
            ...main.value.accesses,
            { resource: outputView, usage: 'color-attachment' },
            { resource: depthView, usage: 'depth-stencil-write' },
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
            view: depthView,
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
          },
          encode: ({ pass, resources }) =>
            main.value.encode(viewBindGroup, pass, resources, {
              ...frameResources,
              prepareMaterialBinding: (
                (groups: readonly (import('@forgeax/engine-rhi').BindGroup | undefined)[]) =>
                (slot: number) => {
                  const group = groups[slot];
                  return group === undefined ? undefined : { group, byteOffset: slot * 1280 };
                }
              )([materialBindGroup()]),
            }),
        })
        .unwrap();
    addAlphaMaskRaster(
      'gpu-driven.alpha-mask.opaque',
      opaqueOutputView,
      () => currentOpaqueMaterialGroup,
    );
    addAlphaMaskRaster(
      'gpu-driven.alpha-mask.discarded',
      discardedOutputView,
      () => discardedMaterialBindGroup,
    );
    const shadowViewBindGroups = new Map([
      ['directional', directionalShadowViewBindGroup],
      ['point', pointShadowViewBindGroup],
      ['spot', spotShadowViewBindGroup],
    ] as const);
    const shadowGraphResourcesByKind = new Map([
      ['directional', shadowGraphResources],
      ['point', pointShadowGraphResources],
      ['spot', spotShadowGraphResources],
    ] as const);
    for (const target of shadowDepthTargets) {
      const submission = makeShadowSubmission(target.identity);
      const resources = shadowGraphResourcesByKind.get(target.identity.kind);
      const shadowViewGroup = shadowViewBindGroups.get(target.identity.kind);
      const readback = shadowDepthReadbackResources.find(
        ({ identity }) => identity.kind === target.identity.kind,
      );
      expect(submission).toBeDefined();
      expect(resources).toBeDefined();
      expect(shadowViewGroup).toBeDefined();
      expect(readback).toBeDefined();
      if (
        submission === undefined ||
        resources === undefined ||
        shadowViewGroup === undefined ||
        readback === undefined
      )
        return;
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
      graph
        .addCopyPass(`gpu-driven.alpha-mask.${target.identity.kind}-shadow-depth-readback`, {
          accesses: [
            { resource: target.view, usage: 'copy-src' },
            { resource: readback.resource, usage: 'copy-dst' },
          ],
          encode: ({ encoder, resources: graphResources }) =>
            encoder.copyTextureToBuffer(
              { texture: graphResources.texture(target.texture).unwrap() },
              {
                buffer: graphResources.buffer(readback.resource).unwrap(),
                bytesPerRow: 256,
                rowsPerImage: 1,
              },
              { width: 1, height: 1, depthOrArrayLayers: 1 },
            ),
        })
        .unwrap();
    }
    graph
      .addCopyPass('gpu-driven.alpha-mask.opaque-readback', {
        accesses: [
          { resource: opaqueOutputView, usage: 'copy-src' },
          { resource: opaqueReadback, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(opaqueOutput).unwrap() },
            {
              buffer: resources.buffer(opaqueReadback).unwrap(),
              bytesPerRow: 256,
              rowsPerImage: 1,
            },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    graph
      .addCopyPass('gpu-driven.alpha-mask.discarded-readback', {
        accesses: [
          { resource: discardedOutputView, usage: 'copy-src' },
          { resource: discardedReadback, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(discardedOutput).unwrap() },
            {
              buffer: resources.buffer(discardedReadback).unwrap(),
              bytesPerRow: 256,
              rowsPerImage: 1,
            },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    graph
      .addCopyPass('gpu-driven.alpha-mask.shadow-indirect-readback', {
        accesses: [
          { resource: shadowGraphResources.indirect, usage: 'copy-src' },
          { resource: shadowIndirectReadback, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyBufferToBuffer(
            resources.buffer(shadowGraphResources.indirect).unwrap(),
            0,
            resources.buffer(shadowIndirectReadback).unwrap(),
            0,
            20,
          ),
      })
      .unwrap();
    graph
      .addCopyPass('gpu-driven.alpha-mask.point-shadow-indirect-readback', {
        accesses: [
          { resource: pointShadowGraphResources.indirect, usage: 'copy-src' },
          { resource: pointShadowIndirectReadback, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyBufferToBuffer(
            resources.buffer(pointShadowGraphResources.indirect).unwrap(),
            0,
            resources.buffer(pointShadowIndirectReadback).unwrap(),
            0,
            20,
          ),
      })
      .unwrap();
    graph
      .addCopyPass('gpu-driven.alpha-mask.spot-shadow-indirect-readback', {
        accesses: [
          { resource: spotShadowGraphResources.indirect, usage: 'copy-src' },
          { resource: spotShadowIndirectReadback, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyBufferToBuffer(
            resources.buffer(spotShadowGraphResources.indirect).unwrap(),
            0,
            resources.buffer(spotShadowIndirectReadback).unwrap(),
            0,
            20,
          ),
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const names = compiled.value.inspect().passes.map((pass) => pass.name);
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
      const encoder = device.createCommandEncoder({ label: 'gpu-driven-alpha-mask-dawn' }).unwrap();
      expect(compiled.value.execute({ encoder } as unknown as RenderPipelineFrame).ok).toBe(true);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      prepared.value._commitResourceReplacement();
      expect(production.inspect().worldEntitiesScanned).toBe(1);
      expect(production.inspect().sceneTableUploadBytes).toBeGreaterThan(0);
      expect(production.inspect().paletteUploadBytes).toBe(0);
      persistentScene.extractComposition(
        [persistentWorld],
        { cameraOwner: 0, resourceOwner: 0 },
        persistentAssets,
        () => persistentFrame,
        [persistentLease],
      );
      const stableGpuState = persistentScene.compositionGpuDrivenState();
      expect(stableGpuState).toBeDefined();
      if (stableGpuState === undefined) return;
      const stableMetrics = stableGpuState.structureMetrics;
      if (stableMetrics === undefined) return;
      expect(stableMetrics).toEqual({
        worldEntitiesScanned: 0,
        sceneTableUploadBytes: 0,
        paletteUploadBytes: 0,
      });
      const stablePrepared = production.prepare(
        admitPbrDawnFixture({
          ...prepareInput,
          scene: stableGpuState,
          structureMetrics: stableMetrics,
          // Admit the same binding-input domain before measuring stable frames.
          // No-map inputs do not observe source binding keys; a first map must.
        }),
      );
      expect(stablePrepared.ok).toBe(true);
      if (!stablePrepared.ok || stablePrepared.value === undefined) return;
      const stableShadowUpdated = stablePrepared.value.updateShadowViews?.(shadowViews);
      expect(stableShadowUpdated?.ok).toBe(true);
      stablePrepared.value._commitResourceReplacement();
      const stableBaseline = production.inspect();
      const stableFrameInspections: Array<{
        readonly gpuOwnedSnapshotsMaterialized: number;
        readonly filteredPlanBuilds: number;
        readonly sharedInputUploadBytes: number;
        readonly batchUploadBytes: number;
        readonly batchBindGroupCreates: number;
        readonly validatedGpuOwnedRows: number;
        readonly cpuFallbackDrawItems: number;
        readonly cpuValidationScans: number;
        readonly cpuValidationCacheHits: number;
        readonly worldEntitiesScanned: number;
        readonly sceneTableUploadBytes: number;
        readonly paletteUploadBytes: number;
        readonly overflow: boolean;
      }> = [];
      const stableFrameMetrics: Array<NonNullable<typeof stableGpuState.structureMetrics>> = [];
      for (let frame = 0; frame < STABLE_FRAME_COUNT; frame += 1) {
        persistentScene.extractComposition(
          [persistentWorld],
          { cameraOwner: 0, resourceOwner: 0 },
          persistentAssets,
          () => persistentFrame,
          [persistentLease],
        );
        const frameGpuState = persistentScene.compositionGpuDrivenState();
        expect(frameGpuState).toBeDefined();
        if (frameGpuState === undefined || frameGpuState.structureMetrics === undefined) return;
        stableFrameMetrics.push(frameGpuState.structureMetrics);
        // Prepare every submitted frame to detect topology/upload leaks.
        const framePrepared = production.prepare(
          admitPbrDawnFixture({
            ...prepareInput,
            scene: frameGpuState,
            structureMetrics: frameGpuState.structureMetrics,
            // CPU-only material publication changes cannot invalidate this GPU plan.
          }),
        );
        expect(framePrepared.ok).toBe(true);
        if (!framePrepared.ok || framePrepared.value === undefined) return;
        expect(framePrepared.value.updateShadowViews?.(shadowViews)?.ok).toBe(true);
        framePrepared.value._commitResourceReplacement();

        const stableEncoder = device
          .createCommandEncoder({ label: `gpu-driven-alpha-mask-stable-${frame}` })
          .unwrap();
        expect(
          compiled.value.execute({ encoder: stableEncoder } as unknown as RenderPipelineFrame).ok,
        ).toBe(true);
        device.queue.submit([stableEncoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const inspection = production.inspect();
        stableFrameInspections.push({
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
        });
      }
      expect(stableFrameInspections).toHaveLength(STABLE_FRAME_COUNT);
      expect(stableFrameMetrics).toHaveLength(STABLE_FRAME_COUNT);
      for (const metrics of stableFrameMetrics) {
        expect(metrics).toEqual({
          worldEntitiesScanned: 0,
          sceneTableUploadBytes: 0,
          paletteUploadBytes: 0,
        });
      }
      for (const inspection of stableFrameInspections) {
        expect(inspection).toEqual({
          gpuOwnedSnapshotsMaterialized: 0,
          filteredPlanBuilds: 0,
          sharedInputUploadBytes: 0,
          batchUploadBytes: 0,
          batchBindGroupCreates: 0,
          validatedGpuOwnedRows: 0,
          cpuFallbackDrawItems: 0,
          cpuValidationScans: stableBaseline.cpuValidationScans,
          cpuValidationCacheHits: expect.any(Number),
          worldEntitiesScanned: 0,
          sceneTableUploadBytes: 0,
          paletteUploadBytes: 0,
          overflow: false,
        });
      }
      expect(production.inspect().cpuValidationScans).toBe(stableBaseline.cpuValidationScans);
      expect(production.inspect().cpuValidationCacheHits).toBe(
        stableBaseline.cpuValidationCacheHits,
      );
      if (!transformed && !vertexColorAvailable) {
        await verifyRetainedRasterClass({
          device,
          compiled: compiled.value,
          production,
          prepareInput,
          source,
          persistentScene,
          persistentWorld,
          persistentLease,
          persistentFrame,
          discardedReadbackBuffer,
          opaqueReadbackBuffer,
          setDiscardedTexture: (discarded) => {
            currentOpaqueMaterialGroup = discarded
              ? discardedMaterialBindGroup
              : opaqueMaterialBindGroup;
          },
          shadowViews,
          topologySignature: stablePrepared.value.topologySignature,
        });
      }
      const opaqueMapped = (
        await opaqueReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
      ).unwrap();
      const opaquePixel = [...new Uint8Array(opaqueMapped.getMappedRange().unwrap().slice(0, 4))];
      opaqueMapped.unmap();
      const discardedMapped = (
        await discardedReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
      ).unwrap();
      const discardedPixel = [
        ...new Uint8Array(discardedMapped.getMappedRange().unwrap().slice(0, 4)),
      ];
      discardedMapped.unmap();
      const shadowIndirectMapped = (
        await shadowIndirectReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
      ).unwrap();
      const shadowIndirect = new Uint32Array(
        shadowIndirectMapped.getMappedRange().unwrap().slice(0, 20),
      );
      shadowIndirectMapped.unmap();
      const pointShadowIndirectMapped = (
        await pointShadowIndirectReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
      ).unwrap();
      const pointShadowIndirect = new Uint32Array(
        pointShadowIndirectMapped.getMappedRange().unwrap().slice(0, 20),
      );
      pointShadowIndirectMapped.unmap();
      const spotShadowIndirectMapped = (
        await spotShadowIndirectReadbackBuffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)
      ).unwrap();
      const spotShadowIndirect = new Uint32Array(
        spotShadowIndirectMapped.getMappedRange().unwrap().slice(0, 20),
      );
      spotShadowIndirectMapped.unmap();
      expect(opaquePixel[0]).toBeGreaterThan(0);
      if (vertexColorAvailable) {
        expect(opaquePixel[0]).toBeGreaterThan(opaquePixel[1] ?? Number.NaN);
      } else {
        expect(opaquePixel[1]).toBeGreaterThan(0);
      }
      expect(discardedPixel).toEqual([0, 0, 0, 0]);
      expect(Array.from(shadowIndirect.slice(0, 2))).toEqual([3, 1]);
      expect(Array.from(pointShadowIndirect.slice(0, 2))).toEqual([3, 1]);
      expect(Array.from(spotShadowIndirect.slice(0, 2))).toEqual([3, 1]);
      for (const { identity, buffer } of shadowDepthReadbackBuffers) {
        const mapped = (await buffer.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
        const depth = new Float32Array(mapped.getMappedRange().unwrap().slice(0, 4))[0] ?? 1;
        mapped.unmap();
        expect(depth, `${identity.kind} shadow depth raster readback`).toBeGreaterThan(0);
      }
      if (coordinateSet === 1 && !vertexColorAvailable) {
        await verifyRetainedRasterRouting({
          device,
          native,
          production,
          prepareInput,
          source,
          persistentScene,
          persistentWorld,
          persistentLease,
          persistentFrame,
          viewBindGroup,
          materialBindGroup: opaqueMaterialBindGroup,
        });
      }
      (await compiled.value.retire()).unwrap();
    }
    for (const buffer of [
      viewUniform,
      opaqueMaterialBuffer,
      discardedMaterialBuffer,
      opaqueReadbackBuffer,
      discardedReadbackBuffer,
      shadowIndirectReadbackBuffer,
      pointShadowIndirectReadbackBuffer,
      spotShadowIndirectReadbackBuffer,
      ...shadowDepthReadbackBuffers.map(({ buffer }) => buffer),
    ]) {
      device.destroyBuffer(buffer);
    }
    device.destroyTexture(opaqueBaseColorTexture);
    device.destroyTexture(discardedBaseColorTexture);
    device.destroyTexture(viewDepthTexture);
    device.destroyTexture(pointShadowTexture);
    device.destroyTexture(materialCubeTexture);
    device.destroyBuffer(shadowViewUniform);
    device.destroyBuffer(directionalCascadeUniform);
    device.destroyBuffer(pointCascadeUniform);
    device.destroyBuffer(spotCascadeUniform);
    production.dispose();
    persistentScene.dispose();
    persistentLease.dispose();
    persistentAssets.dispose();
  });
});
