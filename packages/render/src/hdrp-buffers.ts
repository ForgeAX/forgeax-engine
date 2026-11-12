import type { SkinTaskBinding } from './record/skin-tasks';
// Renderer-owned clustered light resources. One immutable bundle keeps the
// producer uploads, graph imports, draw bindings and queue-fenced retirement
// on the same device generation. Storage-capable devices retain the native
// buffers; downlevel devices pack the same records/grid/memberships into one
// RGBA32uint texture. Both transports share the cluster uniform contract.

import type {
  BindGroup,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  Buffer,
  RhiCommandEncoder,
  RhiError,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { GPU_SHADER_STAGE_COMPUTE } from './gpu-stage';
import { GPU_TEXTURE_USAGE_COPY_SRC } from './gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from './gpu-usage';
import type { StandardClusterReflectedAbi } from './light-buffer-layout';
import { createPbrSkinMeshBindGroupEntries } from './pbr-pipeline';
import { createStandardClusterLayout } from './pipeline/standard-lighting/layout';
import {
  type StandardClusterTextureExtent,
  standardClusterTextureLayout,
} from './pipeline/standard-lighting/texture';
import { DEFAULT_CLUSTER_GRID, LIGHT_INDEX_LIST_CAPACITY } from './pipeline/standard-profile';
import { createHdrpBindGroupLayoutDescriptor } from './pipeline-spec';
import { ClusterTextureTable } from './record/cluster-texture-table';
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
        buffer: { type: 'storage', hasDynamicOffset: false },
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
  /** Monotonic identity for a physical Cluster transport allocation bundle. */
  readonly clusterTransportGeneration: number;
  /** Device identity that owns every handle in this bundle. */
  readonly device: RenderSystemRuntime['device'];
  readonly clusterUniformBuffer: Buffer;
  readonly clusterUniformBytes: number;
  readonly directLightSlotBytes: number;
  readonly directLightSlotCapacity: number;
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly unifiedBindGroupLayout: BindGroupLayout;
}

interface HdrpStorageBuffers extends HdrpResourceBase {
  readonly kind: 'storage';
  /** The full reflected DirectLightSlot array. */
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

/** Publication belongs to the physical texture; graph rebuilds cannot preserve stale content. */
export interface AtmosphereTextureContent {
  submittedKey?: string;
  recordedKey?: string;
  recordedEncoder?: RhiCommandEncoder;
}
interface HdrpTextureBuffers extends HdrpResourceBase {
  readonly kind: 'texture';
  readonly texture: Texture;
  readonly view: TextureView;
  readonly layout: ReturnType<typeof standardClusterTextureLayout>;
  readonly table: ClusterTextureTable;
  readonly atmosphereContent: {
    medium: AtmosphereTextureContent;
    aerial: AtmosphereTextureContent;
  };
}

export type HdrpBuffers = HdrpStorageBuffers | HdrpTextureBuffers;

const cache = new WeakMap<RenderSystemRuntime, HdrpBuffers>();
let nextClusterTransportGeneration = 1;

function allocateClusterTransportGeneration(): number {
  const generation = nextClusterTransportGeneration;
  nextClusterTransportGeneration += 1;
  return generation;
}

function supportsHdrpResourceSurface(runtime: RenderSystemRuntime): boolean {
  const surface = runtime.device as unknown as {
    readonly createBuffer?: unknown;
    readonly createBindGroupLayout?: unknown;
    readonly destroyBuffer?: unknown;
  };
  return (
    typeof surface.createBuffer === 'function' &&
    typeof surface.createBindGroupLayout === 'function' &&
    typeof surface.destroyBuffer === 'function'
  );
}

function isReusableHdrpBundle(
  cached: HdrpBuffers,
  reflectedAbi: StandardClusterReflectedAbi,
  grid: { readonly x: number; readonly y: number; readonly z: number },
  aoExtent: StandardClusterTextureExtent | undefined,
): boolean {
  const publicationMatches =
    cached.clusterUniformBytes === reflectedAbi.clusterUniformBytes &&
    cached.directLightSlotBytes === reflectedAbi.directLightSlot.byteSize &&
    cached.directLightSlotCapacity === reflectedAbi.directLightSlot.capacity;
  const requestedCells = grid.x * grid.y * grid.z;
  const cachedCells = cached.grid.x * cached.grid.y * cached.grid.z;
  const aoLayout = cached.kind === 'texture' ? cached.layout.ao : undefined;
  const aoMatches =
    (aoExtent === undefined && aoLayout === undefined) ||
    (aoExtent !== undefined &&
      aoLayout !== undefined &&
      aoLayout.width === aoExtent.width &&
      aoLayout.height === aoExtent.height &&
      (cached.kind !== 'texture' ||
        (cached.layout.screen?.width === aoExtent.screen?.width &&
          cached.layout.screen?.height === aoExtent.screen?.height &&
          (cached.layout.atmosphere !== undefined) === (aoExtent.atmosphere === true))));
  return (
    publicationMatches &&
    (cached.kind === 'storage'
      ? requestedCells <= cachedCells
      : requestedCells === cachedCells && aoMatches)
  );
}

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
  aoExtent?: StandardClusterTextureExtent,
): HdrpBuffers | null {
  const reflectedAbi = runtime.standardClusterAbi;
  if (reflectedAbi === undefined) return null;
  // Contract tests and reduced host adapters may advertise storage buffers
  // without implementing the resource-creation surface. Treat that as a
  // capability miss rather than dereferencing an absent method; callers
  // already route `null` through the structured cluster-transport fallback.
  if (!supportsHdrpResourceSurface(runtime)) return null;
  const cached = cache.get(runtime);
  if (
    cached !== undefined &&
    cached.device === runtime.device &&
    isReusableHdrpBundle(cached, reflectedAbi, grid, aoExtent)
  )
    return cached;
  if (!runtime.device.caps.storageBuffer) {
    const textures = createHdrpTextureBuffers(runtime, grid, reflectedAbi, aoExtent);
    if (textures !== null) {
      cache.set(runtime, textures);
      if (cached !== undefined) retireHdrpBuffers(runtime, cached);
    }
    return textures;
  }
  const device = runtime.device;
  const clusterUniformBytes = reflectedAbi.clusterUniformBytes;
  const directLightSlotBytes = reflectedAbi.directLightSlot.byteSize;
  const clusterLayout = createStandardClusterLayout(reflectedAbi.directLightSlot.capacity, grid);
  const lightDataBytes = clusterLayout.lightDataSlotCount * directLightSlotBytes;
  const clusterGridBytes = clusterLayout.clusterGridU32Length * 4;
  const lightIndexListBytes = LIGHT_INDEX_LIST_CAPACITY * 4;
  const lightBoundsBytes = clusterLayout.lightBoundsInt32Length * 4;
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
    clusterTransportGeneration: allocateClusterTransportGeneration(),
    device,
    lightDataBuffer: lightData.value,
    lightDataBytes,
    clusterGridBuffer: clusterGrid.value,
    clusterGridBytes,
    lightIndexListBuffer: lightIndexList.value,
    lightIndexListBytes,
    clusterUniformBuffer: clusterUniform.value,
    clusterUniformBytes,
    directLightSlotBytes,
    directLightSlotCapacity: reflectedAbi.directLightSlot.capacity,
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
  reflectedAbi: StandardClusterReflectedAbi,
  aoExtent?: StandardClusterTextureExtent,
): HdrpTextureBuffers | null {
  const device = runtime.device;
  const clusterUniformBytes = reflectedAbi.clusterUniformBytes;
  const layout = standardClusterTextureLayout(
    createStandardClusterLayout(reflectedAbi.directLightSlot.capacity, grid),
    reflectedAbi.directLightSlot.byteSize,
    aoExtent,
  );
  const texture = device.createTexture({
    label: 'standard-cluster-tables',
    size: { width: layout.width, height: layout.height, depthOrArrayLayers: 1 },
    format: 'rgba32uint',
    textureBindingViewDimension: '2d',
    usage: 0x02 | 0x04 | (aoExtent === undefined ? 0 : 0x10 | GPU_TEXTURE_USAGE_COPY_SRC),
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
    size: clusterUniformBytes,
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
    atmosphereContent: { medium: {}, aerial: {} },
    clusterTransportGeneration: allocateClusterTransportGeneration(),
    device,
    texture: texture.value,
    view: view.value,
    layout,
    table: new ClusterTextureTable(
      layout.width,
      layout.height,
      reflectedAbi.directLightSlot.capacity,
    ),
    clusterUniformBuffer: uniform.value,
    clusterUniformBytes,
    directLightSlotBytes: reflectedAbi.directLightSlot.byteSize,
    directLightSlotCapacity: reflectedAbi.directLightSlot.capacity,
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
 * Pack the Standard Cluster uniform using offsets and span from WGSL reflection.
 *
 *   [0] gridX  u32 (cast in shader)
 *   [1] gridY  u32
 *   [2] gridZ  u32
 *   [3] lightCount u32 (vec4 alignment; capped by the reflected slot array)
 *   [4] near   f32
 *   [5] far    f32
 *   [6] logFarOverNear  f32
 *   [7] ssaoIntensity   f32   (scope-amend-webgl2-ubo: folded from removed
 *                              dedicated @binding(9) UBO; lighting shader
 *                              reads `cluster_uniform.near_far_log.w`)
 *
 * [8..11] AO base word, width, height and packed row words (u32)
 * [12] direct AO strength (f32; zero unless the selected AO config enables it)
 * [16..19] physical texture address facts
 * [20] grid pair stride in u32 words; [21] count-word offset
 * [22..23] reserved
 *
 * Note: u32 values written into a Float32Array view are bit-pattern correct
 * because writeBuffer copies raw bytes; the WGSL `var<uniform>` declares the
 * field as u32 / f32 per its position so the device reinterprets correctly.
 * Use a Uint32Array view for the integer slots to keep the bit pattern intact.
 */
export function packClusterUniform(input: {
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly near: number;
  readonly far: number;
  readonly ssaoIntensity?: number;
  readonly lightCount?: number;
  readonly aoLayout?: {
    readonly baseWord: number;
    readonly width: number;
    readonly height: number;
    readonly rowWords: number;
  };
  readonly directLightingStrength?: number;
  readonly screen?: { readonly width: number; readonly height: number; readonly baseWord?: number };
  readonly reflectedAbi: Pick<
    StandardClusterReflectedAbi,
    'clusterUniformBytes' | 'clusterUniformOffsets'
  > & {
    readonly directLightSlot: Pick<
      StandardClusterReflectedAbi['directLightSlot'],
      'vec4Count' | 'capacity'
    >;
  };
  readonly textureAddressing?: {
    readonly width: number;
    readonly gridOffset: number;
    readonly indexOffset: number;
  };
  readonly clusterGridStrideU32: number;
  readonly clusterGridCountWordOffsetU32: number;
}): ArrayBuffer {
  const {
    grid,
    near,
    far,
    ssaoIntensity = 0,
    lightCount = 0,
    aoLayout,
    directLightingStrength = 0,
    screen,
    reflectedAbi,
    textureAddressing,
    clusterGridStrideU32,
    clusterGridCountWordOffsetU32,
  } = input;
  const { clusterUniformBytes, clusterUniformOffsets: offsets } = reflectedAbi;
  const buf = new ArrayBuffer(clusterUniformBytes);
  const data = new DataView(buf);
  const setU32 = (
    row: 'grid' | 'ao' | 'texture' | 'cluster_layout',
    component: number,
    value: number,
  ) => data.setUint32(offsets[row] + component * 4, value >>> 0, true);
  const setF32 = (row: 'near_far_log' | 'direct_ao', component: number, value: number) =>
    data.setFloat32(offsets[row] + component * 4, value, true);
  setU32('grid', 0, grid.x);
  setU32('grid', 1, grid.y);
  setU32('grid', 2, grid.z);
  setU32('grid', 3, Math.min(Math.max(lightCount, 0), reflectedAbi.directLightSlot.capacity));
  setF32('near_far_log', 0, near);
  setF32('near_far_log', 1, far);
  // logFarOverNear: log(far/near) used by the shader for log-z slice mapping.
  // Guard against near=0 / far<=near (returns 0; downstream uses fallback).
  setF32('near_far_log', 2, near > 0 && far > near ? Math.log(far / near) : 0);
  // f32[7] = SSAO intensity (default 0 = disabled-equivalent: mix(1.0, x, 0) = 1).
  setF32('near_far_log', 3, ssaoIntensity);
  if (aoLayout !== undefined) {
    setU32('ao', 0, aoLayout.baseWord);
    setU32('ao', 1, aoLayout.width);
    setU32('ao', 2, aoLayout.height);
    setU32('ao', 3, aoLayout.rowWords);
  }
  setF32('direct_ao', 0, directLightingStrength);
  setF32('direct_ao', 1, screen === undefined ? 0 : 1);
  setF32('direct_ao', 2, screen?.width ?? 0);
  setF32('direct_ao', 3, screen?.height ?? 0);
  setU32('cluster_layout', 2, screen?.baseWord ?? 0);
  setU32('texture', 0, reflectedAbi.directLightSlot.vec4Count);
  setU32('texture', 1, textureAddressing?.gridOffset ?? 0);
  setU32('texture', 2, textureAddressing?.indexOffset ?? 0);
  setU32('texture', 3, textureAddressing?.width ?? 0);
  setU32('cluster_layout', 0, clusterGridStrideU32);
  setU32('cluster_layout', 1, clusterGridCountWordOffsetU32);
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
 * Intensity flows via `cluster_uniform.near_far_log.w` (binding 6); lighting
 * reads it only as the enabled flag (the calc pass already applied the
 * exponent), and the host writes 0 when SSAO is disabled. The
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

/** Bind the actual paired Skin task with the existing clustered lighting. */
export function createHdrpSkinUnifiedBindGroup(
  runtime: RenderSystemRuntime,
  hdrpBuffers: HdrpBuffers,
  layout: BindGroupLayout,
  meshStorageBuffer: Buffer,
  task: SkinTaskBinding,
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
      ...createPbrSkinMeshBindGroupEntries(meshStorageBuffer, meshBindingBytes, task),
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
