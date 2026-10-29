// Generation-owned boot resources for one ready device: pipeline layouts,
// shared uniform/storage buffers, default samplers and neutral fallback
// textures. Callers pass scope-adopting factories so the renderer generation
// retires every persistent allocation.

import type {
  BindGroupLayout,
  Buffer,
  PipelineLayout,
  RhiDevice,
  RhiQueue,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { ok, RhiError } from '@forgeax/engine-rhi';
import { DEFAULT_UNLIT_PARAM_SCHEMA, type ShaderCatalog } from '@forgeax/engine-shader';
import { GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING } from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import {
  createSkylightFallback,
  type SkylightFallback,
  texelFallbackDescriptor,
  writeTexelFallback,
} from '../ibl/skylight-bind-group';
import type { DeviceScope, RhiErrorListenerRegistry } from '../lifecycle';
import { buildPbrPipelineLayouts, type PbrPipelineLayoutBundle } from '../pbr-pipeline';
import {
  buildBindGroupLayoutDescriptor,
  createHdrpBindGroupLayoutDescriptor,
} from '../pipeline-spec';
import { MESH_PER_ENTITY_STRIDE, MESH_UBO_FULL_ARRAY_BYTES } from '../record/mesh-ssbo';
import { MATERIAL_UNIFORM_BYTES } from '../record/render-context';
import {
  initializeShadowCasterUniforms,
  SHADOW_CASTER_BUFFER_SIZE,
} from '../record/shadow-caster-uniforms';
import { SHADOW_PARAMS_BYTES, VIEW_UNIFORM_BUFFER_SIZE } from '../record/view-ubo';
import { MATERIAL_PER_ENTITY_STRIDE } from '../render-system';
import { transmissionBackdropAvailable } from './device-feature-admission';
import {
  createMeshSsboGrowController,
  INITIAL_MESH_SSBO_SLOT_COUNT,
  type MeshSsboGrowDevice,
} from './mesh-ssbo-grow';
import { runShimSyncStep } from './renderer-helpers';
import type { ReadyDeviceCapabilities } from './webgpu-ready-shaders';

type CreatePersistentBuffer = RhiDevice['createBuffer'];
type CreatePersistentTexture = RhiDevice['createTexture'];

/** Neutral 3D volume read when atmosphere is admitted but no medium is published. */
export function createAtmosphereFallbackView(
  device: RhiDevice,
  createPersistentTexture: CreatePersistentTexture,
): TextureView {
  const descriptor = texelFallbackDescriptor('atmosphere-neutral-volume', 'rgba8unorm', '3d');
  const texture = createPersistentTexture(descriptor).unwrap();
  writeTexelFallback(device.queue, texture, descriptor, new Uint8Array(4)).unwrap();
  return device.createTextureView(texture, { dimension: '3d' }).unwrap();
}

/** The four Standard BGLs and their shared four-slot pipeline layout. */
export function buildReadyPbrLayouts(
  device: RhiDevice,
  caps: ReadyDeviceCapabilities,
): PbrPipelineLayoutBundle {
  const layouts = runShimSyncStep(
    () =>
      ok(
        buildPbrPipelineLayouts(device, {
          storageBuffer: caps.storageBuffer,
          extendedLighting: caps.extendedLighting,
          atmosphere: caps.atmosphere,
          projectorAvailable: caps.projector,
          transmissionBackdrop: transmissionBackdropAvailable(
            device.limits.maxSampledTexturesPerShaderStage,
          ),
        }),
      ),
    'webgpu-runtime-error',
    'buildPbrPipelineLayouts succeeded',
    'check device.limits.maxBindingsPerBindGroup (need >=14) and maxBindGroupsPerPipelineLayout',
  );
  if (!layouts.ok) throw layouts.error;
  return layouts.value;
}

/** Unlit swaps the merged PBR material slot for its own default-schema layout. */
export function buildUnlitPipelineLayout(
  device: RhiDevice,
  registry: ShaderCatalog,
  storageBuffer: boolean,
  pbrLayouts: PbrPipelineLayoutBundle,
): PipelineLayout {
  const unlitMaterialLayout = device
    .createBindGroupLayout(
      buildBindGroupLayoutDescriptor(
        {
          shader: { id: 'forgeax::default-unlit', passKind: 'forward', variantSet: undefined },
          attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
          geometry: { topology: 'triangle-list', vertexLayout: {} },
          renderState: undefined,
        },
        {
          kind: 'pbr-material-merged',
          registry,
          materialParamSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
          caps: {
            storageBuffer,
            transmissionBackdrop: transmissionBackdropAvailable(
              device.limits.maxSampledTexturesPerShaderStage,
            ),
          },
        },
      ),
    )
    .unwrap();
  return device
    .createPipelineLayout({
      label: 'unlit-pipeline-layout',
      bindGroupLayouts: [
        pbrLayouts.viewBgl,
        unlitMaterialLayout,
        pbrLayouts.meshArrayBgl,
        pbrLayouts.instancesBgl,
      ],
    })
    .unwrap();
}

export interface HdrpPipelineLayouts {
  /** Unified clustered group(2) layout shared by HDRP and GPU-driven cluster draws. */
  readonly unifiedBgl: BindGroupLayout | null;
  readonly pbrPipelineLayout: PipelineLayout | null;
  readonly probePbrPipelineLayout: PipelineLayout | null;
}

/**
 * HDRP variants bind the unified clustered group(2) instead of the mesh-array
 * slot. Failures leave the layouts null so variant selection falls back to
 * the URP layout rather than disabling every HDRP-variant build.
 */
export function buildHdrpPipelineLayouts(
  device: RhiDevice,
  storageBuffer: boolean,
  pbrLayouts: PbrPipelineLayoutBundle,
): HdrpPipelineLayouts {
  const unified = device.createBindGroupLayout(createHdrpBindGroupLayoutDescriptor(storageBuffer));
  if (!unified.ok)
    return { unifiedBgl: null, pbrPipelineLayout: null, probePbrPipelineLayout: null };
  const pipelineLayout = device.createPipelineLayout({
    label: 'hdrp-pbr-pl',
    bindGroupLayouts: [
      pbrLayouts.viewBgl,
      pbrLayouts.materialBgl,
      unified.value,
      pbrLayouts.instancesBgl,
    ],
  });
  const probePipelineLayout = storageBuffer
    ? device.createPipelineLayout({
        label: 'hdrp-probe-pbr-pl',
        bindGroupLayouts: [
          pbrLayouts.viewBgl,
          pbrLayouts.materialBgl,
          unified.value,
          pbrLayouts.probeInstancesBgl,
        ],
      })
    : undefined;
  return {
    unifiedBgl: unified.value,
    pbrPipelineLayout: pipelineLayout.ok ? pipelineLayout.value : null,
    probePbrPipelineLayout: probePipelineLayout?.ok === true ? probePipelineLayout.value : null,
  };
}

/**
 * GPU-driven Standard batches use the compact scene-index slot(3) while keeping
 * the clustered group(2) bind group the ordinary main pass publishes; a URP
 * mesh-array layout would validate the indirect draw but reject that group.
 */
export function createGpuDrivenClusterPipelineLayout(
  device: RhiDevice,
  label: string,
  pbrLayouts: PbrPipelineLayoutBundle,
  meshBindGroupLayout: BindGroupLayout | null,
  instancesBindGroupLayout: BindGroupLayout | null,
): PipelineLayout | null {
  if (meshBindGroupLayout === null || instancesBindGroupLayout === null) return null;
  const result = device.createPipelineLayout({
    label,
    bindGroupLayouts: [
      pbrLayouts.viewBgl,
      pbrLayouts.materialBgl,
      meshBindGroupLayout,
      instancesBindGroupLayout,
    ],
  });
  return result.ok ? result.value : null;
}

function createUniformBuffer(
  createPersistentBuffer: CreatePersistentBuffer,
  label: string,
  size: number,
  expected: string,
  hint: string,
): Buffer {
  const result = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label,
        size,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    expected,
    hint,
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/** Pipeline-scoped View UBO, rewritten by queue.writeBuffer each frame. */
export function createViewUniformBuffer(createPersistentBuffer: CreatePersistentBuffer): Buffer {
  return createUniformBuffer(
    createPersistentBuffer,
    'pbr-view-ubo',
    VIEW_UNIFORM_BUFFER_SIZE,
    'createBuffer (view ubo) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
}

/**
 * Per-pass cascade/spot UBO read by shadow_caster.wgsl. Its fixed headers are
 * prepared here; recording updates only the dynamic spot matrices.
 */
export function createShadowCasterCascadeBuffer(
  createPersistentBuffer: CreatePersistentBuffer,
  queue: RhiQueue,
): Buffer {
  const buffer = createUniformBuffer(
    createPersistentBuffer,
    'shadow-caster-cascade-ubo',
    SHADOW_CASTER_BUFFER_SIZE,
    'createBuffer (shadow-caster cascade ubo) succeeded',
    'check device.limits.maxUniformBufferBindingSize',
  );
  return initializeShadowCasterUniforms(queue, buffer);
}

/**
 * Mesh and material arenas. Storage-capable draws share one growable arena;
 * WebGL2 binds bounded uniform pages matching its `array<Mesh, 128>` variant.
 * The candidate scope owns allocation rollback and generation retirement.
 */
export function createReadyMeshSsboController(
  device: RhiDevice,
  scope: DeviceScope,
  errorRegistry: RhiErrorListenerRegistry,
  storageBuffer: boolean,
): ReturnType<typeof createMeshSsboGrowController> {
  const growDevice: MeshSsboGrowDevice = {
    limits: device.limits,
    createBuffer: (descriptor) => {
      const result = device.createBuffer(descriptor);
      if (!result.ok) throw result.error;
      return result.value;
    },
    destroyBuffer: (buffer) => {
      const result = device.destroyBuffer(buffer);
      if (!result.ok) errorRegistry.fire(result.error);
    },
  };
  const controller = createMeshSsboGrowController({
    device: growDevice,
    scope,
    meshStride: MESH_PER_ENTITY_STRIDE,
    meshBindingSize: storageBuffer ? MESH_PER_ENTITY_STRIDE : MESH_UBO_FULL_ARRAY_BYTES,
    materialBindingSize: MATERIAL_UNIFORM_BYTES,
    uniformPages: !storageBuffer,
    errorRegistry,
    initialSlotCount: INITIAL_MESH_SSBO_SLOT_COUNT,
    materialStride: MATERIAL_PER_ENTITY_STRIDE,
    meshUsage: storageBuffer
      ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
      : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    materialUsage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const initialBuild = runShimSyncStep<true>(
    () => {
      controller.initialBuild();
      return ok(true as const);
    },
    'webgpu-runtime-error',
    'createBuffer (mesh ssbo + material ubo initial build) succeeded',
    'check device.limits.maxStorageBufferBindingSize / maxUniformBufferBindingSize',
  );
  if (!initialBuild.ok) throw initialBuild.error;
  return controller;
}

/**
 * Identity InstanceData bound at @group(3) by every draw without Instances.
 * It is sized for the largest variant (sprite region: mat4 + vec4 = 80 B) so
 * both the 64 B PBR and 80 B region layouts pass min-binding-size validation.
 * Storage InstanceData carries current + previous transforms, so the identity
 * mat4 fills both slots; uniform variants read only the first.
 */
export function createIdentityInstanceBuffer(
  createPersistentBuffer: CreatePersistentBuffer,
  queue: RhiDevice['queue'],
  storageBuffer: boolean,
): Buffer {
  const buffer = runShimSyncStep(
    () =>
      createPersistentBuffer({
        label: 'pbr-identity-instance-ssbo',
        size: storageBuffer ? 128 : 80 * 128,
        usage: storageBuffer
          ? GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST
          : GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    'createBuffer (identity instance ssbo) succeeded',
    'check device.limits.maxStorageBufferBindingSize',
  );
  if (!buffer.ok) throw buffer.error;
  const payload = new Float32Array(storageBuffer ? 32 : 16);
  for (const base of storageBuffer ? [0, 16] : [0]) {
    payload[base] = 1;
    payload[base + 5] = 1;
    payload[base + 10] = 1;
    payload[base + 15] = 1;
  }
  const write = runShimSyncStep(
    () => queue.writeBuffer(buffer.value, 0, payload),
    'queue-write-buffer-out-of-bounds',
    'queue.writeBuffer (identity instance ssbo) succeeded',
    'verify offset alignment and bounds against buffer.size',
  );
  if (!write.ok) throw write.error;
  return buffer.value;
}

function createReadySampler(
  device: RhiDevice,
  descriptor: Parameters<RhiDevice['createSampler']>[0],
  expected: string,
): Sampler {
  const result = runShimSyncStep(
    () => device.createSampler(descriptor),
    'webgpu-runtime-error',
    expected,
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!result.ok) throw result.error;
  return result.value;
}

export interface ReadySamplers {
  /** Filtering material sampler (linear, repeat) for absent texture slots. */
  readonly defaultSampler: Sampler;
  /** r32float Surface raw-depth views are unfilterable and need a distinct sampler. */
  readonly surfaceMediumDepthSampler: Sampler;
  /** Comparison sampler behind textureSampleCompareLevel shadow reads. */
  readonly shadowSampler: Sampler;
}

export function createReadySamplers(device: RhiDevice): ReadySamplers {
  return {
    defaultSampler: createReadySampler(
      device,
      {
        label: 'default-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      },
      'createSampler (default) succeeded',
    ),
    surfaceMediumDepthSampler: createReadySampler(
      device,
      {
        label: 'surface-medium-depth-sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
      'createSampler (single-layer medium raw depth) succeeded',
    ),
    shadowSampler: createReadySampler(
      device,
      {
        label: 'shadow-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        compare: 'greater-equal',
      },
      'createSampler (shadow) succeeded',
    ),
  };
}

/**
 * 1x1 neutral material texel. `white` multiplies by one for absent baseColor /
 * metallicRoughness maps; `normal` is half float because RGBA8 cannot encode
 * 0.5 exactly and (1, 1) tangent XY would make the reconstructed Z NaN.
 */
export function createTexelFallbackView(
  device: RhiDevice,
  createPersistentTexture: CreatePersistentTexture,
  kind: 'white' | 'normal',
  format: Parameters<typeof texelFallbackDescriptor>[1],
  texel: Uint8Array | Uint16Array,
): TextureView {
  const descriptor = texelFallbackDescriptor(`fallback-${kind}-1x1`, format);
  const texture = runShimSyncStep(
    () => createPersistentTexture(descriptor),
    'webgpu-runtime-error',
    `createTexture (fallback ${kind}) succeeded`,
    'check device.limits.maxTextureDimension2D',
  );
  if (!texture.ok) throw texture.error;
  const write = runShimSyncStep(
    () => writeTexelFallback(device.queue, texture.value, descriptor, texel),
    'queue-write-buffer-out-of-bounds',
    `queue.writeTexture (fallback ${kind} pixel) succeeded`,
    'verify bytesPerRow / rowsPerImage alignment',
  );
  if (!write.ok) throw write.error;
  const view = runShimSyncStep(
    () =>
      device.createTextureView(texture.value, {
        label: `fallback-${kind}-view`,
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    `createTextureView (fallback ${kind}) succeeded`,
    kind === 'white'
      ? 'check fallback texture format / usage'
      : 'check fallback normal texture format / usage',
  );
  if (!view.ok) throw view.error;
  return view.value;
}

/** Clear one depth attachment so compare sampling reads it as unoccluded. */
function clearDepthAttachment(device: RhiDevice, view: TextureView, encoderLabel: string): void {
  const encoder = device.createCommandEncoder({ label: encoderLabel });
  if (!encoder.ok) throw encoder.error;
  const pass = encoder.value.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  } as never);
  pass.end();
  const finished = encoder.value.finish();
  if (!finished.ok) throw finished.error;
  const submitted = device.queue.submit([finished.value]);
  if (!submitted.ok) throw submitted.error;
}

/** 1x1 depth32float 2D fallback for scene-depth consumers, cleared before use. */
export function createShadowFallbackDepthView(
  device: RhiDevice,
  createPersistentTexture: CreatePersistentTexture,
): TextureView {
  const texture = runShimSyncStep(
    () =>
      createPersistentTexture({
        label: 'shadow-fallback-depth-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    'webgpu-runtime-error',
    'createTexture (shadow fallback depth) succeeded',
    'check device.limits.maxTextureDimension2D',
  );
  if (!texture.ok) throw texture.error;
  const view = runShimSyncStep(
    () =>
      device.createTextureView(texture.value, {
        label: 'shadow-fallback-depth-view',
        dimension: '2d',
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow fallback depth) succeeded',
    'check shadow fallback texture format / usage',
  );
  if (!view.ok) throw view.error;
  clearDepthAttachment(device, view.value, 'shadow-fallback-clear-encoder');
  return view.value;
}

/**
 * 1x1x6 depth cube-array fallback for the point-shadow binding when no point
 * shadow is active. Cube views cannot be attachments, so each face is cleared
 * through its own 2D view.
 */
export function createShadowAtlasFallbackView(
  device: RhiDevice,
  createPersistentTexture: CreatePersistentTexture,
): TextureView {
  const texture = runShimSyncStep(
    () =>
      createPersistentTexture({
        label: 'shadow-atlas-fallback-cube-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: 6 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: 'cube',
      }),
    'webgpu-runtime-error',
    'createTexture (shadow atlas fallback cube) succeeded',
    'check device.limits.maxTextureDimension2D and cube-array support',
  );
  if (!texture.ok) throw texture.error;
  const view = runShimSyncStep(
    () =>
      device.createTextureView(texture.value, {
        label: 'shadow-atlas-fallback-cube-array-view',
        dimension: 'cube-array',
        aspect: 'depth-only',
        baseArrayLayer: 0,
        arrayLayerCount: 6,
        baseMipLevel: 0,
        mipLevelCount: 1,
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow atlas fallback cube-array) succeeded',
    'check shadow atlas fallback texture format / usage / dimension',
  );
  if (!view.ok) throw view.error;
  for (let face = 0; face < 6; face++) {
    const faceView = runShimSyncStep(
      () =>
        device.createTextureView(texture.value, {
          label: `shadow-atlas-fallback-face-${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      'webgpu-runtime-error',
      `createTextureView (shadow atlas fallback face ${face}) succeeded`,
      'check shadow atlas fallback texture format / usage',
    );
    if (!faceView.ok) throw faceView.error;
    clearDepthAttachment(
      device,
      faceView.value,
      `shadow-atlas-fallback-clear-encoder-face-${face}`,
    );
  }
  return view.value;
}

/**
 * Point/spot shadow control lanes. Zero lanes are safe because shaders gate
 * reads on a non-negative shadow layer, so the no-shadow path is deterministic.
 */
export function createShadowParamsBuffer(
  createPersistentBuffer: CreatePersistentBuffer,
  queue: RhiDevice['queue'],
): Buffer {
  const buffer = createUniformBuffer(
    createPersistentBuffer,
    'shadow-params-ubo',
    SHADOW_PARAMS_BYTES,
    'createBuffer (shadow params UBO) succeeded',
    'check device.limits.maxUniformBufferBindingSize (need >= 256)',
  );
  const zeroWrite = queue.writeBuffer(buffer, 0, new Uint8Array(SHADOW_PARAMS_BYTES));
  if (!zeroWrite.ok) throw zeroWrite.error;
  return buffer;
}

/**
 * Identity Skylight bundle (zero cubes, approximate BRDF LUT, zero intensity)
 * so materials need no "is there a skylight?" branch. The helper's narrow
 * device/queue contracts forward concrete methods without a structural cast.
 */
export function createReadySkylightFallback(
  device: RhiDevice,
  createPersistentBuffer: CreatePersistentBuffer,
  createPersistentTexture: CreatePersistentTexture,
): SkylightFallback {
  const queue = device.queue;
  try {
    return createSkylightFallback(
      {
        createSampler: (descriptor) => device.createSampler(descriptor),
        createTexture: (descriptor) => createPersistentTexture(descriptor),
        createTextureView: (texture, descriptor) => device.createTextureView(texture, descriptor),
        createBuffer: (descriptor) => createPersistentBuffer(descriptor),
      },
      {
        writeTexture: (destination, data, layout, size) =>
          queue.writeTexture(destination, data, layout, size),
        writeBuffer: (buffer, offset, data) => queue.writeBuffer(buffer, offset, data),
      },
    );
  } catch (caught) {
    if (caught instanceof RhiError) throw caught;
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'createSkylightFallback succeeded',
      hint: `verify texture_cube + uniform allocation (cause: ${
        caught instanceof Error ? caught.message : String(caught)
      })`,
    });
  }
}
