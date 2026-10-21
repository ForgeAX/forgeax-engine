// Renderer-owned clustered light resources. One immutable bundle keeps the
// producer uploads, graph imports, draw bindings and queue-fenced retirement
// on the same device generation. Storage-capable devices retain the native
// buffers; downlevel devices pack the same records/grid/memberships into one
// RGBA32uint texture. Both transports share the cluster uniform contract.

import {
  type BindGroup,
  type BindGroupLayout,
  type BindGroupLayoutDescriptor,
  type Buffer,
  RhiError,
  type Sampler,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import { GPU_SHADER_STAGE_COMPUTE } from './gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from './gpu-usage';
import { BYTES_PER_DIRECT_LIGHT_SLOT } from './light-buffer-layout';
import { createPbrSkinMeshBindGroupEntries } from './pbr-pipeline';
import { createStandardClusterLayout } from './pipeline/standard-lighting/layout';
import { standardClusterTextureLayout } from './pipeline/standard-lighting/texture';
import {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
} from './pipeline/standard-profile';
import { createHdrpBindGroupLayoutDescriptor } from './pipeline-spec';
import { MESH_PER_ENTITY_STRIDE, MESH_UBO_FULL_ARRAY_BYTES } from './record/mesh-ssbo';
import type { RenderSystemRuntime } from './record/render-context';
import { getOrCreateSsaoFallbackTexture } from './ssao-buffers';

export { getOrCreateSsaoFallbackTexture } from './ssao-buffers';

/** Bind-group layout used only by the WebGPU cluster membership producer. */
export function createHdrpClusterMembershipBindGroupLayoutDescriptor(): BindGroupLayoutDescriptor {
  return {
    label: 'hdrp-cluster-membership-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
      {
        binding: 1,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'storage', hasDynamicOffset: false },
      },
      {
        binding: 2,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: false },
      },
      {
        binding: 3,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
    ],
  };
}

/** Shared per-renderer ownership for either physical cluster transport. */
interface HdrpResourceBase {
  /** Device identity that owns every handle in this bundle. */
  readonly device: RenderSystemRuntime['device'];
  readonly clusterUniformBuffer: Buffer;
  readonly clusterUniformBytes: number;
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly unifiedBindGroupLayout: BindGroupLayout;
}

interface HdrpStorageBuffers extends HdrpResourceBase {
  readonly kind: 'storage';
  /** The full 256 × 96 B DirectLightSlot budget. */
  readonly lightDataBuffer: Buffer;
  readonly lightDataBytes: number;
  /** cluster_grid SSBO -- gridX*gridY*gridZ * 2 u32, BGL slot 4. */
  readonly clusterGridBuffer: Buffer;
  readonly clusterGridBytes: number;
  /** Complete layout-owned membership capacity, BGL slot 5. */
  readonly lightIndexListBuffer: Buffer;
  readonly lightIndexListBytes: number;
  /** CPU-produced light AABBs consumed by the optional WebGPU membership pass. */
  readonly lightBoundsBuffer: Buffer;
  readonly lightBoundsBytes: number;
}

interface HdrpTextureBuffers extends HdrpResourceBase {
  readonly kind: 'texture';
  readonly texture: Texture;
  readonly view: TextureView;
  readonly layout: ReturnType<typeof standardClusterTextureLayout>;
  readonly words: Uint32Array;
}

export type HdrpBuffers = HdrpStorageBuffers | HdrpTextureBuffers;

const cache = new WeakMap<RenderSystemRuntime, HdrpBuffers>();

/**
 * Lazily allocate the 4 persistent HDRP buffers for `runtime`. Returns the same
 * `HdrpBuffers` object on subsequent calls (per-RenderSystem stable identity).
 *
 * On `device.createBuffer` failure, fires a structured RhiError on the runtime's
 * error registry and returns `null`; HDRP buildGraph treats null as a hard
 * pipeline disable (charter P3 explicit failure).
 *
 * `grid` defaults to `DEFAULT_CLUSTER_GRID` when undefined (matches the M5
 * record-stage default). A smaller grid reuses the existing capacity. When a
 * later install requests a larger grid, this owner allocates a complete new
 * bundle, publishes it atomically, and retires the previous bundle after the
 * device queue fence so graph and bind-group caches never observe a partially
 * replaced resource set.
 */
export function getOrCreateHdrpBuffers(
  runtime: RenderSystemRuntime,
  grid: { x: number; y: number; z: number } = DEFAULT_CLUSTER_GRID,
): HdrpBuffers | null {
  // Contract tests and reduced host adapters may advertise storage buffers
  // without implementing the resource-creation surface. Treat that as a
  // capability miss rather than dereferencing an absent method; callers
  // already route `null` through the structured cluster-transport fallback.
  const deviceSurface = runtime.device as unknown as {
    readonly createBuffer?: unknown;
    readonly createBindGroupLayout?: unknown;
    readonly destroyBuffer?: unknown;
  };
  if (
    typeof deviceSurface.createBuffer !== 'function' ||
    typeof deviceSurface.createBindGroupLayout !== 'function' ||
    typeof deviceSurface.destroyBuffer !== 'function'
  ) {
    return null;
  }
  const cached = cache.get(runtime);
  if (cached !== undefined && cached.device === runtime.device) {
    const requestedCells = grid.x * grid.y * grid.z;
    const cachedCells = cached.grid.x * cached.grid.y * cached.grid.z;
    if (cached.kind === 'storage' ? requestedCells <= cachedCells : requestedCells === cachedCells)
      return cached;
  }
  if (!runtime.device.caps.storageBuffer) {
    const textures = createHdrpTextureBuffers(runtime, grid);
    if (textures !== null) {
      cache.set(runtime, textures);
      if (cached !== undefined) retireHdrpBuffers(runtime, cached);
    }
    return textures;
  }
  const device = runtime.device;
  const clusterUniformBytes = 32;
  const lightDataBytes = MAX_LIGHTS * BYTES_PER_DIRECT_LIGHT_SLOT;
  const clusterCells = grid.x * grid.y * grid.z;
  const clusterGridBytes = clusterCells * CLUSTER_GRID_STRIDE_U32 * 4;
  const lightIndexListBytes = LIGHT_INDEX_LIST_CAPACITY * 4;
  const lightBoundsBytes = MAX_LIGHTS * 6 * 4;
  const created: Buffer[] = [];
  const releaseCreated = (): void => {
    for (const buffer of created) {
      const result = device.destroyBuffer(buffer);
      if (!result.ok) runtime.errorRegistry.fire(result.error);
    }
    created.length = 0;
  };
  const failAllocation = (error: RhiError): null => {
    runtime.errorRegistry.fire(error);
    releaseCreated();
    return null;
  };

  const lightData = device.createBuffer({
    label: 'hdrp-light-data',
    size: lightDataBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightData.ok) {
    return failAllocation(lightData.error);
  }
  created.push(lightData.value);
  const clusterGrid = device.createBuffer({
    label: 'hdrp-cluster-grid',
    size: clusterGridBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!clusterGrid.ok) {
    return failAllocation(clusterGrid.error);
  }
  created.push(clusterGrid.value);
  const lightIndexList = device.createBuffer({
    label: 'hdrp-light-index-list',
    size: lightIndexListBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightIndexList.ok) {
    return failAllocation(lightIndexList.error);
  }
  created.push(lightIndexList.value);
  const clusterUniform = device.createBuffer({
    label: 'hdrp-cluster-uniform',
    size: clusterUniformBytes,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!clusterUniform.ok) {
    return failAllocation(clusterUniform.error);
  }
  created.push(clusterUniform.value);
  const lightBounds = device.createBuffer({
    label: 'hdrp-light-bounds',
    size: lightBoundsBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightBounds.ok) {
    return failAllocation(lightBounds.error);
  }
  created.push(lightBounds.value);

  // Create the unified 7-entry BGL layout for group(2)
  // (plan D-6, feat-20260609-hdrp-cluster-fragment-ggx M3).
  // The HDRP BGL descriptor is owned by pipeline-spec and shared with the
  // pipeline dispatcher and its byte-identical tests.
  const unifiedBglRes = device.createBindGroupLayout(createHdrpBindGroupLayoutDescriptor());
  if (!unifiedBglRes.ok) {
    return failAllocation(unifiedBglRes.error);
  }
  const buffers: HdrpBuffers = {
    kind: 'storage',
    device,
    lightDataBuffer: lightData.value,
    lightDataBytes,
    clusterGridBuffer: clusterGrid.value,
    clusterGridBytes,
    lightIndexListBuffer: lightIndexList.value,
    lightIndexListBytes,
    clusterUniformBuffer: clusterUniform.value,
    clusterUniformBytes,
    lightBoundsBuffer: lightBounds.value,
    lightBoundsBytes,
    grid: { x: grid.x, y: grid.y, z: grid.z },
    unifiedBindGroupLayout: unifiedBglRes.value,
  };
  cache.set(runtime, buffers);
  if (cached !== undefined) {
    retireHdrpBuffers(runtime, cached);
  }
  return buffers;
}

function createHdrpTextureBuffers(
  runtime: RenderSystemRuntime,
  grid: { readonly x: number; readonly y: number; readonly z: number },
): HdrpTextureBuffers | null {
  const device = runtime.device;
  const layout = standardClusterTextureLayout(createStandardClusterLayout(grid));
  const texture = device.createTexture({
    label: 'standard-cluster-tables',
    size: { width: layout.width, height: layout.height, depthOrArrayLayers: 1 },
    format: 'rgba32uint',
    textureBindingViewDimension: '2d',
    usage: 0x02 | 0x04,
  });
  if (!texture.ok) {
    runtime.errorRegistry.fire(texture.error);
    return null;
  }
  const view = device.createTextureView(texture.value, { dimension: '2d' });
  if (!view.ok) {
    runtime.errorRegistry.fire(view.error);
    device.destroyTexture(texture.value);
    return null;
  }
  const uniform = device.createBuffer({
    label: 'hdrp-cluster-uniform',
    size: 32,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  if (!uniform.ok) {
    runtime.errorRegistry.fire(uniform.error);
    device.destroyTexture(texture.value);
    return null;
  }
  const bgl = device.createBindGroupLayout(createHdrpBindGroupLayoutDescriptor(false));
  if (!bgl.ok) {
    runtime.errorRegistry.fire(bgl.error);
    device.destroyBuffer(uniform.value);
    device.destroyTexture(texture.value);
    return null;
  }
  return {
    kind: 'texture',
    device,
    texture: texture.value,
    view: view.value,
    layout,
    words: new Uint32Array(layout.width * layout.height * 4),
    clusterUniformBuffer: uniform.value,
    clusterUniformBytes: 32,
    unifiedBindGroupLayout: bgl.value,
    grid: { ...grid },
  };
}

/**
 * Drop the cached bundle before a device recovery or renderer disposal. The
 * bundle carries the old device identity, so retirement fences that device's
 * queue instead of consulting the replacement runtime device.
 */
export function resetHdrpBuffers(runtime: RenderSystemRuntime): void {
  const cached = cache.get(runtime);
  if (cached === undefined) return;
  cache.delete(runtime);
  retireHdrpBuffers(runtime, cached);
}

function retireHdrpBuffers(runtime: RenderSystemRuntime, buffers: HdrpBuffers): void {
  const device = buffers.device;
  const destroy = (): void => {
    if (buffers.kind === 'texture') {
      const destroyed = device.destroyTexture(buffers.texture);
      if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
    }
    for (const buffer of buffers.kind === 'texture'
      ? [buffers.clusterUniformBuffer]
      : [
          buffers.lightDataBuffer,
          buffers.clusterGridBuffer,
          buffers.lightIndexListBuffer,
          buffers.clusterUniformBuffer,
          buffers.lightBoundsBuffer,
        ]) {
      const result = device.destroyBuffer(buffer);
      if (!result.ok) runtime.errorRegistry.fire(result.error);
    }
  };
  const queue = device.queue as {
    readonly onSubmittedWorkDone?: () => Promise<undefined>;
  };
  if (typeof queue.onSubmittedWorkDone === 'function') {
    queue.onSubmittedWorkDone().then(destroy, destroy);
  } else {
    // Minimal null/test devices may not expose queue fences; they also have no
    // submitted work that can retain the old bundle, so release synchronously.
    destroy();
  }
}

/**
 * Build the 8-float cluster_uniform std140 payload.
 *
 *   [0] gridX  u32 (cast in shader)
 *   [1] gridY  u32
 *   [2] gridZ  u32
 *   [3] lightCount u32 (vec4 alignment; capped by MAX_LIGHTS)
 *   [4] near   f32
 *   [5] far    f32
 *   [6] logFarOverNear  f32
 *   [7] ssaoIntensity   f32   (scope-amend-webgl2-ubo: folded from removed
 *                              dedicated @binding(9) UBO; lighting shader
 *                              reads `cluster_uniform.near_far_log.w`)
 *
 * Matches `__tests__/hdrp-bgl-slots.test.ts CLUSTER_UNIFORM_LAYOUT`.
 *
 * Note: u32 values written into a Float32Array view are bit-pattern correct
 * because writeBuffer copies raw bytes; the WGSL `var<uniform>` declares the
 * field as u32 / f32 per its position so the device reinterprets correctly.
 * Use a Uint32Array view for the integer slots to keep the bit pattern intact.
 */
export function packClusterUniform(
  grid: { x: number; y: number; z: number },
  near: number,
  far: number,
  ssaoIntensity: number = 0,
  lightCount: number = 0,
): ArrayBuffer {
  const buf = new ArrayBuffer(32);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  u32[0] = grid.x >>> 0;
  u32[1] = grid.y >>> 0;
  u32[2] = grid.z >>> 0;
  u32[3] = Math.min(Math.max(lightCount, 0), MAX_LIGHTS) >>> 0;
  f32[4] = near;
  f32[5] = far;
  // logFarOverNear: log(far/near) used by the shader for log-z slice mapping.
  // Guard against near=0 / far<=near (returns 0; downstream uses fallback).
  f32[6] = near > 0 && far > near ? Math.log(far / near) : 0;
  // f32[7] = SSAO intensity (default 0 = disabled-equivalent: mix(1.0, x, 0) = 1).
  f32[7] = ssaoIntensity;
  return buf;
}

/**
 * Consumers pass the same mesh storage buffer + stride that URP uses, so the
 * physical draw offset at `setBindGroup(2, ...)`
 * stays valid across both pipelines.
 */
/**
 * Build the unified group(2) BindGroup for HDRP — binding 0 = mesh SSBO
 * (dynamic offset, same buffer URP binds), bindings 3..6 = the cluster
 * buffers from `getOrCreateHdrpBuffers`.
 *
 * feat-20260609-hdrp-cluster-fragment-ggx M4 / w19. Called per-frame from the
 * recordFrame HDRP block after binner+writeBuffer; the resulting BindGroup
 * lands on `passCtx.hdrpClusterBindGroup` and encodeMainPass binds it at
 * group(2) when the prepared Standard topology selects clustered lighting.
 *
 * Returns `null` on `device.createBindGroup` failure (a structured RhiError
 * is fired on `runtime.errorRegistry`); encodeMainPass gracefully falls back
 * to the URP mesh bindGroup when null.
 *
 * Plan D-1 / D-4: the mesh SSBO buffer + stride mirror the URP path, so the
 * single dynamic offset issued at `setBindGroup(2, ...)` covers binding 0 of
 * the unified BGL just as it covers binding 0 of the URP mesh BGL.
 */
/**
 * SSAO bind-group input (plan-strategy §D-B, M7;
 * scope-amend-webgl2-ubo: dedicated @binding(9) intensity UBO removed).
 *
 * The HDRP unified BGL always declares 7 entries (cluster 5 + ssao 2); the
 * caller supplies one of two shapes depending on `config.ssao?.enabled`:
 *
 *   { enabled: true, ssaoBlurredView }
 *     -> binding 7 = real ssaoBlurred view
 *     -> binding 8 = real ssao sampler (lazy-allocated alongside fallback)
 *
 *   { enabled: false }
 *     -> binding 7 = 1x1 white fallback texture (AO = 1.0)
 *     -> binding 8 = fallback sampler
 *
 * Intensity flows via `cluster_uniform.near_far_log.w` (binding 6); the host
 * writes intensity=0 when SSAO is disabled so the lighting blend
 * `mix(1.0, ssao*ao, 0) = 1.0` collapses to the round-1 baseline. The
 * "always-7-entries" invariant lets every PBR PSO use the same pipeline
 * layout regardless of SSAO state — toggling the runtime config never
 * triggers shader recompile (charter P4 one consistent abstraction).
 *
 * `ssaoBuffers` is no longer carried in the enabled variant: the SSAO
 * compute-side UBO continues to live on the SSAO compute pipeline's own
 * group(0) BGL, decoupled from the lighting-stage group(2).
 */
export type SsaoBindOptions =
  | {
      readonly enabled: true;
      readonly ssaoBlurredView: TextureView;
    }
  | { readonly enabled: false };

function standardLightingEntries(
  hdrpBuffers: HdrpBuffers,
  ssaoTexView: TextureView,
  ssaoSampler: Sampler,
): import('@forgeax/engine-rhi').BindGroupEntry[] {
  return [
    ...(hdrpBuffers.kind === 'texture'
      ? [{ binding: 3, resource: { kind: 'textureView' as const, value: hdrpBuffers.view } }]
      : [
          {
            binding: 3,
            resource: {
              kind: 'buffer' as const,
              value: { buffer: hdrpBuffers.lightDataBuffer },
            },
          },
          {
            binding: 4,
            resource: {
              kind: 'buffer' as const,
              value: { buffer: hdrpBuffers.clusterGridBuffer },
            },
          },
          {
            binding: 5,
            resource: {
              kind: 'buffer' as const,
              value: { buffer: hdrpBuffers.lightIndexListBuffer },
            },
          },
        ]),
    {
      binding: 6,
      resource: {
        kind: 'buffer',
        value: { buffer: hdrpBuffers.clusterUniformBuffer },
      },
    },
    ...(hdrpBuffers.kind === 'storage'
      ? [
          {
            binding: 7,
            resource: { kind: 'textureView' as const, value: ssaoTexView },
          },
          {
            binding: 8,
            resource: { kind: 'sampler' as const, value: ssaoSampler },
          },
        ]
      : []),
  ];
}

/** Standard surface resources without scene geometry tables. */
export function createStandardSurfaceLightingBindGroup(
  runtime: RenderSystemRuntime,
  layout: BindGroupLayout,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  ssaoOptions: SsaoBindOptions = { enabled: false },
): BindGroup | null {
  const buffers = getOrCreateHdrpBuffers(runtime, grid);
  const fallback = getOrCreateSsaoFallbackTexture(runtime);
  if (buffers === null || fallback === null) return null;
  const result = runtime.device.createBindGroup({
    label: 'standard-surface-lighting',
    layout,
    entries: standardLightingEntries(
      buffers,
      ssaoOptions.enabled ? ssaoOptions.ssaoBlurredView : fallback.view,
      fallback.sampler,
    ),
  });
  if (!result.ok) {
    runtime.errorRegistry.fire(result.error);
    return null;
  }
  return result.value;
}

export function createHdrpUnifiedBindGroup(
  runtime: RenderSystemRuntime,
  hdrpBuffers: HdrpBuffers,
  meshStorageBuffer: Buffer,
  ssaoOptions: SsaoBindOptions = { enabled: false },
  meshBindingBytes = runtime.device.caps.storageBuffer
    ? MESH_PER_ENTITY_STRIDE
    : MESH_UBO_FULL_ARRAY_BYTES,
): BindGroup | null {
  const fallback = getOrCreateSsaoFallbackTexture(runtime);
  if (fallback === null) return null;

  const ssaoTexView: TextureView = ssaoOptions.enabled
    ? ssaoOptions.ssaoBlurredView
    : fallback.view;
  const ssaoSampler: Sampler = fallback.sampler;

  const result = runtime.device.createBindGroup({
    label: 'hdrp-unified-bg-group2',
    layout: hdrpBuffers.unifiedBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          kind: 'buffer',
          value: {
            buffer: meshStorageBuffer,
            offset: 0,
            size: meshBindingBytes,
          },
        },
      },
      ...standardLightingEntries(hdrpBuffers, ssaoTexView, ssaoSampler),
    ],
  });
  if (!result.ok) {
    runtime.errorRegistry.fire(result.error);
    return null;
  }
  return result.value;
}

/** Build the clustered skin group(2) bind group with one shared palette window. */
export function createHdrpSkinUnifiedBindGroup(
  runtime: RenderSystemRuntime,
  hdrpBuffers: HdrpBuffers,
  layout: BindGroupLayout,
  meshStorageBuffer: Buffer,
  paletteBuffer: Buffer,
  paletteBindingWindowBytes: number,
  ssaoOptions: SsaoBindOptions = { enabled: false },
  meshBindingBytes = runtime.device.caps.storageBuffer
    ? MESH_PER_ENTITY_STRIDE
    : MESH_UBO_FULL_ARRAY_BYTES,
): BindGroup | null {
  const fallback = getOrCreateSsaoFallbackTexture(runtime);
  if (fallback === null) return null;
  const result = runtime.device.createBindGroup({
    label: 'hdrp-skin-unified-bg-group2',
    layout,
    entries: [
      ...createPbrSkinMeshBindGroupEntries(
        meshStorageBuffer,
        meshBindingBytes,
        paletteBuffer,
        paletteBindingWindowBytes,
      ),
      ...standardLightingEntries(
        hdrpBuffers,
        ssaoOptions.enabled ? ssaoOptions.ssaoBlurredView : fallback.view,
        fallback.sampler,
      ),
    ],
  });
  if (!result.ok) {
    runtime.errorRegistry.fire(result.error);
    return null;
  }
  return result.value;
}

/**
 * Build the compute-only bind group for ordered cluster membership output.
 * Its group is intentionally separate from the fragment group: the same
 * light-index buffer is read-only in the fragment pipeline but read-write in
 * the producer pipeline, which WebGPU represents with different binding
 * types.
 */
export function createHdrpClusterMembershipBindGroup(
  runtime: RenderSystemRuntime,
  hdrpBuffers: HdrpStorageBuffers,
  layout: BindGroupLayout,
): BindGroup | null {
  const result = runtime.device.createBindGroup({
    label: 'hdrp-cluster-membership-bg',
    layout,
    entries: [
      {
        binding: 0,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.clusterGridBuffer } },
      },
      {
        binding: 1,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.lightIndexListBuffer } },
      },
      {
        binding: 2,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.clusterUniformBuffer } },
      },
      {
        binding: 3,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.lightBoundsBuffer } },
      },
    ],
  });
  if (!result.ok) {
    runtime.errorRegistry.fire(result.error);
    return null;
  }
  return result.value;
}

/** Sentinel error class re-export for tests asserting the error path. */
export { RhiError as HdrpBufferAllocError };
