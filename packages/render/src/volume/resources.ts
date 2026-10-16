import type {
  CompiledRenderGraphInfo,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import { MAX_VOLUMETRIC_FOG_OWNERS } from './component';

export const VOLUME_FROXEL_FORMAT = 'rgba8unorm' as const;
export const VOLUME_HISTORY_FORMAT = 'rgba16float' as const;
export const VOLUME_RESOLVED_FORMAT = 'rgba16float' as const;

export const VOLUME_PACKING_Z = 4;
/** Renderer-owned parameter allocation shared by staging and inspection. */
export const VOLUMETRIC_FOG_PARAMS_BYTES = (1 + MAX_VOLUMETRIC_FOG_OWNERS) * 9 * 16;

export interface VolumetricFogExtent {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

/** Derive the renderer's high profile grid from the actual surface descriptor. */
export function deriveVolumetricFogExtent(
  surface: { readonly width: number; readonly height: number },
  depth = 64,
  tileSize = 4,
): VolumetricFogExtent {
  // The profile tile describes the source-resolution quality lane. Packed
  // visibility stores two source pixels per physical tile in each dimension.
  const physicalTileSize = Math.max(2, Math.floor(tileSize / 2));
  return {
    width: Math.max(1, Math.ceil(surface.width / physicalTileSize)),
    height: Math.max(1, Math.ceil(surface.height / physicalTileSize)),
    depth: Math.max(1, depth),
  };
}

/** Derive the 2D resolve extent from the same profile tile without a second profile. */
export function deriveVolumetricFogResolvedExtent(
  surface: { readonly width: number; readonly height: number },
  froxelTileSize = 4,
): VolumetricFogExtent {
  // Three's high-quality volume lane resolves at resolution=.25. The packed
  // high profile uses a physical froxel tile of two source pixels, so its
  // resolve needs the next coarser four-pixel lane. Keep the low profile's
  // existing eight-pixel resolve so its quality/budget contract is stable.
  const resolveTileSize = froxelTileSize === 4 ? 8 : Math.max(1, froxelTileSize);
  return deriveVolumetricFogExtent(surface, 1, resolveTileSize);
}

export interface VolumetricFogResources {
  readonly extent: VolumetricFogExtent;
  readonly resolvedExtent: VolumetricFogExtent;
  readonly froxel: GraphTexture;
  readonly froxelView: GraphTextureView;
  readonly resolved: GraphTexture;
  readonly resolvedView: GraphTextureView;
  readonly history: GraphTexture;
  readonly historyView: GraphTextureView;
  readonly temporal: GraphTexture;
  readonly temporalView: GraphTextureView;
}

export interface VolumetricFogResourceFacts {
  readonly generation: number;
  readonly liveResourceCount: number;
  readonly currentBytes: number;
  readonly historyBytes: number;
  readonly scratchBytes: number;
  readonly bufferBytes: number;
  readonly totalBytes: number;
  readonly physicalResourceCount: number;
  readonly sampleCount: number;
  readonly resolvedPixelCount: number;
}

/** Project graph descriptors into the volume inspection without a second ledger. */
export interface VolumetricFogResourceInspectionOptions {
  /** Number of non-null parameter buffers retained by the frame owner. */
  readonly parameterBufferCount?: number;
}

export function inspectVolumetricFogResources(
  graph: CompiledRenderGraphInfo,
  options: VolumetricFogResourceInspectionOptions = {},
): VolumetricFogResourceFacts {
  const volumeResources = graph.resources.filter(
    (resource) =>
      resource.label === 'volume-froxel' ||
      resource.label === 'volume-resolved-current' ||
      resource.label === 'volume-history' ||
      resource.label === 'volume-temporal' ||
      resource.label === 'volume-params',
  );
  const bytes = (label: string): number =>
    volumeResources
      .filter((resource) => resource.label === label)
      .reduce((total, resource) => total + (resource.byteSize ?? 0), 0);
  const graphParameterResources = volumeResources.filter(
    (resource) => resource.label === 'volume-params',
  );
  const graphParameterBufferCount = graphParameterResources.length;
  const parameterBufferCount = Math.max(
    0,
    Math.floor(options.parameterBufferCount ?? graphParameterBufferCount),
  );
  const froxel = volumeResources.find((resource) => resource.label === 'volume-froxel');
  const froxelExtent = froxel?.extent;
  const resolvedExtent = volumeResources.find(
    (resource) => resource.label === 'volume-resolved-current',
  )?.extent;
  const currentBytes = bytes('volume-resolved-current');
  // The two graph labels are ping-pong slots for one logical history volume.
  // Report one slot and physical total separately so the budget remains honest.
  const historyBytes = bytes('volume-history') + bytes('volume-temporal');
  const scratchBytes = bytes('volume-froxel');
  const bufferBytes = parameterBufferCount * VOLUMETRIC_FOG_PARAMS_BYTES;
  const physicalAllocations = new Set<string>();
  for (const resource of volumeResources) {
    if (resource.label === 'volume-params') continue;
    physicalAllocations.add(resource.physicalAllocationKey ?? resource.label);
  }
  // `physicalAllocationKey` remains the authoritative lifecycle identity for
  // counting live allocations, while category bytes report each declared
  // history slot so the public sum stays inspectable and exact.
  const totalBytes = currentBytes + historyBytes + scratchBytes + bufferBytes;
  return Object.freeze({
    generation: graph.generation,
    liveResourceCount: volumeResources.length - graphParameterBufferCount + parameterBufferCount,
    currentBytes,
    historyBytes,
    scratchBytes,
    bufferBytes,
    totalBytes,
    physicalResourceCount: physicalAllocations.size + parameterBufferCount,
    sampleCount:
      froxelExtent === undefined
        ? 0
        : froxelExtent.width *
          froxelExtent.height *
          froxelExtent.depthOrArrayLayers *
          VOLUME_PACKING_Z,
    resolvedPixelCount:
      resolvedExtent === undefined ? 0 : resolvedExtent.width * resolvedExtent.height,
  });
}

function textureDescriptor(
  format: GPUTextureFormat,
  extent: VolumetricFogExtent,
): GraphTextureDescriptor {
  return {
    format,
    size: {
      width: extent.width,
      height: extent.height,
      depthOrArrayLayers: Math.ceil(extent.depth / VOLUME_PACKING_Z),
    },
    dimension: '2d',
  };
}

function resolvedDescriptor(extent: VolumetricFogExtent): GraphTextureDescriptor {
  return {
    format: VOLUME_RESOLVED_FORMAT,
    size: { width: extent.width, height: extent.height, depthOrArrayLayers: 1 },
    dimension: '2d',
  };
}

export function createVolumetricFogResources(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent: VolumetricFogExtent = { width: 64, height: 64, depth: 64 },
  resolvedExtent?: VolumetricFogExtent,
): Result<VolumetricFogResources, RenderGraphError> {
  const effectiveResolvedExtent = resolvedExtent ?? {
    width: extent.width,
    height: extent.height,
    depth: 1,
  };
  const froxel = graph.createTexture(
    'volume-froxel',
    textureDescriptor(VOLUME_FROXEL_FORMAT, extent),
  );
  if (!froxel.ok) return froxel;
  const froxelView = graph.view(froxel.value, {
    label: 'volume-froxel.view',
    dimension: '2d-array',
    baseArrayLayer: 0,
    arrayLayerCount: Math.ceil(extent.depth / VOLUME_PACKING_Z),
  });
  if (!froxelView.ok) return froxelView;
  const resolved = graph.createTexture(
    'volume-resolved-current',
    resolvedDescriptor(effectiveResolvedExtent),
  );
  if (!resolved.ok) return resolved;
  const resolvedView = graph.view(resolved.value, {
    label: 'volume-resolved-current.view',
    dimension: '2d',
  });
  if (!resolvedView.ok) return resolvedView;
  const history = graph.createTexture(
    'volume-history',
    resolvedDescriptor(effectiveResolvedExtent),
  );
  if (!history.ok) return history;
  const historyView = graph.view(history.value, { label: 'volume-history.view', dimension: '2d' });
  if (!historyView.ok) return historyView;
  const temporal = graph.createTexture(
    'volume-temporal',
    resolvedDescriptor(effectiveResolvedExtent),
  );
  if (!temporal.ok) return temporal;
  const temporalView = graph.view(temporal.value, {
    label: 'volume-temporal.view',
    dimension: '2d',
  });
  if (!temporalView.ok) return temporalView;
  return ok({
    extent,
    resolvedExtent: effectiveResolvedExtent,
    froxel: froxel.value,
    froxelView: froxelView.value,
    resolved: resolved.value,
    resolvedView: resolvedView.value,
    history: history.value,
    historyView: historyView.value,
    temporal: temporal.value,
    temporalView: temporalView.value,
  });
}
