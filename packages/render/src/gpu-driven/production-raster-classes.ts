import type {
  GraphAccess,
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { BindGroup, RenderPipeline, Result, TextureFormat } from '@forgeax/engine-rhi';
import { ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState, ResultOk } from '@forgeax/engine-types';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';
import type { MeshGpuHandles } from '../device/gpu-residency';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_INDEX,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
  GPU_BUFFER_USAGE_VERTEX,
} from '../gpu-usage';
import { SKIN_UNCOVERED_GBUFFER_ENTRY } from '../pbr-pipeline';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import type { RenderSystemInternals } from '../record/render-context';
import { STANDARD_OPAQUE_FRAGMENT_ENTRY } from '../record/standard-opaque-entry';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type { GpuDrivenBatch } from './batch-topology';
import type { LiveRasterBatch } from './live-raster';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import type { PreparedBatch } from './production-raster-prepare';
import { gpuRasterFilterMatches, gpuTemporalEligible } from './raster-selection';

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

export type RasterPipelineFor = (
  formats: readonly TextureFormat[],
  formatKey?: string,
  preparation?: boolean,
) => Result<RenderPipeline, RhiError>;

export interface ProjectedRasterPipelines {
  readonly pipelineFor: RasterPipelineFor;
  readonly temporalPipelineFor: RasterPipelineFor;
  readonly coveragePipelineFor: RasterPipelineFor;
  readonly gbufferPipelineFor: RasterPipelineFor;
  /** Forward entry for the unfogged base View slot; equals `pipelineFor` for authored entries. */
  readonly opaquePipelineFor: RasterPipelineFor;
  readonly nearestPipelineFor?: RasterPipelineFor;
  readonly colorPipelineFor?: RasterPipelineFor;
}

/**
 * Raster classes are the compiled graph's resource facts: pipelines, mesh
 * buffers and bind groups. Batch windows, indirect offsets and
 * representatives are live per-frame facts read at encode.
 */
export interface ProjectedRasterClass {
  orderDiagnosticState: MaterialRenderState | undefined;
  diagnosticSourceDigest?: string;
  readonly artifact: MaterialShaderArtifact;
  readonly mesh: MeshGpuHandles;
  readonly vertex?: GraphBuffer;
  readonly index?: GraphBuffer;
  readonly meshBindGroup: BindGroup;
  readonly raster: MaterialAbiRasterAdapter;
  readonly deformation: 'rigid' | 'skin';
  readonly clustered: boolean;
  readonly pipelines: ProjectedRasterPipelines;
}

/**
 * Immutable shader/layout facts of one raster class's pipelines. Worlds, GUIDs
 * and vertex/index allocations cannot split it. Only the private stock
 * recording closure captures the layout, topology, render state and texture
 * mask; raw projections retain per-mesh lazy reads and retry boundaries.
 */
export interface RasterPipelineShape {
  readonly raster: MaterialAbiRasterAdapter;
  readonly prepared: PreparedBatch;
  readonly artifact: MaterialShaderArtifact;
  readonly deformation: 'rigid' | 'skin';
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly rendererRecording: boolean;
  readonly shaderUvSetCount: number;
  readonly stripIndexFormat: 'uint16' | 'uint32' | undefined;
  readonly standardSurfaceDiscards: number;
  readonly layoutProjection: MeshGpuHandles['layoutProjection'] | undefined;
  readonly topology: GpuDrivenBatch['key']['topology'] | undefined;
  readonly renderState: MaterialRenderState | undefined;
  readonly standardTextureMask: number | undefined;
  readonly preparationFactory: MaterialPipelineFactory | undefined;
  readonly visibleSurface: boolean;
}

export function isSingleLayerMediumArtifact(artifact: MaterialShaderArtifact): boolean {
  return artifact.receipt?.surface?.model === 'single-layer-medium';
}

/** Recording shapes share pipelines across batches; raw projections keep one per class. */
export function rasterPipelineShapeKey(shape: RasterPipelineShape): string | undefined {
  if (shape.layoutProjection === undefined) return undefined;
  const { artifact } = shape;
  return JSON.stringify([
    shape.deformation,
    shape.layoutProjection.digest,
    shape.layoutProjection.arrayStride,
    shape.shaderUvSetCount,
    shape.topology,
    shape.stripIndexFormat ?? '',
    shape.renderState ?? null,
    shape.standardTextureMask ?? -1,
    shape.standardSurfaceDiscards,
    artifact.material,
    artifact.pass,
    artifact.layoutIdentity,
    artifact.receipt?.sceneIndexEntry ?? '',
    artifact.vertexEntry ?? '',
    artifact.fragmentEntry ?? '',
    artifact.receipt?.receiptIdentity ?? '',
    artifact.receipt?.generation ?? 0,
    artifact.variantSet ?? '',
    artifact.reflectionFallbackOutputAvailable === true,
    isSingleLayerMediumArtifact(artifact),
    materialArtifactProgramIdentity(artifact),
  ]);
}

/** One immutable artifact variant per fragment entry, created on its first use. */
function fragmentArtifact(
  artifact: MaterialShaderArtifact,
  fragmentEntry: string | undefined,
  coverageOnly: boolean,
): MaterialShaderArtifact {
  if (fragmentEntry === undefined) return artifact;
  return {
    ...artifact,
    fragmentEntry,
    ...(fragmentEntry === 'fs_temporal' ? { vertexEntry: 'vs_temporal' } : {}),
    ...(coverageOnly
      ? { variantSet: variantSetForCoveragePass(artifact.variantSet, true) ?? '' }
      : {}),
  };
}

function shapeRenderState(
  shape: RasterPipelineShape,
  selected: MaterialShaderArtifact,
  coverageOnly: boolean,
): MaterialRenderState | undefined {
  const renderState = shape.rendererRecording ? shape.renderState : shape.prepared.renderState;
  if (selected.fragmentEntry !== 'fs_temporal') return renderState;
  return geometryRenderStateForPass(renderState, 'temporal', coverageOnly);
}

/**
 * Artifact and render state are fixed by this graph projection. Only
 * attachment formats vary at encode; the returned function retains one owned
 * result per format set and retries failed admission on the next call.
 */
function pipelineForFragment(
  shape: RasterPipelineShape,
  fragmentEntry: string | undefined,
  coverageOnly = false,
  forwardColorPass = false,
): RasterPipelineFor {
  let projectedPipelines: Map<string, ResultOk<RenderPipeline>> | undefined;
  let selectedArtifact: MaterialShaderArtifact | undefined;
  return (formats, formatKey, preparation = false) => {
    const key = formatKey ?? formats.join(',');
    const projected = projectedPipelines?.get(key);
    if (projected !== undefined) return shape.rendererRecording ? projected : ok(projected.value);
    // Unused G-buffer, temporal and coverage entries need no artifact copy.
    selectedArtifact ??= fragmentArtifact(shape.artifact, fragmentEntry, coverageOnly);
    const { prepared } = shape;
    const selected = shape.raster.pipeline(
      formats[0] ?? shape.format,
      shape.sampleCount,
      shape.layoutProjection ?? prepared.mesh.layoutProjection,
      // The producer receipt owns the selected shader's UV ABI.
      shape.shaderUvSetCount,
      shape.topology ?? prepared.batch.key.topology,
      shape.stripIndexFormat,
      shapeRenderState(shape, selectedArtifact, coverageOnly),
      selectedArtifact,
      formats.slice(1),
      shape.rendererRecording ? shape.standardTextureMask : prepared.standardTextureMask,
      forwardColorPass,
      preparation ? shape.preparationFactory : undefined,
      shape.standardSurfaceDiscards,
    );
    if (selected.ok) {
      projectedPipelines ??= new Map();
      // Retain an owned result; an RHI result may observe value reads.
      projectedPipelines.set(key, ok(selected.value));
    }
    return selected;
  };
}

export function createRasterPipelines(shape: RasterPipelineShape): ProjectedRasterPipelines {
  const { artifact } = shape;
  const pipelineFor = pipelineForFragment(shape, undefined, false, true);
  // Only the template forward entry has an fs_opaque twin; an authored
  // fragment entry keeps its own pipeline.
  const opaquePipelineFor =
    artifact.fragmentEntry === undefined || artifact.fragmentEntry === 'fs_main'
      ? pipelineForFragment(shape, STANDARD_OPAQUE_FRAGMENT_ENTRY, false, true)
      : pipelineFor;
  const gbufferPipelineFor = pipelineForFragment(
    shape,
    shape.deformation === 'skin' && shape.visibleSurface
      ? SKIN_UNCOVERED_GBUFFER_ENTRY
      : 'fs_gbuffer',
  );
  const temporalPipelineFor = pipelineForFragment(shape, 'fs_temporal');
  // Output-domain TAAU coverage reuses the culled/LOD-selected indirect rows;
  // only the binary variant and depth writes differ.
  const coveragePipelineFor = pipelineForFragment(shape, 'fs_temporal', true);
  const pipelines = {
    pipelineFor,
    opaquePipelineFor,
    gbufferPipelineFor,
    temporalPipelineFor,
    coveragePipelineFor,
  };
  if (!isSingleLayerMediumArtifact(artifact)) return pipelines;
  return {
    ...pipelines,
    nearestPipelineFor: pipelineForFragment(shape, 'fs_nearest_layer'),
    colorPipelineFor: pipelineForFragment(shape, 'fs_color'),
  };
}

export function selectRasterPipeline(
  batch: ProjectedRasterClass,
  fragmentEntryPoint: string | undefined,
  coverageOnly: boolean,
): RasterPipelineFor {
  const { pipelines } = batch;
  switch (fragmentEntryPoint) {
    case 'fs_temporal':
      return coverageOnly ? pipelines.coveragePipelineFor : pipelines.temporalPipelineFor;
    case 'fs_gbuffer':
      return pipelines.gbufferPipelineFor;
    case 'fs_nearest_layer':
      return pipelines.nearestPipelineFor ?? pipelines.pipelineFor;
    case 'fs_color':
      return pipelines.colorPipelineFor ?? pipelines.pipelineFor;
    case STANDARD_OPAQUE_FRAGMENT_ENTRY:
      return pipelines.opaquePipelineFor;
    default:
      return pipelines.pipelineFor;
  }
}

/** The compiled class a live batch draws with in this pass, or none. */
export function rasterClassFor(
  rasterClasses: ReadonlyMap<string, ProjectedRasterClass>,
  rendererRecording: boolean,
  live: LiveRasterBatch,
  filter?: RenderPipelineGpuDrivenFilter,
  fragmentEntryPoint?: string,
): ProjectedRasterClass | undefined {
  if (live.batch.visibleCapacity === 0) return undefined;
  const batch = rasterClasses.get(rendererRecording ? live.recordingClassKey : live.classKey);
  if (batch === undefined) {
    throw new RhiError({
      code: 'internal-error',
      expected: `compiled raster class for live GPU batch ${live.batch.batchId}`,
      hint: 'derive the graph signature from the same raster class set as the live batches',
    });
  }
  if (
    fragmentEntryPoint === 'fs_temporal' &&
    !gpuTemporalEligible(
      batch.artifact.material,
      batch.deformation,
      live.batch.lod?.coverages.length ?? 0,
    )
  )
    return undefined;
  if (
    !gpuRasterFilterMatches(
      filter,
      live.batch.key.materialPass,
      isSingleLayerMediumArtifact(batch.artifact),
    )
  ) {
    return undefined;
  }
  return batch;
}

export interface ImportedMeshBuffers {
  readonly vertex: GraphBuffer;
  readonly index?: GraphBuffer;
}

export function importSurfaceBuffers(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  materialRaster: MaterialAbiRasterAdapter,
): Result<GraphAccess[], RenderGraphError> {
  const page = graph.importBuffer(
    'gpu-driven.surface.dynamic-input',
    {
      size: materialRaster.surfaceDynamicInputBufferSize,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    },
    () => materialRaster.surfaceDynamicInputBuffer,
  );
  if (!page.ok) return page;
  const frame = graph.importBuffer(
    'gpu-driven.surface.frame-input',
    {
      size: materialRaster.surfaceDynamicFrameBufferSize,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    },
    () => materialRaster.surfaceDynamicFrameBuffer,
  );
  if (!frame.ok) return frame;
  const sharedFrame = graph.importBuffer(
    'gpu-driven.surface.shared-frame-input',
    {
      size: materialRaster.surfaceDynamicSharedFrameBufferSize,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    },
    () => materialRaster.surfaceDynamicSharedFrameBuffer,
  );
  if (!sharedFrame.ok) return sharedFrame;
  return ok([
    { resource: page.value, usage: 'storage-read' },
    { resource: frame.value, usage: 'storage-read' },
    { resource: sharedFrame.value, usage: 'uniform-read' },
  ]);
}

export function importMeshBuffers(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  prepared: PreparedBatch,
  accesses: GraphAccess[],
): Result<ImportedMeshBuffers, RenderGraphError> {
  const { mesh } = prepared;
  const label = `gpu-driven.standard.${prepared.worldKey}.${prepared.batch.key.assetHandle}`;
  const vertex = graph.importBuffer(
    `${label}.vertex`,
    { size: mesh.vboBytes, usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST },
    () => mesh.vertexBuffer.handle,
  );
  if (!vertex.ok) return vertex;
  accesses.push({ resource: vertex.value, usage: 'vertex-read' });
  const indexBuffer = mesh.indexBuffer;
  if (indexBuffer === null) return ok({ vertex: vertex.value });
  const index = graph.importBuffer(
    `${label}.index`,
    { size: mesh.iboBytes, usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST },
    () => indexBuffer.handle,
  );
  if (!index.ok) return index;
  accesses.push({ resource: index.value, usage: 'index-read' });
  return ok({ vertex: vertex.value, index: index.value });
}
