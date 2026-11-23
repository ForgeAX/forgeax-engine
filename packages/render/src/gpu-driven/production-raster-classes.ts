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
import { artifactAlphaMask, maskedInEarlyPassVariantSet } from '../material-alpha-mask';
import { requireStandardGBufferReceipt } from '../material-program-inputs';
import { seededDepthRenderState } from '../material-render-state';
import { rasterColorFormat } from '../material-stage-constants';
import { SKIN_UNCOVERED_GBUFFER_ENTRY } from '../pbr-pipeline';
import { isForwardShadowColorEntry } from '../pipeline/forward-shadow-admission';
import { PREDEPTH_FRAGMENT_ENTRY, predepthFragmentEntry } from '../predepth-coverage';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import type { RenderSystemInternals } from '../record/render-context';
import {
  lacksSurfaceDataEntry,
  STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY,
  STANDARD_OPAQUE_FRAGMENT_ENTRY,
} from '../record/standard-opaque-entry';
import type { RenderPipelineFrame, RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type { GpuDrivenBatch } from './batch-topology';
import type { LiveRasterBatch } from './live-raster';
import { withFrameLighting } from './pbr-program';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import type { PreparedBatch } from './production-raster-prepare';
import {
  gpuRasterFilterMatches,
  gpuTemporalEligible,
  isVelocityRasterEntry,
} from './raster-selection';

type MaterialPipelineFactory = NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;

export type RasterPipelineFor = (
  formats: readonly TextureFormat[],
  formatKey?: string,
  preparation?: boolean,
  sampleCount?: 1 | 4,
  opaqueDepthPrimed?: boolean,
) => Result<RenderPipeline, RhiError>;

export interface ProjectedRasterPipelines {
  readonly pipelineFor: RasterPipelineFor;
  readonly aoInputPipelineFor: RasterPipelineFor;
  readonly predepthPipelineFor: RasterPipelineFor;
  readonly aoInputMsaaPipelineFor: RasterPipelineFor;
  readonly temporalPipelineFor: RasterPipelineFor;
  readonly sceneVelocityPipelineFor: RasterPipelineFor;
  readonly coveragePipelineFor: RasterPipelineFor;
  readonly gbufferPipelineFor: RasterPipelineFor;
  readonly compactGbufferPipelineFor: RasterPipelineFor;
  /** Forward entry for the unfogged base View slot; equals `pipelineFor` for authored entries. */
  readonly opaquePipelineFor: RasterPipelineFor;
  /** Forward colour entries over a prepass-seeded depth (see seededDepthRenderState). */
  readonly seededPipelineFor: (fragmentEntryPoint: string | undefined) => RasterPipelineFor;
  readonly screenPipelineFor: RasterPipelineFor;
  readonly nearestPipelineFor?: RasterPipelineFor;
  readonly colorPipelineFor?: RasterPipelineFor;
}

/**
 * Raster classes are the compiled graph's resource facts: pipelines, mesh
 * buffers and bind groups. Batch windows, indirect offsets and
 * representatives are live per-frame facts read at encode.
 */
export interface ProjectedRasterClass {
  readonly predepthCovered: boolean;
  renderState: MaterialRenderState | undefined;
  diagnosticSourceDigest?: string;
  readonly artifact: MaterialShaderArtifact;
  /** Raw authored graphs import this mesh. A stock command binds its live draw row. */
  readonly mesh?: MeshGpuHandles;
  cameraVisit?: boolean;
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
  readonly predepthCovered: boolean;
  readonly raster: MaterialAbiRasterAdapter;
  readonly prepared: PreparedBatch | undefined;
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
  readonly directionalShadowSimple?: boolean;
  readonly leanLighting?: boolean;
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
    shape.directionalShadowSimple === true,
    shape.leanLighting === true,
    shape.stripIndexFormat ?? '',
    shape.renderState ?? null,
    shape.standardTextureMask ?? -1,
    shape.standardSurfaceDiscards,
    shape.predepthCovered,
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
    ...(isVelocityRasterEntry(fragmentEntry) ? { vertexEntry: 'vs_temporal' } : {}),
    ...(coverageOnly
      ? { variantSet: variantSetForCoveragePass(artifact.variantSet, true) ?? '' }
      : {}),
  };
}

function shapeRenderState(
  shape: RasterPipelineShape,
  selected: MaterialShaderArtifact,
  coverageOnly: boolean,
  seededDepth: boolean,
  opaqueDepthPrimed: boolean,
): MaterialRenderState | undefined {
  const renderState = shape.renderState;
  if (seededDepth && shape.predepthCovered)
    return seededDepthRenderState(renderState, artifactAlphaMask(shape.artifact.variantSet));
  return geometryRenderStateForPass(
    renderState,
    isVelocityRasterEntry(selected.fragmentEntry) ? 'temporal' : 'forward',
    coverageOnly,
    undefined,
    selected.fragmentEntry,
    opaqueDepthPrimed,
  );
}

/**
 * A seeded masked draw tests `equal` against the depth its own alpha test
 * wrote in the prepass, so it selects the program without the alpha discard
 * (maskedInEarlyPassVariantSet). That key is a discard-free opaque row, so it
 * takes the simple receiver like any opaque draw (UE ForwardLightingCommon.ush
 * shares one shadow path for MATERIALBLENDING_SOLID || MATERIALBLENDING_MASKED).
 */
function maskedInEarlyPassArtifact(
  shape: RasterPipelineShape,
  artifact: MaterialShaderArtifact,
): MaterialShaderArtifact {
  const variantSet = maskedInEarlyPassVariantSet(
    artifact.variantSet,
    shape.renderState,
    seededDepthRenderState(shape.renderState, artifactAlphaMask(artifact.variantSet)),
    artifact.fragmentEntry,
  );
  return variantSet === undefined || variantSet === artifact.variantSet
    ? artifact
    : { ...artifact, variantSet };
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
  seededDepth = false,
): RasterPipelineFor {
  // At most four variants per actual attachment tuple (samples x primed depth).
  let projectedPipelines: Map<string, (ResultOk<RenderPipeline> | undefined)[]> | undefined;
  let generalArtifact: MaterialShaderArtifact | undefined;
  let selectedArtifact: MaterialShaderArtifact | undefined;
  let renderState: MaterialRenderState | undefined;
  const build = (
    artifact: MaterialShaderArtifact,
    formats: readonly TextureFormat[],
    preparation: boolean,
    sampleCount: 1 | 4,
  ) => {
    const layout = shape.layoutProjection ?? shape.prepared?.mesh.layoutProjection;
    const topology = shape.topology ?? shape.prepared?.batch.key.topology;
    if (layout === undefined || topology === undefined)
      throw new Error('A raster pipeline needs its admitted vertex layout and topology');
    return shape.raster.pipeline(
      rasterColorFormat(formats, shape.format),
      sampleCount,
      layout,
      // The producer receipt owns the selected shader's UV ABI.
      shape.shaderUvSetCount,
      topology,
      shape.stripIndexFormat,
      renderState,
      artifact,
      formats.slice(1),
      shape.rendererRecording ? shape.standardTextureMask : shape.prepared?.standardTextureMask,
      forwardColorPass,
      preparation ? shape.preparationFactory : undefined,
      shape.standardSurfaceDiscards,
    );
  };
  return (
    formats,
    formatKey,
    preparation = false,
    sampleCount = shape.sampleCount,
    opaqueDepthPrimed = false,
  ) => {
    const key = formatKey ?? formats.join(',');
    const variant = (sampleCount === 4 ? 2 : 0) + Number(opaqueDepthPrimed);
    let variants = projectedPipelines?.get(key);
    const projected = variants?.[variant];
    if (projected !== undefined) return shape.rendererRecording ? projected : ok(projected.value);
    // Unused G-buffer, temporal and coverage entries need no artifact copy.
    if (generalArtifact === undefined) {
      generalArtifact = fragmentArtifact(shape.artifact, fragmentEntry, coverageOnly);
      // The pass state follows the authored ALPHA_MASK lane; the general and
      // simple receivers share it.
      if (seededDepth && shape.predepthCovered)
        generalArtifact = maskedInEarlyPassArtifact(shape, generalArtifact);
    }
    renderState = shapeRenderState(
      shape,
      generalArtifact,
      coverageOnly,
      seededDepth,
      opaqueDepthPrimed,
    );
    selectedArtifact ??= forwardColorPass
      ? withFrameLighting(
          generalArtifact,
          shape.directionalShadowSimple === true,
          shape.leanLighting === true,
        )
      : generalArtifact;
    const selected = build(selectedArtifact, formats, preparation, sampleCount);
    // Both specializations preserve the general program's output. While a
    // specialized PSO builds, the frame draws with that general program;
    // the fallback is not retained, so the selected PSO takes over once ready.
    if (!selected.ok && selectedArtifact !== generalArtifact) {
      const general = build(generalArtifact, formats, preparation, sampleCount);
      if (general.ok && !preparation) return shape.rendererRecording ? general : ok(general.value);
    }
    if (selected.ok) {
      projectedPipelines ??= new Map();
      // Retain an owned result; an RHI result may observe value reads.
      if (variants === undefined) {
        variants = [];
        projectedPipelines.set(key, variants);
      }
      variants[variant] = ok(selected.value);
    }
    return selected;
  };
}

export function createRasterPipelines(shape: RasterPipelineShape): ProjectedRasterPipelines {
  const { artifact } = shape;
  const pipelineFor = pipelineForFragment(shape, undefined, false, true);
  const aoInputPipelineFor = pipelineForFragment(shape, 'fs_ao_input');
  const depthOnlyPipelineFor = pipelineForFragment(shape, predepthFragmentEntry(artifact));
  // A single-sample normal reader shares the same primary depth rasterization.
  // The dedicated depth fragment has no color output, so select the coverage
  // equivalent AO entry when this pass declares its normal attachment.
  const predepthPipelineFor: RasterPipelineFor = (formats, ...args) =>
    (formats.length === 0 ? depthOnlyPipelineFor : aoInputPipelineFor)(formats, ...args);
  const aoInputMsaaPipelineFor = pipelineForFragment(shape, 'fs_ao_input_msaa');
  // Only the template forward entry has an fs_opaque twin; an authored
  // fragment entry keeps its own pipeline.
  const templateEntry =
    artifact.fragmentEntry === undefined || artifact.fragmentEntry === 'fs_main';
  const opaquePipelineFor = templateEntry
    ? pipelineForFragment(shape, STANDARD_OPAQUE_FRAGMENT_ENTRY, false, true)
    : pipelineFor;
  const seeded = new Map<string | undefined, RasterPipelineFor>();
  const seededPipelineFor = (fragmentEntryPoint: string | undefined): RasterPipelineFor => {
    // Template entries keep their fs_opaque / screen twin; authored ones their own.
    const entry =
      templateEntry &&
      (fragmentEntryPoint === STANDARD_OPAQUE_FRAGMENT_ENTRY ||
        fragmentEntryPoint === STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY ||
        isForwardShadowColorEntry(fragmentEntryPoint))
        ? fragmentEntryPoint
        : undefined;
    let pipeline = seeded.get(entry);
    if (pipeline === undefined) {
      pipeline = pipelineForFragment(shape, entry, false, true, true);
      seeded.set(entry, pipeline);
    }
    return pipeline;
  };
  const gbufferPipelineFor = pipelineForFragment(
    shape,
    shape.deformation === 'skin' && shape.visibleSurface
      ? SKIN_UNCOVERED_GBUFFER_ENTRY
      : 'fs_gbuffer',
  );
  const compact = pipelineForFragment(shape, 'fs_gbuffer_compact');
  const compactGbufferPipelineFor: RasterPipelineFor = (...args) => {
    requireStandardGBufferReceipt(artifact.receipt, true);
    return compact(...args);
  };
  const temporalPipelineFor = pipelineForFragment(shape, 'fs_temporal');
  // Output-domain TAAU coverage reuses the culled/LOD-selected indirect rows;
  // only the binary variant and depth writes differ.
  const coveragePipelineFor = pipelineForFragment(shape, 'fs_temporal', true);
  const pipelines = {
    pipelineFor,
    aoInputPipelineFor,
    predepthPipelineFor,
    aoInputMsaaPipelineFor,
    opaquePipelineFor,
    seededPipelineFor,
    screenPipelineFor: templateEntry
      ? pipelineForFragment(shape, STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY, false, true)
      : pipelineFor,
    gbufferPipelineFor,
    compactGbufferPipelineFor,
    temporalPipelineFor,
    sceneVelocityPipelineFor: pipelineForFragment(shape, 'fs_scene_velocity'),
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
  seededDepth = false,
): RasterPipelineFor {
  const { pipelines } = batch;
  if (seededDepth) return pipelines.seededPipelineFor(fragmentEntryPoint);
  switch (fragmentEntryPoint) {
    case 'fs_scene_velocity':
      return pipelines.sceneVelocityPipelineFor;
    case 'fs_temporal':
      return coverageOnly ? pipelines.coveragePipelineFor : pipelines.temporalPipelineFor;
    case 'fs_gbuffer':
      return pipelines.gbufferPipelineFor;
    case 'fs_gbuffer_compact':
      return pipelines.compactGbufferPipelineFor;
    case PREDEPTH_FRAGMENT_ENTRY:
      return pipelines.predepthPipelineFor;
    case 'fs_ao_input':
      return pipelines.aoInputPipelineFor;
    case 'fs_ao_input_msaa':
      return pipelines.aoInputMsaaPipelineFor;
    case 'fs_nearest_layer':
      return pipelines.nearestPipelineFor ?? pipelines.pipelineFor;
    case 'fs_color':
      return pipelines.colorPipelineFor ?? pipelines.pipelineFor;
    case STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY:
      return pipelines.screenPipelineFor;
    case STANDARD_OPAQUE_FRAGMENT_ENTRY:
      return pipelines.opaquePipelineFor;
    default:
      return pipelines.pipelineFor;
  }
}

/** Raw graphs retain each Mesh resolver; physical aliases admit later compatible bindings. */
export function rasterClassProjectionKey(
  live: LiveRasterBatch,
  rendererRecording: boolean,
): string {
  return rendererRecording
    ? live.recordingClassKey
    : `${live.classKey}:mesh:${live.batch.key.assetHandle}`;
}

function hasNoForwardOutput(
  batch: ProjectedRasterClass,
  rendererRecording: boolean,
  fragmentEntryPoint: string | undefined,
  coverageOnly: boolean,
): boolean {
  const state = batch.renderState;
  // The built-in Unlit program has no storage side effects. Keep its source
  // and GPU ownership (including shadow work), but record no ordinary color
  // draw when it writes neither attachments nor depth/stencil. Raw callers,
  // custom entries and coverage overrides retain their observable recording.
  return (
    rendererRecording &&
    !coverageOnly &&
    batch.artifact.material === 'forgeax::default-unlit' &&
    batch.artifact.pass === 'forward' &&
    (batch.artifact.fragmentEntry === undefined || batch.artifact.fragmentEntry === 'fs_main') &&
    (batch.artifact.vertexEntry === undefined ||
      batch.artifact.vertexEntry === 'vs_main' ||
      batch.artifact.vertexEntry === 'vs_scene_index') &&
    (fragmentEntryPoint === undefined ||
      fragmentEntryPoint === STANDARD_OPAQUE_FRAGMENT_ENTRY ||
      fragmentEntryPoint === STANDARD_FORWARD_SCREEN_FRAGMENT_ENTRY) &&
    state?.colorWriteMask === 0 &&
    state.depthWriteEnabled === false &&
    state.stencil === undefined &&
    state.outputs === undefined
  );
}

/** The compiled class a live batch draws with in this pass, or none. */
export function rasterClassFor(
  rasterClasses: ReadonlyMap<string, ProjectedRasterClass>,
  rendererRecording: boolean,
  live: LiveRasterBatch,
  filter?: RenderPipelineGpuDrivenFilter,
  fragmentEntryPoint?: string,
  coverageOnly = false,
): ProjectedRasterClass | undefined {
  if (live.batch.visibleCapacity === 0) return undefined;
  const batch =
    rasterClasses.get(rasterClassProjectionKey(live, rendererRecording)) ??
    (rendererRecording ? undefined : rasterClasses.get(live.classKey));
  if (batch === undefined) {
    throw new RhiError({
      code: 'internal-error',
      expected: `compiled raster class for live GPU batch ${live.batch.batchId}`,
      hint: 'derive the graph signature from the same raster class set as the live batches',
    });
  }
  if (hasNoForwardOutput(batch, rendererRecording, fragmentEntryPoint, coverageOnly))
    return undefined;
  if (
    rendererRecording &&
    lacksSurfaceDataEntry(fragmentEntryPoint, batch.artifact.material, batch.artifact.program, true)
  )
    return undefined;
  if (
    isVelocityRasterEntry(fragmentEntryPoint) &&
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
  const label = `gpu-driven.standard.${prepared.batch.key.assetHandle}`;
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
