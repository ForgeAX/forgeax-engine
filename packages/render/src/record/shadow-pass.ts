import { probeVideoHighPerfUpload } from '@forgeax/engine-graphics-extras';
import {
  type BindGroup,
  type BindGroupEntry,
  type Buffer,
  type RenderBundle,
  type RenderPipeline,
  type RhiDevice,
  RhiError,
  type RhiQueue,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import {
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '@forgeax/engine-shader';
import type { PassSelector } from '@forgeax/engine-types';
import { isTriangleTopology } from '@forgeax/engine-types';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { atmosphereBindings } from '../environment/bindings';
import { GPU_DRIVEN_INDIRECT_COMMAND_BYTES } from '../gpu-driven/batch-layout';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { prepareHiddenMaterialExecutions } from '../gpu-driven/material-artifacts';
import type { PreparedRasterBindings } from '../gpu-driven/prepared-raster-bundle';
import type { GpuDrivenShadowBatchProjection } from '../gpu-driven/production-raster';
import {
  type ShadowDirtyRect,
  type ShadowViewIdentity,
  shadowViewIdentityKey,
} from '../gpu-driven/shadow-views';
import type { GpuDrivenView } from '../gpu-driven/view-gpu';
import type { GpuBuffer } from '../gpu-resource';
import {
  assembleMaterialWithSkylightEntries,
  skylightBindGroupResources,
} from '../ibl/skylight-bind-group';
import {
  isReflectedTransform,
  reflectedRenderState,
  transformRenderState,
} from '../material-render-state';
import {
  buildPbrMaterialUserRegionEntries,
  omittedStandardMaterialBindings,
  pbrSkinMeshDynamicOffsets,
  SHADOW_CASTER_SHADER_ID,
  shadowCasterVariantSet,
} from '../pbr-pipeline';
import { COOKIE_MATRIX_BYTES } from '../prepare/extended-lighting/resources';
import type {
  DispatchList,
  ExtractedLights,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type { MaterialDispatchPass } from '../scene/material-dispatch';
import { matchPass } from '../systems/pass-selector';
import { FirstEntryMap } from './first-entry-map';
import { clusteredMeshSlotBindGroup, meshSlotBindGroup } from './frame-lighting';
import type { MaterialBgAssemblyCacheEntry, ValidatedRenderable } from './frame-snapshot';
import {
  geometrySkinBindGroup,
  resolveGeometryInstanceBuffer,
  resolveGeometryInstancesBindGroup,
} from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg,
  materialBindingResourcesCurrent,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import { materialUniformSlot } from './material-uniforms';
import {
  findFromChain,
  getOrCreateFromChain,
  getOrCreateFromChainResult,
  MESH_PER_ENTITY_STRIDE,
  meshDrawSlot,
  prepareMeshDraw,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext, MaterialShaderPipelineEntry } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE, MATERIAL_UNIFORM_BYTES } from './render-context';
import { shadowViewContains } from './shadow-culling';
import { capturesShadowBundleWorkload, recordShadowBundleWorkload } from './shadow-raster-ledger';
import { SingleMaterialHandleSet } from './single-material-handle-set';
import { submeshRange } from './submesh-range';
import { POINTS_LINES_VIEW_BYTES, pointShadowViewOffset, VIEW_UNIFORM_BYTES } from './view-ubo';

export const SHADOW_CASTER_SLOT_STRIDE = 256;
export const SHADOW_CASTER_BUFFER_SIZE = SHADOW_CASTER_SLOT_STRIDE * 8;

/**
 * Renderer-owned capable shadow submission. The view/counter/indirect ABI is
 * shared with the main GPU-driven lane; this record only supplies the
 * prepared per-batch raster state that cannot be inferred from a raw scene.
 * When present, the capable lane emits one indirect command per topology batch
 * and never walks `validatedOrdered`.
 */
export interface GpuDrivenShadowBatch {
  readonly indirectOffset: number;
  readonly pipeline: RenderPipeline;
  readonly meshBindGroup: BindGroup;
  /** One visible-segment window per LOD level command, in level order. */
  readonly visibleBindGroups: readonly BindGroup[];
  readonly deformation: 'rigid' | 'skin';
  /** Complete binding for this batch, including opaque batches after custom casters. */
  readonly materialGroup: BindGroup;
  readonly vertexBuffer: Buffer;
  readonly indexBuffer?: Buffer | undefined;
  readonly indexFormat?: 'uint16' | 'uint32' | undefined;
}

export interface GpuDrivenShadowSubmission {
  readonly view: GpuDrivenView;
  readonly batches: readonly GpuDrivenShadowBatch[];
}

interface PreparedGpuDrivenShadowSubmission {
  readonly view: GpuDrivenView;
  readonly bundles: readonly RenderBundle[];
  readonly workload?: { readonly indirect: number; readonly indexedIndirect: number };
}

export function directionalShadowCasterOffset(cascadeIndex: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * cascadeIndex;
}

export function spotShadowCasterOffset(tile: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * (4 + tile);
}

export function writeShadowCasterUniforms(
  queue: RhiQueue,
  buffer: Buffer,
  lights: ExtractedLights,
): void {
  for (let cascade = 0; cascade < 4; cascade += 1) {
    const written = queue.writeBuffer(
      buffer,
      directionalShadowCasterOffset(cascade),
      new Uint32Array([cascade, 0, 0, 0]),
    );
    if (!written.ok) throw written.error;
  }
  for (const snapshot of lights.spot) {
    const tile = snapshot.shadowAtlasTile;
    if (tile < 0 || tile >= 4 || snapshot.lightViewProj === undefined) continue;
    const offset = spotShadowCasterOffset(tile);
    const header = queue.writeBuffer(buffer, offset, new Uint32Array([0, 1, 0, 0]));
    if (!header.ok) throw header.error;
    const matrix = queue.writeBuffer(buffer, offset + 16, snapshot.lightViewProj);
    if (!matrix.ok) throw matrix.error;
  }
}

function ensureTypedShadowViewBg(
  c: _InternalRenderPipelineContext,
  viewOffset: number,
  cascadeOffset: number,
  variant: string,
): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const shadowSampler = pipelineState.perPassResources.shadowSampler;
  if (shadowSampler === null) return null;
  const extendedLighting = pipelineState.extendedLightingAvailable ?? false;
  const iesProfileTextureView = pipelineState.iesProfileTextureView;
  const cookieTextureView = pipelineState.cookieTextureView;
  const cookieMatrixBuffer = pipelineState.cookieMatrixBuffer;
  const ltcLambertTextureView = pipelineState.ltcLambertTextureView;
  const ltcGgxTextureView = pipelineState.ltcGgxTextureView;
  const extendedLightingCacheKeys: object[] = [];
  const extendedLightingEntries: BindGroupEntry[] = [];
  if (extendedLighting) {
    if (
      iesProfileTextureView === undefined ||
      cookieTextureView === undefined ||
      cookieMatrixBuffer === undefined ||
      ltcLambertTextureView === undefined ||
      ltcGgxTextureView === undefined
    ) {
      return null;
    }
    extendedLightingCacheKeys.push(
      pipelineState.defaultSampler,
      iesProfileTextureView,
      cookieTextureView,
      ltcLambertTextureView,
      ltcGgxTextureView,
      cookieMatrixBuffer,
    );
    extendedLightingEntries.push(
      { binding: 24, resource: { kind: 'textureView', value: cookieTextureView } },
      {
        binding: 9,
        resource: { kind: 'sampler', value: pipelineState.defaultSampler },
      },
      {
        binding: 11,
        resource: { kind: 'textureView', value: iesProfileTextureView },
      },
      {
        binding: 12,
        resource: { kind: 'textureView', value: cookieTextureView },
      },
      {
        binding: 13,
        resource: { kind: 'textureView', value: ltcLambertTextureView },
      },
      {
        binding: 14,
        resource: { kind: 'textureView', value: ltcGgxTextureView },
      },
      {
        binding: 15,
        resource: {
          kind: 'buffer',
          value: { buffer: cookieMatrixBuffer, size: COOKIE_MATRIX_BYTES },
        },
      },
    );
  }
  const projectorAvailable = pipelineState.projectorAvailable !== false;
  const lowLimitCloudBindings = !extendedLighting && !projectorAvailable;
  try {
    return getOrCreateFromChain(
      frameState.viewBindGroupCache,
      [
        pipelineState.viewUniformBuffer,
        pipelineState.shadowArrayFallbackTextureView,
        shadowSampler,
        pipelineState.shadowAtlasFallbackTextureView,
        pipelineState.shadowParamsBuffer,
        pipelineState.shadowCasterCascadeBuffer,
        pipelineState.shadowArrayFallbackTextureView,
        ...(extendedLighting
          ? extendedLightingCacheKeys
          : projectorAvailable
            ? [pipelineState.defaultWhiteTextureView, pipelineState.defaultSampler]
            : []),
        pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
        ...(lowLimitCloudBindings
          ? []
          : [pipelineState.defaultWhiteTextureView, pipelineState.defaultSampler]),
      ],
      variant,
      () => {
        const created = runtime.device.createBindGroup({
          label: variant,
          layout: pipelineState.viewBindGroupLayout,
          entries: [
            ...atmosphereBindings(pipelineState),
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.viewUniformBuffer,
                  offset: viewOffset,
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            },
            {
              binding: 3,
              resource: {
                kind: 'textureView',
                value: pipelineState.shadowArrayFallbackTextureView,
              },
            },
            {
              binding: 4,
              resource: { kind: 'sampler', value: shadowSampler },
            },
            ...(runtime.device.caps.storageBuffer
              ? [
                  {
                    binding: 5,
                    resource: {
                      kind: 'textureView' as const,
                      value: pipelineState.shadowAtlasFallbackTextureView,
                    },
                  },
                  {
                    binding: 6,
                    resource: {
                      kind: 'buffer' as const,
                      value: { buffer: pipelineState.shadowParamsBuffer },
                    },
                  },
                ]
              : []),
            {
              binding: 7,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.shadowCasterCascadeBuffer,
                  offset: cascadeOffset,
                  size: POINTS_LINES_VIEW_BYTES,
                },
              },
            },
            {
              binding: 8,
              resource: {
                kind: 'textureView',
                value: pipelineState.shadowArrayFallbackTextureView,
              },
            },
            ...extendedLightingEntries,
            {
              binding: 10,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: pipelineState.pointsLinesViewBuffer ?? pipelineState.viewUniformBuffer,
                  size: 80,
                },
              },
            },
            ...(!extendedLighting && projectorAvailable
              ? [
                  {
                    binding: 11,
                    resource: {
                      kind: 'textureView' as const,
                      value: pipelineState.defaultWhiteTextureView,
                    },
                  },
                  {
                    binding: 12,
                    resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
                  },
                ]
              : []),
            ...(lowLimitCloudBindings
              ? []
              : [
                  {
                    binding: 16,
                    resource: {
                      kind: 'textureView' as const,
                      value: pipelineState.defaultWhiteTextureView,
                    },
                  },
                  {
                    binding: 17,
                    resource: {
                      kind: 'sampler' as const,
                      value: pipelineState.defaultSampler,
                    },
                  },
                ]),
          ],
        });
        if (!created.ok) throw created.error;
        return created.value;
      },
      c.bindGroupCounts,
    );
  } catch (error) {
    if (error instanceof RhiError) {
      runtime.errorRegistry.fire(error);
      return null;
    }
    throw error;
  }
}

/** A static selection is usable after retained depth or this record's raster produced it. */
const recordedStaticViews = new WeakMap<_InternalRenderPipelineContext, Map<string, number>>();
function markStaticShadowRecorded(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
): void {
  const submission = c.gpuDrivenShadowViews?.submission(identity);
  if (submission === undefined) return;
  let views = recordedStaticViews.get(c);
  if (views === undefined) {
    views = new Map();
    recordedStaticViews.set(c, views);
  }
  views.set(shadowViewIdentityKey(identity), submission.generation);
}

function shadowMaterial(
  c: _InternalRenderPipelineContext,
  source: RenderableSnapshot,
  slot: number,
) {
  const resource = source.materials[slot] ?? source.material;
  const accepted = c.materialFrame?.get(resource);
  if (accepted === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'the accepted material frame for each ShadowCaster draw',
      hint: 'retain the shared material publication through shadow recording',
    });
  return accepted;
}

function hasExpectedShadowCasters(c: _InternalRenderPipelineContext): boolean {
  return (c.shadowValidatedOrdered ?? c.validatedOrdered).length > 0;
}

interface GpuDrivenShadowRecordResult {
  readonly selections: readonly GpuDrawSelection[];
  readonly complete: boolean;
}

function shadowPipeline(
  c: _InternalRenderPipelineContext,
  reflected = false,
): RenderPipeline | null {
  return (
    c.runtime.getMaterialShaderPipeline?.(
      SHADOW_CASTER_SHADER_ID,
      false,
      reflectedRenderState(undefined, reflected),
      'triangle-list',
      undefined,
      shadowCasterVariantSet(c.runtime.device.caps.storageBuffer, false),
      'shadow-caster',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'pbr',
    ) ?? null
  );
}

function gpuShadowSkinOffsets(view: import('../gpu-driven/view-gpu').GpuDrivenView) {
  const task = view.skinTaskBinding();
  if (task === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the selected shadow view Skin task output',
      hint: 'prepare the fixed Skin root pair before recording shadow consumers',
    });
  return pbrSkinMeshDynamicOffsets(0, task, true);
}

/**
 * Record the capable shadow lane from the shared view's indirect arguments.
 * The submission is an explicit prepared contract: missing view buffers or a
 * missing batch raster projection are terminal rather than a reason to fall
 * back to a CPU caster walk. The caller may then keep the existing CPU path
 * when no capable submission was published for the current view.
 */
export function recordGpuDrivenShadowIndirect(
  pass: RhiRenderPassEncoder,
  submission: GpuDrivenShadowSubmission,
): void {
  const indirect = submission.view.indirectBuffer;
  if (indirect === undefined) {
    throw new RhiError({
      code: 'internal-error',
      expected: 'GPU-driven shadow view indirect buffer',
      hint: 'publish a prepared view generation before recording a capable shadow pass',
    });
  }
  let currentPipeline: RenderPipeline | undefined;
  let currentVertex: Buffer | undefined;
  let currentIndex: Buffer | undefined;
  let currentIndexFormat: GpuDrivenShadowBatch['indexFormat'];
  let currentMaterial: BindGroup | undefined;
  let currentMesh: BindGroup | undefined;
  let currentDeformation: GpuDrivenShadowBatch['deformation'] | undefined;
  let currentVisible: BindGroup | undefined;
  for (const raster of submission.batches) {
    if (currentPipeline !== raster.pipeline) {
      pass.setPipeline(raster.pipeline);
      currentPipeline = raster.pipeline;
      // Bindings survive pipeline changes. Different resources and deformation
      // offset shapes still replace their slots below.
    }
    if (currentVertex !== raster.vertexBuffer) {
      pass.setVertexBuffer(0, raster.vertexBuffer);
      currentVertex = raster.vertexBuffer;
    }
    if (currentMaterial !== raster.materialGroup) {
      pass.setBindGroup(1, raster.materialGroup, [0]);
      currentMaterial = raster.materialGroup;
    }
    if (raster.indexBuffer !== undefined) {
      const indexFormat = raster.indexFormat;
      if (indexFormat === undefined) {
        throw new RhiError({
          code: 'internal-error',
          expected: `index format for prepared shadow raster offset ${raster.indirectOffset}`,
          hint: 'publish the geometry layout projection with the capable shadow batch',
        });
      }
      if (currentIndex !== raster.indexBuffer || currentIndexFormat !== indexFormat) {
        // One physical buffer can be interpreted by either index format.
        // Preserve the setter's original field read and retain its actual value.
        const boundBuffer = raster.indexBuffer;
        const boundFormat = raster.indexFormat as typeof indexFormat;
        pass.setIndexBuffer(boundBuffer, boundFormat);
        currentIndex = raster.indexBuffer;
        currentIndexFormat = boundFormat;
      }
    }
    if (currentMesh !== raster.meshBindGroup || currentDeformation !== raster.deformation) {
      pass.setBindGroup(
        2,
        raster.meshBindGroup,
        raster.deformation === 'skin' ? gpuShadowSkinOffsets(submission.view) : [0],
      );
      currentMesh = raster.meshBindGroup;
      currentDeformation = raster.deformation;
    }
    for (let level = 0; level < raster.visibleBindGroups.length; level += 1) {
      const visibleBindGroup = raster.visibleBindGroups[level];
      if (visibleBindGroup === undefined) continue;
      if (currentVisible !== visibleBindGroup) {
        pass.setBindGroup(3, visibleBindGroup);
        currentVisible = visibleBindGroup;
      }
      const offset = raster.indirectOffset + level * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
      if (raster.indexBuffer !== undefined) pass.drawIndexedIndirect(indirect, offset);
      else pass.drawIndirect(indirect, offset);
    }
  }
}

type ShadowPipelineProjection = Pick<
  GpuDrivenShadowBatchProjection,
  | 'shadowArtifact'
  | 'shadowRenderState'
  | 'shadowVertexEntry'
  | 'shadowFragmentEntry'
  | 'deformation'
  | 'vertexColorAvailable'
  | 'material'
  | 'mesh'
>;

/** The same native specification is used for explicit preparation and real shadow encoding. */
function requestGpuDrivenShadowPipeline(
  c: _InternalRenderPipelineContext,
  factory: _InternalRenderPipelineContext['runtime']['getMaterialShaderPipeline'],
  projection: ShadowPipelineProjection,
  batch: Pick<GpuDrivenBatch, 'key'>,
  reflected: boolean,
): RenderPipeline | null | undefined {
  const shadowArtifact = projection.shadowArtifact;
  const shadowVariantSet =
    shadowArtifact.variantSet ??
    (shadowArtifact.material === SHADOW_CASTER_SHADER_ID
      ? shadowCasterVariantSet(
          c.runtime.device.caps.storageBuffer,
          projection.deformation === 'skin',
          true,
          batch.key.admission === 'alpha-mask',
          projection.vertexColorAvailable,
        )
      : undefined);
  return factory?.call(
    c.runtime,
    // A scene-index shadow artifact may retain the logical material id for
    // batching while its specialization key owns the actual WGSL module.
    shadowArtifact.specializationKey ?? shadowArtifact.material,
    false,
    reflectedRenderState(projection.shadowRenderState, reflected),
    batch.key.topology,
    batch.key.drawKind === 'indexed' ? projection.mesh.indexFormat : undefined,
    shadowVariantSet,
    'shadow-caster',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    projection.mesh.layoutProjection,
    // The shadow projection carries the producer-validated receipt. Select
    // the immediate module adapter so a newly loaded custom Surface cannot
    // lose its first capable shadow draw to async pre-bake warm-up.
    'immediate',
    projection.deformation === 'skin' ? 'gpu-driven-skin' : 'gpu-driven-pbr',
    shadowArtifact.receipt?.sceneIndexEntry,
    undefined,
    projection.shadowVertexEntry,
    projection.shadowFragmentEntry,
    undefined,
    projection.material.standardTextureMask === undefined
      ? undefined
      : { [STANDARD_TEXTURE_MASK_OVERRIDE]: projection.material.standardTextureMask },
  );
}

interface ShadowBundleViewKey {
  readonly viewBindGroup: BindGroup;
  readonly indirect: unknown;
  readonly pipelineState: object;
  readonly fallback: unknown;
  readonly materialBuffer: unknown;
  readonly factory: unknown;
  readonly point: boolean;
}

function sameShadowBundleView(a: ShadowBundleViewKey, b: ShadowBundleViewKey): boolean {
  return (
    a.viewBindGroup === b.viewBindGroup &&
    a.indirect === b.indirect &&
    a.pipelineState === b.pipelineState &&
    a.fallback === b.fallback &&
    a.materialBuffer === b.materialBuffer &&
    a.factory === b.factory &&
    a.point === b.point
  );
}

/** Accepted static material binding retained with an alpha-mask or custom shadow row. */
interface RetainedShadowMaterial {
  readonly entry: MaterialBgAssemblyCacheEntry;
  readonly handle: number | undefined;
  readonly shader: string | undefined;
}

interface RetainedShadowBundleRow {
  readonly batch: GpuDrivenBatch;
  readonly projection: GpuDrivenShadowBatchProjection;
  readonly bundle: RenderBundle;
  readonly pipeline: RenderPipeline;
  /** Accepted static material binding of an alpha-mask or custom row. */
  readonly material?: RetainedShadowMaterial;
}

interface RetainedShadowBundleView {
  readonly key: ShadowBundleViewKey;
  readonly rows: Map<number, RetainedShadowBundleRow>;
  /** The last invocation, replayable while its plan and projections are unchanged. */
  replay?: ShadowViewReplay | undefined;
}

/**
 * One view's last fully retained invocation. Plan and projections are held
 * weakly, so an unchanged view replays without retaining a superseded frame's
 * inputs. Each distinct pipeline and material binding is still observed once.
 */
interface ShadowViewReplay {
  readonly plan: WeakRef<SubmissionPlan>;
  readonly projections: WeakRef<ReadonlyMap<number, GpuDrivenShadowBatchProjection>>;
  readonly bundles: readonly RenderBundle[];
  readonly pipelines: ReadonlyMap<RenderPipeline, RetainedShadowBundleRow>;
  readonly materials: ReadonlyMap<MaterialBgAssemblyCacheEntry, RetainedShadowBundleRow>;
  readonly workload: ShadowBundleWorkload;
}

/** Rows of the invocation being recorded; replayable only when every row is retained. */
interface ShadowReplayCollector {
  replayable: boolean;
  readonly pipelines: Map<RenderPipeline, RetainedShadowBundleRow>;
  readonly materials: Map<MaterialBgAssemblyCacheEntry, RetainedShadowBundleRow>;
  readonly workload: ShadowBundleWorkload;
}

function collectShadowReplayRow(
  collector: ShadowReplayCollector,
  row: RetainedShadowBundleRow | undefined,
): void {
  if (!collector.replayable) return;
  if (row === undefined) {
    collector.replayable = false;
    return;
  }
  if (!collector.pipelines.has(row.pipeline)) collector.pipelines.set(row.pipeline, row);
  const material = row.material?.entry;
  if (material !== undefined && !collector.materials.has(material))
    collector.materials.set(material, row);
  addShadowBundleWorkload(collector.workload, row.batch, row.projection);
}

/** The previous bundles of an unchanged view whose pipelines and bindings are still current. */
function replayShadowView(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  retainedView: RetainedShadowBundleView | undefined,
  plan: SubmissionPlan,
  projections: ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
  recording: ShadowBatchRecording,
  validatedPipelines: Map<RenderPipeline, boolean>,
): ShadowViewReplay | undefined {
  const replay = retainedView?.replay;
  if (retainedView !== undefined) retainedView.replay = undefined;
  if (
    replay === undefined ||
    replay.plan.deref() !== plan ||
    replay.projections.deref() !== projections
  )
    return undefined;
  for (const row of replay.pipelines.values())
    if (
      retainedShadowPipeline(c, identity, row, row.batch, row.projection, validatedPipelines) ===
      undefined
    )
      return undefined;
  for (const row of replay.materials.values())
    if (!retainedShadowMaterialCurrent(c, row.material, row.projection, recording))
      return undefined;
  if (retainedView !== undefined) retainedView.replay = replay;
  return replay;
}

const retainedShadowBundles = new WeakMap<object, RetainedShadowBundleView>();

/**
 * State shared by consecutive batch recordings of one shadow view invocation:
 * the previously recorded batch and the owners it resolved, which an adjacent
 * batch may reuse, plus the lazily resolved default opaque material group and
 * the once-per-invocation revalidation of retained static material bindings.
 */
interface ShadowBatchRecording {
  batch: GpuDrivenBatch | undefined;
  projection: GpuDrivenShadowBatchProjection | undefined;
  pipeline: RenderPipeline | undefined;
  material: MaterialBgAssemblyCacheEntry | undefined;
  /** The previous row's retainable material binding, when it has a static cache key. */
  retainedMaterial: RetainedShadowMaterial | undefined;
  materialPipelineState: _InternalRenderPipelineContext['pipelineState'] | undefined;
  materialFallback: _InternalRenderPipelineContext['pipelineState']['skylightFallback'] | undefined;
  opaqueMaterialGroup: BindGroup | null | undefined;
  /** A retained static material binding is revalidated once per invocation. */
  readonly validatedMaterials: Map<MaterialBgAssemblyCacheEntry, boolean>;
  /** A failed revalidation's query is the same row's recording query; use it once. */
  rejected: { projection: GpuDrivenShadowBatchProjection; group: BindGroup | null } | undefined;
}

type MutablePreparedRasterBindings = Partial<{
  -readonly [K in keyof PreparedRasterBindings]: PreparedRasterBindings[K];
}>;

type ShadowBundleWorkload = { indirect: number; indexedIndirect: number };

// Opaque standard rows depend only on their retained batch and projection plus
// these per-view physical owners; reuse their bundles across frames.
function retainedShadowBundleView(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  viewBindGroup: BindGroup,
  view: GpuDrivenView,
  reuseAdjacentShadow: boolean,
): RetainedShadowBundleView | undefined {
  if (!reuseAdjacentShadow) return undefined;
  const viewKey: ShadowBundleViewKey = {
    viewBindGroup,
    indirect: view.indirectBuffer,
    pipelineState: c.pipelineState,
    fallback: c.pipelineState.skylightFallback,
    materialBuffer: c.pipelineState.materialUniformBuffer.buffer,
    factory: c.runtime.getMaterialShaderPipeline,
    point: identity.kind === 'point',
  };
  let retainedView = retainedShadowBundles.get(view);
  if (retainedView === undefined || !sameShadowBundleView(retainedView.key, viewKey)) {
    retainedView = { key: viewKey, rows: new Map() };
    retainedShadowBundles.set(view, retainedView);
  }
  return retainedView;
}

function requireShadowBatchProjection(
  projections: ReadonlyMap<number, GpuDrivenShadowBatchProjection>,
  batch: GpuDrivenBatch,
): GpuDrivenShadowBatchProjection {
  const projection = projections.get(batch.batchId);
  if (projection === undefined) {
    throw new RhiError({
      code: 'internal-error',
      expected: `projected mesh binding for GPU-driven shadow batch ${batch.batchId}`,
      hint: 'keep shadow batch scene rows aligned with the shared SubmissionPlan',
    });
  }
  return projection;
}

/**
 * Each invocation still observes a retained row's actual PSO owner once per
 * pipeline. A current pipeline is also the row's own recording observation
 * when only its material binding is rejected.
 */
function retainedShadowPipeline(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  retainedRow: RetainedShadowBundleRow | undefined,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  validatedPipelines: Map<RenderPipeline, boolean>,
): RenderPipeline | undefined {
  if (
    retainedRow === undefined ||
    retainedRow.batch !== batch ||
    retainedRow.projection !== projection
  ) {
    return undefined;
  }
  let current = validatedPipelines.get(retainedRow.pipeline);
  if (current === undefined) {
    current =
      requestGpuDrivenShadowPipeline(
        c,
        c.runtime.getMaterialShaderPipeline,
        projection,
        batch,
        identity.kind === 'point',
      ) === retainedRow.pipeline;
    validatedPipelines.set(retainedRow.pipeline, current);
  }
  return current ? retainedRow.pipeline : undefined;
}

/** The group a fresh custom or alpha-mask row binds, consuming a rejected revalidation's query. */
function queryShadowMaterialGroup(
  c: _InternalRenderPipelineContext,
  projection: GpuDrivenShadowBatchProjection,
  recording: ShadowBatchRecording,
): BindGroup | null {
  const rejected = recording.rejected;
  if (rejected?.projection === projection) {
    recording.rejected = undefined;
    return rejected.group;
  }
  return ownedShadowMaterialGroup(c, projection);
}

/** Whether a retained row's static material binding is still the accepted one. */
function retainedShadowMaterialCurrent(
  c: _InternalRenderPipelineContext,
  retained: RetainedShadowMaterial | undefined,
  projection: GpuDrivenShadowBatchProjection,
  recording: ShadowBatchRecording,
): boolean {
  if (retained === undefined) return true;
  const entry = retained.entry;
  let current = recording.validatedMaterials.get(entry);
  if (current === undefined) {
    // Each invocation still queries the current artifact, schema and layout
    // once per shared binding, exactly as a recorded row would.
    const group = queryShadowMaterialGroup(c, projection, recording);
    current =
      group === entry.bindGroup &&
      entry.material === projection.material &&
      c.materialBgAssemblyCache.get(
        retained.handle === undefined ? undefined : c.world.identity,
        retained.handle,
        retained.shader,
      ) === entry &&
      entry.materialBuffer === c.pipelineState.materialUniformBuffer.buffer &&
      entry.sceneMaterialBuffer === c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer &&
      materialBindingResourcesCurrent(entry, c.world, c.store, c.runtime, projection.material);
    recording.validatedMaterials.set(entry, current);
    if (!current) recording.rejected = { projection, group };
  }
  return current;
}

/** A replayed row is the previous batch; adjacent rows may share its validated binding. */
function adoptRetainedShadowRow(
  c: _InternalRenderPipelineContext,
  recording: ShadowBatchRecording,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  row: RetainedShadowBundleRow,
): void {
  recording.batch = batch;
  recording.projection = projection;
  recording.pipeline = row.pipeline;
  if (row.material === undefined) return;
  recording.material = row.material.entry;
  recording.retainedMaterial = row.material;
  recording.materialPipelineState = c.pipelineState;
  recording.materialFallback = c.pipelineState.skylightFallback;
}

function addShadowBundleWorkload(
  workload: ShadowBundleWorkload | undefined,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
): void {
  if (workload === undefined) return;
  if (batch.key.drawKind === 'indexed') {
    workload.indexedIndirect += projection.visibleBindGroups.length;
  } else {
    workload.indirect += projection.visibleBindGroups.length;
  }
}

// Artifact and geometry owners already publish immutable shader/layout
// facts. Adjacent batches may differ only in resources or draw ranges;
// keep their PSO locally without building another serialized request key.
// The view kind and device capabilities are fixed for this invocation.
function sharesAdjacentShadowPipeline(
  previousProjection: GpuDrivenShadowBatchProjection | undefined,
  previousBatch: GpuDrivenBatch | undefined,
  projection: GpuDrivenShadowBatchProjection,
  batch: GpuDrivenBatch,
): boolean {
  if (previousProjection === undefined || previousBatch === undefined) return false;
  return (
    previousProjection.shadowArtifact === projection.shadowArtifact &&
    previousProjection.shadowRenderState === projection.shadowRenderState &&
    previousProjection.shadowVertexEntry === projection.shadowVertexEntry &&
    previousProjection.shadowFragmentEntry === projection.shadowFragmentEntry &&
    previousProjection.deformation === projection.deformation &&
    previousProjection.vertexColorAvailable === projection.vertexColorAvailable &&
    previousProjection.material.standardTextureMask === projection.material.standardTextureMask &&
    previousProjection.mesh.layoutProjection === projection.mesh.layoutProjection &&
    previousBatch.key.admission === batch.key.admission &&
    previousBatch.key.topology === batch.key.topology &&
    previousBatch.key.drawKind === batch.key.drawKind &&
    (batch.key.drawKind !== 'indexed' ||
      previousProjection.mesh.indexFormat === projection.mesh.indexFormat)
  );
}

// The stock Renderer graph captures shader/layout owners before recording.
// Raw and custom calls retain every accessor and factory observation.
function shadowBatchPipeline(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  validatedPipeline: RenderPipeline | undefined,
  reuseAdjacentShadow: boolean,
  recording: ShadowBatchRecording,
): RenderPipeline {
  // A retained row's validated pipeline is already this row's PSO observation.
  if (validatedPipeline !== undefined) return validatedPipeline;
  const pipeline =
    reuseAdjacentShadow &&
    sharesAdjacentShadowPipeline(recording.projection, recording.batch, projection, batch)
      ? recording.pipeline
      : requestGpuDrivenShadowPipeline(
          c,
          c.runtime.getMaterialShaderPipeline,
          projection,
          batch,
          identity.kind === 'point',
        );
  if (pipeline === null || pipeline === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: `GPU-driven shadow pipeline variant for batch ${batch.batchId}`,
      hint: 'publish the exact scene-index shadow variant before entering the capable lane',
    });
  }
  return pipeline;
}

/** Custom programs, alpha-masked and displaced casters bind their own material group. */
function shadowBatchOwnsMaterial(
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
): boolean {
  return (
    projection.shadowArtifact.material !== SHADOW_CASTER_SHADER_ID ||
    batch.key.admission === 'alpha-mask' ||
    projection.material.authoredTextureFields?.has('displacementTexture') === true
  );
}

function ownedShadowMaterialGroup(
  c: _InternalRenderPipelineContext,
  projection: GpuDrivenShadowBatchProjection,
): BindGroup | null {
  return projection.shadowArtifact.material !== SHADOW_CASTER_SHADER_ID
    ? ensureGpuDrivenCustomShadowMaterialBg(c, projection)
    : ensureGpuDrivenAlphaMaskMaterialBg(c, projection);
}

/** The previous batch's accepted material entry, when it still binds this batch's resources. */
function currentAdjacentShadowMaterial(
  c: _InternalRenderPipelineContext,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  recording: ShadowBatchRecording,
): MaterialBgAssemblyCacheEntry | undefined {
  const previous = recording.material;
  const previousProjection = recording.projection;
  if (
    previous === undefined ||
    previousProjection?.material !== projection.material ||
    previousProjection.shadowArtifact !== projection.shadowArtifact ||
    recording.batch?.key.admission !== batch.key.admission ||
    !materialBindingResourcesCurrent(previous, c.world, c.store, c.runtime, projection.material)
  ) {
    return undefined;
  }
  return recording.materialPipelineState === c.pipelineState &&
    recording.materialFallback === c.pipelineState.skylightFallback &&
    previous.materialBuffer === c.pipelineState.materialUniformBuffer.buffer &&
    previous.sceneMaterialBuffer === c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer
    ? previous
    : undefined;
}

// The builder can return a fallback after a failed asset upload. Only
// its accepted cache entry proves complete residency; retry incomplete
// bindings on the next batch without keeping a second readiness flag.
function acceptedShadowMaterial(
  c: _InternalRenderPipelineContext,
  projection: GpuDrivenShadowBatchProjection,
  handle: number | undefined,
  shader: string | undefined,
  materialGroup: BindGroup | null,
): MaterialBgAssemblyCacheEntry | undefined {
  const worldIdentity = handle === undefined ? undefined : c.world.identity;
  const accepted = c.materialBgAssemblyCache.get(worldIdentity, handle, shader);
  return accepted?.bindGroup === materialGroup &&
    accepted.material === projection.material &&
    materialBindingResourcesCurrent(accepted, c.world, c.store, c.runtime, projection.material)
    ? accepted
    : undefined;
}

// These immutable material/program facts select the same group for
// adjacent batches. Keep the successful result only for this invocation;
// later invocations still query the current artifact, schema and layout.
// Logical texture sources can resolve a new physical view without a
// material replacement, so they always visit the resource owner.
function adjacentShadowMaterialGroup(
  c: _InternalRenderPipelineContext,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  recording: ShadowBatchRecording,
): BindGroup | null {
  const staticSources =
    (projection.material.textureSources?.size ?? 0) === 0 &&
    (projection.material.videoTextureFields?.size ?? 0) === 0;
  const current = staticSources
    ? currentAdjacentShadowMaterial(c, batch, projection, recording)
    : undefined;
  if (current !== undefined) return current.bindGroup;
  const materialGroup = queryShadowMaterialGroup(c, projection, recording);
  const handle = staticSources ? projection.material.materialHandle : undefined;
  const shader = shadowMaterialCacheShader(projection, staticSources);
  const accepted = acceptedShadowMaterial(c, projection, handle, shader, materialGroup);
  recording.material = accepted;
  recording.materialPipelineState = c.pipelineState;
  recording.materialFallback = c.pipelineState.skylightFallback;
  recording.retainedMaterial =
    accepted === undefined || handle === undefined
      ? undefined
      : { entry: accepted, handle, shader };
  return materialGroup;
}

/** The shader component of a static shadow material's assembly cache key. */
function shadowMaterialCacheShader(
  projection: GpuDrivenShadowBatchProjection,
  staticSources: boolean,
): string | undefined {
  if (!staticSources) return undefined;
  const shadowArtifact = projection.shadowArtifact;
  return shadowArtifact.material !== SHADOW_CASTER_SHADER_ID
    ? (shadowArtifact.specializationKey ?? shadowArtifact.material)
    : 'forgeax::default-standard-pbr';
}

function shadowBatchMaterialGroup(
  c: _InternalRenderPipelineContext,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  ownsMaterial: boolean,
  reuseAdjacentShadow: boolean,
  recording: ShadowBatchRecording,
): BindGroup {
  let materialGroup: BindGroup | null;
  if (!ownsMaterial) {
    recording.opaqueMaterialGroup ??= ensureSpotShadowMaterialBg(c);
    materialGroup = recording.opaqueMaterialGroup;
  } else if (reuseAdjacentShadow) {
    materialGroup = adjacentShadowMaterialGroup(c, batch, projection, recording);
  } else {
    materialGroup = ownedShadowMaterialGroup(c, projection);
  }
  if (materialGroup === null) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'material resources for every GPU shadow batch',
      hint: 'publish the shadow material binding before recording the indirect batch',
    });
  }
  return materialGroup;
}

function resolveShadowBatchBundle(
  view: GpuDrivenView,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  pipeline: RenderPipeline,
  materialGroup: BindGroup,
  observed: MutablePreparedRasterBindings,
): RenderBundle {
  observed.pipeline = pipeline;
  observed.material = materialGroup;
  observed.mesh = projection.meshBindGroup;
  observed.meshOffsets = projection.deformation === 'skin' ? gpuShadowSkinOffsets(view) : [0];
  observed.vertex = projection.mesh.vertexBuffer.handle;
  if (batch.key.drawKind === 'indexed') {
    const index = projection.mesh.indexBuffer?.handle;
    if (index === undefined) throw new Error('Missing prepared shadow index buffer');
    observed.index = index;
  } else delete observed.index;
  if (batch.key.drawKind === 'indexed' && projection.mesh.indexFormat === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'index format for a prepared shadow raster',
      hint: 'publish the mesh index format before recording the shadow batch',
    });
  observed.indexFormat = projection.mesh.indexFormat ?? 'uint16';
  observed.indirectOffset = batch.indirectOffset;
  observed.indexed = batch.key.drawKind === 'indexed';
  observed.windows = projection.visibleBindGroups;
  return view.resolveShadowBundle(projection.bundles, observed as PreparedRasterBindings);
}

function recordShadowBatchBundle(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  view: GpuDrivenView,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  validatedPipeline: RenderPipeline | undefined,
  reuseAdjacentShadow: boolean,
  recording: ShadowBatchRecording,
  observed: MutablePreparedRasterBindings,
  retainedView: RetainedShadowBundleView | undefined,
): RenderBundle {
  if (projection.shadowArtifact.receipt === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: `published shadow MaterialProgramAbi for batch ${batch.batchId}`,
      hint: 'keep the shadow draw out of the capable lane until its producer receipt is ready',
    });
  }
  const pipeline = shadowBatchPipeline(
    c,
    identity,
    batch,
    projection,
    validatedPipeline,
    reuseAdjacentShadow,
    recording,
  );
  if (batch.key.drawKind === 'indexed' && projection.mesh.indexBuffer === null) {
    throw new RhiError({
      code: 'internal-error',
      expected: `indexed mesh buffer for GPU-driven shadow batch ${batch.batchId}`,
      hint: 'keep the geometry residency and topology draw kind aligned before capable recording',
    });
  }
  const ownsMaterial = shadowBatchOwnsMaterial(batch, projection);
  const materialGroup = shadowBatchMaterialGroup(
    c,
    batch,
    projection,
    ownsMaterial,
    reuseAdjacentShadow,
    recording,
  );
  // Only the adjacent-reuse path resolves a retainable static binding.
  const rowMaterial = reuseAdjacentShadow && ownsMaterial ? recording.retainedMaterial : undefined;
  recording.batch = batch;
  recording.projection = projection;
  recording.pipeline = pipeline;
  const bundle = resolveShadowBatchBundle(
    view,
    batch,
    projection,
    pipeline,
    materialGroup,
    observed,
  );
  retainShadowBundleRow(
    retainedView,
    recording,
    batch,
    projection,
    bundle,
    pipeline,
    materialGroup,
    rowMaterial,
  );
  return bundle;
}

/** Opaque rows and rows with an accepted static material binding replay across frames. */
function retainShadowBundleRow(
  retainedView: RetainedShadowBundleView | undefined,
  recording: ShadowBatchRecording,
  batch: GpuDrivenBatch,
  projection: GpuDrivenShadowBatchProjection,
  bundle: RenderBundle,
  pipeline: RenderPipeline,
  materialGroup: BindGroup,
  rowMaterial: RetainedShadowMaterial | undefined,
): void {
  if (retainedView === undefined) return;
  if (recording.opaqueMaterialGroup != null && materialGroup === recording.opaqueMaterialGroup)
    retainedView.rows.set(batch.batchId, { batch, projection, bundle, pipeline });
  else if (rowMaterial?.entry.bindGroup === materialGroup)
    retainedView.rows.set(batch.batchId, {
      batch,
      projection,
      bundle,
      pipeline,
      material: rowMaterial,
    });
  else retainedView.rows.delete(batch.batchId);
}

/** Retired batch IDs never return with new contents; bound the retained rows. */
function trimRetainedShadowRows(
  retainedView: RetainedShadowBundleView | undefined,
  batches: SubmissionPlan['batches'],
): void {
  if (retainedView === undefined || retainedView.rows.size <= 2 * batches.length) return;
  const live = new Set(batches.map((batch) => batch.batchId));
  for (const batchId of retainedView.rows.keys())
    if (!live.has(batchId)) retainedView.rows.delete(batchId);
}

function prepareGpuDrivenShadowIfPublished(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  viewBindGroup: BindGroup,
  reuseAdjacentShadow = false,
  captureWorkload = false,
): PreparedGpuDrivenShadowSubmission | undefined {
  const viewSubmission = c.gpuDrivenShadowViews?.submission(identity);
  const projections = c.gpuDrivenShadowBatchProjections?.get(shadowViewIdentityKey(identity));
  if (viewSubmission === undefined) {
    return undefined;
  }
  if (projections === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: `GPU-driven shadow projection for ${shadowViewIdentityKey(identity)}`,
      hint: 'terminate the capable shadow frame instead of falling through to CPU caster enumeration',
    });
  }
  const bundles: RenderBundle[] = [];
  const workload = captureWorkload ? { indirect: 0, indexedIndirect: 0 } : undefined;
  const indirect = viewSubmission.view.indirectBuffer;
  const observed: MutablePreparedRasterBindings = { view: viewBindGroup, materialOffset: 0 };
  if (indirect !== undefined) observed.indirect = indirect;
  // These physical inputs are fixed for the recording invocation. Resolve
  // the default opaque binding once, only if an opaque batch needs it.
  const recording: ShadowBatchRecording = {
    batch: undefined,
    projection: undefined,
    pipeline: undefined,
    material: undefined,
    retainedMaterial: undefined,
    materialPipelineState: undefined,
    materialFallback: undefined,
    opaqueMaterialGroup: undefined,
    validatedMaterials: new Map(),
    rejected: undefined,
  };
  const retainedView = retainedShadowBundleView(
    c,
    identity,
    viewBindGroup,
    viewSubmission.view,
    reuseAdjacentShadow,
  );
  const validatedPipelines = new Map<RenderPipeline, boolean>();
  const replayed =
    indirect === undefined
      ? undefined
      : replayShadowView(
          c,
          identity,
          retainedView,
          viewSubmission.plan,
          projections,
          recording,
          validatedPipelines,
        );
  if (replayed !== undefined)
    return {
      view: viewSubmission.view,
      bundles: replayed.bundles,
      ...(workload === undefined ? {} : { workload: { ...replayed.workload } }),
    };
  const collector: ShadowReplayCollector = {
    replayable: retainedView !== undefined,
    pipelines: new Map(),
    materials: new Map(),
    workload: { indirect: 0, indexedIndirect: 0 },
  };
  for (const batch of viewSubmission.plan.batches) {
    if (batch.visibleCapacity === 0) continue;
    const projection = requireShadowBatchProjection(projections, batch);
    const retainedRow = retainedView?.rows.get(batch.batchId);
    const validatedPipeline = retainedShadowPipeline(
      c,
      identity,
      retainedRow,
      batch,
      projection,
      validatedPipelines,
    );
    if (
      validatedPipeline !== undefined &&
      retainedRow !== undefined &&
      retainedShadowMaterialCurrent(c, retainedRow.material, projection, recording)
    ) {
      adoptRetainedShadowRow(c, recording, batch, projection, retainedRow);
      bundles.push(retainedRow.bundle);
      collectShadowReplayRow(collector, retainedRow);
    } else {
      const bundle = recordShadowBatchBundle(
        c,
        identity,
        viewSubmission.view,
        batch,
        projection,
        validatedPipeline,
        reuseAdjacentShadow,
        recording,
        observed,
        retainedView,
      );
      bundles.push(bundle);
      const retained = retainedView?.rows.get(batch.batchId);
      collectShadowReplayRow(collector, retained?.bundle === bundle ? retained : undefined);
    }
    addShadowBundleWorkload(workload, batch, projection);
  }
  trimRetainedShadowRows(retainedView, viewSubmission.plan.batches);
  if (collector.replayable && retainedView !== undefined && indirect !== undefined)
    retainedView.replay = {
      plan: new WeakRef(viewSubmission.plan),
      projections: new WeakRef(projections),
      bundles,
      pipelines: collector.pipelines,
      materials: collector.materials,
      workload: collector.workload,
    };
  if (indirect === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'GPU-driven shadow view indirect buffer',
      hint: 'publish a prepared view generation before recording a capable shadow pass',
    });
  return {
    view: viewSubmission.view,
    bundles,
    ...(workload === undefined ? {} : { workload }),
  };
}

function recordGpuDrivenShadowIfPublished(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  identity: ShadowViewIdentity,
  viewBindGroup: BindGroup,
  opaqueMaterialGroup: BindGroup,
  reuseAdjacentShadow = false,
): GpuDrivenShadowRecordResult | undefined {
  const submission = prepareGpuDrivenShadowIfPublished(
    c,
    identity,
    viewBindGroup,
    reuseAdjacentShadow,
    capturesShadowBundleWorkload(pass),
  );
  if (submission === undefined) return undefined;
  if (submission.bundles.length > 0) {
    submission.view.recordShadow(pass, submission.bundles);
    recordShadowBundleWorkload(pass, submission.workload);
  }
  // executeBundles resets imperative state; the residual lane still consumes
  // this view and the caller's ordinary opaque material binding.
  pass.setBindGroup(0, viewBindGroup, [0, 0]);
  pass.setBindGroup(1, opaqueMaterialGroup, [0]);
  const current = c.gpuDrivenShadowViews?.submission(identity);
  if (current === undefined) return undefined;
  const selections = [current.selection];
  const complete = true;
  if (identity.layer === undefined) {
    const staticIdentity: ShadowViewIdentity = { ...identity, layer: 'static' };
    const retained = c.gpuDrivenShadowViews?.submission(staticIdentity);
    if (
      retained !== undefined &&
      (retained.cache === 'hit' ||
        recordedStaticViews.get(c)?.get(shadowViewIdentityKey(staticIdentity)) ===
          retained.generation)
    )
      selections.push(retained.selection);
    else if (retained !== undefined) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'submitted static shadow depth for the current view generation',
        hint: 'record its static layer before composing the final shadow view',
      });
    }
  }
  return { selections, complete };
}

/** A full-target triangle at reverse-Z far depth: a depth clear a scissor can bound. */
const DEPTH_CLEAR_WGSL = `@vertex
fn depth_clear_vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const depthClearPipelines = new WeakMap<RhiDevice, RenderPipeline>();

function depthClearPipeline(c: _InternalRenderPipelineContext): RenderPipeline {
  const device = c.runtime.device;
  const cached = depthClearPipelines.get(device);
  if (cached !== undefined) return cached;
  const factory = c.runtime.immediateShaderModuleFactory ?? c.runtime.shaderModuleFactory;
  if (factory === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'a shader module factory for the static shadow depth clear',
      hint: 'assemble the renderer with a shader module factory',
    });
  }
  const module = factory.createShaderModule({
    code: DEPTH_CLEAR_WGSL,
    label: 'shadow-static-depth-clear',
  });
  if (!module.ok) throw module.error;
  const layout = device.createPipelineLayout({
    label: 'shadow-static-depth-clear.layout',
    bindGroupLayouts: [],
  });
  if (!layout.ok) throw layout.error;
  const created = device.createRenderPipeline({
    label: 'shadow-static-depth-clear',
    layout: layout.value,
    vertex: { module: module.value, entryPoint: 'depth_clear_vs', buffers: [] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  });
  if (!created.ok) throw created.error;
  depthClearPipelines.set(device, created.value);
  return created.value;
}

/** The texel scissor of a normalized rect on a square target; undefined when empty. */
export function shadowDirtyScissor(
  rect: ShadowDirtyRect,
  size: number,
): readonly [number, number, number, number] | undefined {
  const x = Math.max(0, Math.floor(rect.x0 * size));
  const y = Math.max(0, Math.floor(rect.y0 * size));
  const width = Math.min(size, Math.ceil(rect.x1 * size)) - x;
  const height = Math.min(size, Math.ceil(rect.y1 * size)) - y;
  return width > 0 && height > 0 ? [x, y, width, height] : undefined;
}

/**
 * Rasters only the GPU-driven static caster layer of a shadow view. The final
 * pass copies this layer and adds dynamic and residual casters. With `dirty`,
 * the pass loads the retained layer and, per region, clears depth under a
 * scissor and re-rasters the static casters there.
 */
export function encodeStaticShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  identity: ShadowViewIdentity,
  dirty?: { readonly rects: readonly ShadowDirtyRect[]; readonly size: number },
  reuseAdjacentShadow = false,
): void {
  const staticIdentity: ShadowViewIdentity = { ...identity, layer: 'static' };
  if (c.gpuDrivenShadowViews?.submission(staticIdentity) === undefined) return;
  let viewBg: BindGroup | null;
  if (identity.kind === 'directional') {
    viewBg = ensureTypedShadowViewBg(
      c,
      0,
      directionalShadowCasterOffset(identity.index),
      `view-shadow-directional-${identity.index}`,
    );
  } else if (identity.kind === 'point') {
    const snapshot = c.frameState.pointShadowSnapshots[identity.index];
    const face = identity.face;
    if (snapshot === undefined || face === undefined) return;
    viewBg = ensureTypedShadowViewBg(
      c,
      pointShadowViewOffset(snapshot.shadowAtlasLayer, face),
      0,
      `view-shadow-point-${snapshot.shadowAtlasLayer}-${face}`,
    );
  } else {
    const snapshot = c.frameState.spotShadowSnapshots.filter(
      (candidate) => candidate.shadowAtlasTile >= 0 && candidate.lightViewProj !== undefined,
    )[identity.index];
    if (snapshot === undefined) return;
    viewBg = ensureTypedShadowViewBg(
      c,
      0,
      spotShadowCasterOffset(snapshot.shadowAtlasTile),
      `view-shadow-spot-${snapshot.shadowAtlasTile}`,
    );
  }
  const materialBg = viewBg === null ? null : ensureSpotShadowMaterialBg(c);
  if (viewBg === null || materialBg === null) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'static layer ShadowCaster bind groups',
      hint: 'publish the view/material resources before recording the shadow lane',
    });
  }
  if (dirty === undefined) {
    pass.setBindGroup(0, viewBg, [0, 0]);
    pass.setBindGroup(1, materialBg, [0]);
    recordGpuDrivenShadowIfPublished(
      c,
      pass,
      staticIdentity,
      viewBg,
      materialBg,
      reuseAdjacentShadow,
    );
    markStaticShadowRecorded(c, staticIdentity);
    return;
  }
  const clear = depthClearPipeline(c);
  // Scissors change coverage, not caster bindings. Prepare lazily for the
  // first nonempty region and keep the reuse inside this recording invocation.
  let submission: PreparedGpuDrivenShadowSubmission | undefined;
  for (const rect of dirty.rects) {
    const scissor = shadowDirtyScissor(rect, dirty.size);
    if (scissor === undefined) continue;
    pass.setScissorRect(...scissor);
    pass.setPipeline(clear);
    pass.draw(3, 1, 0, 0);
    pass.setBindGroup(0, viewBg, [0, 0]);
    pass.setBindGroup(1, materialBg, [0]);
    submission ??= prepareGpuDrivenShadowIfPublished(
      c,
      staticIdentity,
      viewBg,
      reuseAdjacentShadow,
      capturesShadowBundleWorkload(pass),
    );
    if (submission !== undefined) {
      submission.view.recordShadow(pass, submission.bundles);
      recordShadowBundleWorkload(pass, submission.workload);
    }
  }
  // An empty proved region set preserves the retained depth for this selection.
  // Reaching here also proves every nonempty region completed its raster.
  markStaticShadowRecorded(c, staticIdentity);
}

export function encodeDirectionalShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  cascadeIndex: number,
  drawFeatures?: (view: BindGroup) => void,
  terrainReceiver?: import('../terrain/shadow-family').TerrainShadowReceiver,
  reuseAdjacentShadow = false,
): void {
  const directionalIdentity = { kind: 'directional' as const, index: cascadeIndex };
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    0,
    directionalShadowCasterOffset(cascadeIndex),
    `view-shadow-directional-${cascadeIndex}`,
  );
  const materialBg = viewBg === null ? null : ensureSpotShadowMaterialBg(c);
  const capable = c.gpuDrivenShadowViews?.submission(directionalIdentity) !== undefined;
  if (viewBg === null || materialBg === null) {
    c.frameState.directionalShadowCacheRecorded = false;
    if (capable || hasExpectedShadowCasters(c)) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'directional ShadowCaster bind groups',
        hint: 'publish the view/material resources before recording the shadow lane',
      });
    }
    return;
  }
  c.frameState.directionalShadowCacheRecorded = true;
  recordAdmittedShadowView(
    c,
    pass,
    directionalIdentity,
    pipeline,
    viewBg,
    materialBg,
    capable,
    drawFeatures,
    reuseAdjacentShadow,
    terrainReceiver,
  );
}

export function encodePointShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  snapshotIndex: number,
  face: number,
  drawFeatures?: (view: BindGroup) => void,
  reuseAdjacentShadow = false,
): void {
  const snapshot = c.frameState.pointShadowSnapshots[snapshotIndex];
  if (snapshot === undefined) return;
  const pipeline = shadowPipeline(c, true);
  const viewBg = ensureTypedShadowViewBg(
    c,
    pointShadowViewOffset(snapshot.shadowAtlasLayer, face),
    0,
    `view-shadow-point-${snapshot.shadowAtlasLayer}-${face}`,
  );
  const materialBg = viewBg === null ? null : ensureSpotShadowMaterialBg(c);
  const pointIdentity = { kind: 'point' as const, index: snapshotIndex, face };
  const capable = c.gpuDrivenShadowViews?.submission(pointIdentity) !== undefined;
  if (viewBg === null || materialBg === null) {
    if (capable || hasExpectedShadowCasters(c))
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'point ShadowCaster bind groups',
        hint: 'publish the view/material resources before recording the shadow lane',
      });
    return;
  }
  if (pipeline === null && !capable && !hasExpectedShadowCasters(c) && drawFeatures === undefined)
    return;
  recordAdmittedShadowView(
    c,
    pass,
    pointIdentity,
    pipeline,
    viewBg,
    materialBg,
    capable,
    drawFeatures,
    reuseAdjacentShadow,
  );
}

export function encodeSpotShadowPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  snapshotIndex: number,
  drawFeatures?: (view: BindGroup) => void,
  reuseAdjacentShadow = false,
): void {
  const snapshot = c.frameState.spotShadowSnapshots.filter(
    (candidate) => candidate.shadowAtlasTile >= 0 && candidate.lightViewProj !== undefined,
  )[snapshotIndex];
  if (
    snapshot === undefined ||
    snapshot.shadowAtlasTile < 0 ||
    snapshot.lightViewProj === undefined
  ) {
    return;
  }
  const pipeline = shadowPipeline(c);
  const viewBg = ensureTypedShadowViewBg(
    c,
    0,
    spotShadowCasterOffset(snapshot.shadowAtlasTile),
    `view-shadow-spot-${snapshot.shadowAtlasTile}`,
  );
  const materialBg = viewBg === null ? null : ensureSpotShadowMaterialBg(c);
  const spotIdentity = { kind: 'spot' as const, index: snapshotIndex };
  const capable = c.gpuDrivenShadowViews?.submission(spotIdentity) !== undefined;
  if (viewBg === null || materialBg === null) {
    if (capable || hasExpectedShadowCasters(c))
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'spot ShadowCaster bind groups',
        hint: 'publish the view/material resources before recording the shadow lane',
      });
    return;
  }
  if (pipeline === null && !capable && !hasExpectedShadowCasters(c) && drawFeatures === undefined)
    return;
  recordAdmittedShadowView(
    c,
    pass,
    spotIdentity,
    pipeline,
    viewBg,
    materialBg,
    capable,
    drawFeatures,
    reuseAdjacentShadow,
  );
}

/** Record the GPU lane and any remaining direct casters for an admitted light view. */
function recordAdmittedShadowView(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  identity: ShadowViewIdentity,
  pipeline: RenderPipeline | null,
  viewBg: BindGroup,
  materialBg: BindGroup,
  capable: boolean,
  drawFeatures: ((view: BindGroup) => void) | undefined,
  reuseAdjacentShadow: boolean,
  terrainReceiver?: import('../terrain/shadow-family').TerrainShadowReceiver,
): void {
  const viewport = c.shadowUpdatePolicy?.(identity)?.viewport;
  if (viewport !== undefined) {
    pass.setViewport(0, 0, viewport[0], viewport[1], 0, 1);
    pass.setScissorRect(0, 0, viewport[0], viewport[1]);
  }
  drawFeatures?.(viewBg);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  const gpuRecord = recordGpuDrivenShadowIfPublished(
    c,
    pass,
    identity,
    viewBg,
    materialBg,
    reuseAdjacentShadow,
  );
  if (capable && gpuRecord === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'the prepared GPU shadow view',
      hint: 'retain its resources through shadow recording',
    });
  if (c.shadowDirectRequired === false && gpuRecord?.complete) return;
  recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    c.meshBindGroup,
    gpuRecord?.selections,
    identity.kind === 'point',
    c.shadowViewPlanesByView?.get(shadowViewIdentityKey(identity)),
    identity.kind === 'directional' && c.capsuleShadowDirectional === true,
    terrainReceiver,
    c.shadowUpdatePolicy?.(identity)?.channels,
  );
}

/**
 * feat-20260609 M2: filter dispatch entries by a {@link PassSelector}.
 *
 * Each dispatch entry carries `tags` (a free key-value map) sourced from the
 * material's per-pass tags.  The selector is matched entry-by-entry via
 * {@link matchPass}; entries whose tags satisfy the selector are returned.
 * An empty selector returns the input array unchanged (match-all semantics).
 *
 * @param dispatch Per-frame dispatch entries (from the extract stage).
 * @param selector Pipeline-specific pass selector (e.g. `{ LightMode: ['Forward'] }`).
 * @returns Dispatch entries whose tags match the selector.
 */
export function filterDispatchBySelector(
  dispatch: DispatchList,
  selector: PassSelector,
): DispatchList {
  if (Object.keys(selector).length === 0) return dispatch;
  return dispatch.filter((e) => matchPass(e.tags, selector));
}

/**
 * Build the material handles whose dispatch entries match a graph pass.
 *
 * A renderable can own more than one material pass, so renderable-level
 * filtering is insufficient for geometry recording: a Deferred graph pass
 * must not draw the same renderable's Forward-only material.  Keep the
 * renderable key in the result so mixed-material meshes retain their
 * per-submesh routing. An optional exclusion selector removes a material
 * handle when that same renderable/material pair also contributes to another
 * graph lane (for example Deferred Standard geometry after SSR composition).
 */
export function buildMatchedMaterialHandlesByRenderable(
  dispatch: DispatchList,
  selector: PassSelector,
  excludeSelector?: PassSelector,
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (dispatch.length === 0) return null;
  const handlesByRenderable = new Map<number, Set<number> | SingleMaterialHandleSet>();
  // Pure singleton values are shared only within this selection invocation.
  const singletons = new FirstEntryMap<number, SingleMaterialHandleSet>();
  const singleton = (handle: number) => {
    let value = singletons.get(handle);
    if (value === undefined) {
      value = new SingleMaterialHandleSet(handle);
      singletons.set(handle, value);
    }
    return value;
  };
  for (const entry of dispatch) {
    if (!matchPass(entry.tags, selector)) continue;
    const index = entry.renderableIndex;
    const handles = handlesByRenderable.get(index);
    if (handles === undefined)
      handlesByRenderable.set(entry.renderableIndex, singleton(entry.materialHandle));
    else if (handles instanceof SingleMaterialHandleSet) {
      const handle = entry.materialHandle;
      if (!handles.has(handle))
        handlesByRenderable.set(index, new Set([handles.onlyHandle, handle]));
    } else handles.add(entry.materialHandle);
  }
  if (excludeSelector !== undefined)
    for (const entry of dispatch) {
      if (!matchPass(entry.tags, excludeSelector)) continue;
      const handles = handlesByRenderable.get(entry.renderableIndex);
      if (handles === undefined) continue;
      if (handles instanceof SingleMaterialHandleSet) {
        if (handles.has(entry.materialHandle)) handlesByRenderable.delete(entry.renderableIndex);
      } else {
        handles.delete(entry.materialHandle);
        if (handles.size === 0) handlesByRenderable.delete(entry.renderableIndex);
      }
    }
  return handlesByRenderable;
}

/** The request is shared by hidden preparation and the real ShadowCaster draw. */
function resolveShadowMaterialPipeline(
  c: _InternalRenderPipelineContext,
  entry: ValidatedRenderable,
  topology: import('@forgeax/engine-types').PrimitiveTopology,
  submeshMaterial: MaterialSnapshot,
  shadowDispatch: MaterialDispatchPass,
  reflected: boolean,
  receiver: boolean,
  preparation = false,
): MaterialShaderPipelineEntry | null {
  const entryShadowShaderId = shadowDispatch.materialShaderId;
  const entryShadowRenderState = reflectedRenderState(
    receiver ? { ...shadowDispatch.renderState, cullMode: 'front' } : shadowDispatch.renderState,
    reflected !== isReflectedTransform(entry.source.transform.world),
  );
  const skinned = entry.source.skinBinding !== undefined;
  return (
    (preparation
      ? (c.runtime.prepareMaterialShaderPipelineEntry ?? c.runtime.getMaterialShaderPipelineEntry)
      : c.runtime.getMaterialShaderPipelineEntry)?.(
      entryShadowShaderId,
      false,
      entryShadowRenderState,
      topology,
      entry.mesh.indexFormat,
      shadowCasterVariantSet(
        c.runtime.device.caps.storageBuffer,
        skinned,
        false,
        Number(submeshMaterial.paramSnapshot?.alphaCutoff ?? 0) > 0 ||
          Number(submeshMaterial.paramSnapshot?.alphaHash ?? 0) > 0.5,
        entry.mesh.layoutProjection.attributes.some((attribute) => attribute.key === 'color'),
      ),
      'shadow-caster',
      undefined, // meshAttributes
      1, // sampleCount
      undefined,
      undefined,
      undefined,
      undefined,
      entry.mesh.layoutProjection,
      // Built-in variants reuse validated prewarm modules, including
      // adapters with no synchronous shader factory. Authored residual
      // programs use their synchronous manifest producer at first draw.
      preparation || entryShadowShaderId === SHADOW_CASTER_SHADER_ID ? 'validated' : 'immediate',
      entryShadowShaderId === SHADOW_CASTER_SHADER_ID ? (skinned ? 'pbr-skin' : 'pbr') : undefined,
      undefined, // vertexEntryPoint
      undefined, // additionalColorFormats
      shadowDispatch.vertexEntry,
      shadowDispatch.fragmentEntry,
      undefined,
      submeshMaterial.standardTextureMask === undefined
        ? undefined
        : { [STANDARD_TEXTURE_MASK_OVERRIDE]: submeshMaterial.standardTextureMask },
    ) ?? null
  );
}

/** Requests real PSOs only; it never encodes or changes visibility. */
export function prepareShadowMaterialPipelines(
  c: _InternalRenderPipelineContext,
  rendererRecording = false,
  requiredView?: (
    frame: import('../render-pipeline').RenderPipelineFrame,
    identity: ShadowViewIdentity,
  ) => boolean,
): void {
  // Cascades publish the same scene batch addresses with different culling
  // windows. Their PSO does not contain those windows. Keep successful exact
  // requests only within this owned recording; pending and raw calls still
  // visit the native owner, and the next frame starts with an empty roster.
  const preparedBatches = rendererRecording
    ? new Map<
        number,
        {
          projection: ShadowPipelineProjection;
          key: GpuDrivenBatch['key'];
          reflected: boolean;
        }
      >()
    : undefined;
  let preparedHiddenDraws: Map<ValidatedRenderable, Set<number>> | undefined;
  // Only actual declared shadow view kinds participate. Hidden rows stay outside
  // the scene/culling lists, but their accepted receipt owns the future native PSO.
  const views = c.gpuDrivenShadowViews?.inspect() ?? [];
  // The light projection roster exists before the first visible GPU batch.
  // Hidden candidates must consume these exact planned views as well: using
  // only submitted GPU views would miss a new caster's first shadow PSO.
  const reflections =
    c.shadowViewPlanesByView === undefined
      ? new Set(views.map((view) => view.identity.kind === 'point'))
      : new Set([...c.shadowViewPlanesByView.keys()].map((key) => key.startsWith('point:')));
  for (const view of c.runtime.prepareMaterialShaderPipeline === undefined ? [] : views) {
    // The same compiled graph proves retained depth will bypass this raster.
    // Explicit hidden preparation below remains independent of view reuse.
    if (rendererRecording && requiredView?.(c, view.identity) === false) continue;
    const projections = c.gpuDrivenShadowBatchProjections?.get(
      shadowViewIdentityKey(view.identity),
    );
    const submission = c.gpuDrivenShadowViews?.submission(view.identity);
    for (const batch of submission?.plan.batches ?? []) {
      const projection = projections?.get(batch.batchId);
      if (projection === undefined) continue;
      const reflected = view.identity.kind === 'point';
      const previous = preparedBatches?.get(batch.batchId);
      if (
        previous !== undefined &&
        previous.reflected === reflected &&
        previous.projection.shadowArtifact === projection.shadowArtifact &&
        previous.projection.shadowRenderState === projection.shadowRenderState &&
        previous.projection.shadowVertexEntry === projection.shadowVertexEntry &&
        previous.projection.shadowFragmentEntry === projection.shadowFragmentEntry &&
        previous.projection.deformation === projection.deformation &&
        previous.projection.vertexColorAvailable === projection.vertexColorAvailable &&
        previous.projection.material.standardTextureMask ===
          projection.material.standardTextureMask &&
        previous.projection.mesh.layoutProjection === projection.mesh.layoutProjection &&
        previous.key.admission === batch.key.admission &&
        previous.key.topology === batch.key.topology &&
        previous.key.drawKind === batch.key.drawKind &&
        (batch.key.drawKind !== 'indexed' ||
          previous.projection.mesh.indexFormat === projection.mesh.indexFormat)
      )
        continue;
      if (
        requestGpuDrivenShadowPipeline(
          c,
          c.runtime.prepareMaterialShaderPipeline,
          projection,
          batch,
          reflected,
        ) == null
      ) {
        markPipelinePreparationPending(c.frameState, {
          code: 'shadow-pipeline-preparation',
          pass: 'shadow',
          shader: projection.shadowArtifact.material.slice(0, 256),
        });
      } else {
        preparedBatches?.set(batch.batchId, { projection, key: batch.key, reflected });
      }
    }
  }
  if (
    c.runtime.prepareMaterialShaderPipeline !== undefined &&
    c.gpuDrivenGeometryLane !== 'direct' &&
    reflections.size > 0
  ) {
    for (const entry of c.pipelinePreparationEntries ?? []) {
      if (entry.source.authorVisible !== false) continue;
      for (const { draw, execution } of prepareHiddenMaterialExecutions(
        entry,
        c.materialFrame,
        'shadow',
        c.runtime.getMaterialShaderArtifact,
      )) {
        if (execution.route !== 'gpu') continue;
        const { prepared, material, artifact } = execution;
        const passes = [execution.pass];
        for (const pass of passes) {
          if (artifact === undefined) {
            markPipelinePreparationPending(c.frameState, {
              code: 'shadow-pipeline-preparation',
              worldId: entry.source.worldId,
              entity: entry.source.entityKey,
              pass: 'shadow',
              ...(pass.shaderId === undefined ? {} : { shader: pass.shaderId.slice(0, 256) }),
            });
            continue;
          }
          preparedHiddenDraws ??= new Map();
          let selected = preparedHiddenDraws.get(entry);
          if (selected === undefined) {
            selected = new Set();
            preparedHiddenDraws.set(entry, selected);
          }
          selected.add(draw.sourceDrawIndex);
          const shadowRenderState = transformRenderState(
            pass.renderState,
            entry.source.transform.world,
          );
          for (const reflected of reflections) {
            if (
              requestGpuDrivenShadowPipeline(
                c,
                c.runtime.prepareMaterialShaderPipeline,
                {
                  mesh: entry.mesh,
                  deformation: prepared.identity.deformation,
                  shadowArtifact: artifact,
                  material,
                  vertexColorAvailable: entry.mesh.layoutProjection.attributes.some(
                    (a) => a.key === 'color',
                  ),
                  ...(shadowRenderState === undefined ? {} : { shadowRenderState }),
                  ...(pass.vertexEntry === undefined
                    ? {}
                    : { shadowVertexEntry: pass.vertexEntry }),
                  ...(pass.fragmentEntry === undefined
                    ? {}
                    : { shadowFragmentEntry: pass.fragmentEntry }),
                },
                { key: draw.key },
                reflected,
              ) == null
            )
              markPipelinePreparationPending(c.frameState, {
                code: 'shadow-pipeline-preparation',
                worldId: entry.source.worldId,
                entity: entry.source.entityKey,
                pass: 'shadow',
                ...(pass.shaderId === undefined ? {} : { shader: pass.shaderId.slice(0, 256) }),
              });
          }
        }
      }
    }
  }
  for (const entry of c.pipelinePreparationEntries ?? []) {
    for (const [submeshIndex, sm] of entry.mesh.submeshes.entries()) {
      if (preparedHiddenDraws?.get(entry)?.has(submeshIndex)) continue;
      const accepted = shadowMaterial(c, entry.source, sm.materialSlot);
      const material = accepted.snapshot;
      for (const authored of accepted.passes) {
        if (authored.tags.LightMode !== 'ShadowCaster') continue;
        const pass =
          authored.materialShaderId === 'forgeax::default-standard-pbr'
            ? { ...authored, materialShaderId: SHADOW_CASTER_SHADER_ID }
            : authored;
        for (const reflected of reflections.size === 0 ? [false] : reflections) {
          if (
            resolveShadowMaterialPipeline(
              c,
              entry,
              sm.topology,
              material,
              pass,
              reflected,
              false,
              true,
            ) === null
          )
            markPipelinePreparationPending(c.frameState, {
              code: 'shadow-pipeline-preparation',
              worldId: entry.source.worldId,
              entity: entry.source.entityKey,
              pass: 'shadow',
              ...(pass.materialShaderId === undefined
                ? {}
                : { shader: pass.materialShaderId.slice(0, 256) }),
            });
        }
      }
    }
  }
}

export function recordShadowCasterDraws(
  c: _InternalRenderPipelineContext,
  shadowPass: RhiRenderPassEncoder,
  shadowPipeline: RenderPipeline | null,
  shadowMeshBindGroup: BindGroup | null,
  gpuSelections: readonly GpuDrawSelection[] | undefined,
  reflected = false,
  viewPlanes?: Float32Array,
  skipCapsuleReady = false,
  terrainReceiver?: import('../terrain/shadow-family').TerrainShadowReceiver,
  casterChannels = 0xffffffff,
): void {
  const {
    runtime,
    pipelineState,
    validatedOrdered: mainValidatedOrdered,
    shadowValidatedOrdered,
  } = c;
  const validatedOrdered = shadowValidatedOrdered ?? mainValidatedOrdered;
  const materialRowBase = c.shadowMaterialRowBase ?? 0;
  // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer
  // (the wrapper) -- the de-dup compare uses wrapper identity (one wrapper
  // per RHI handle from gpuStore), and `.handle` is passed to the RHI
  // setVertexBuffer / setIndexBuffer call.
  let shadowLastVertexBuffer: GpuBuffer | null = null;
  let shadowLastIndexBuffer: GpuBuffer | null = null;
  // bug-20260619-csm RC-3 (D-3): track the currently-bound shadow PSO so
  // per-entity setPipeline only fires on change (same de-dup discipline as
  // vertex/index buffers above). The default-shadow-caster PSO is already
  // bound by the setPipeline call above; the loop switches to a custom
  // ShadowCaster PSO when a material supplies one.
  let shadowLastPipeline = shadowPipeline;
  let materialDeps: PerSubmeshMaterialBgDeps | undefined;
  const identityInstanceDraws = [{ buffer: pipelineState.identityInstanceBuffer, count: 1 }];

  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;
    if (entry.source.shadowCaster === false || entry.source.authorVisible === false) continue;
    if (((entry.source.shadowChannels ?? 0xffffffff) & casterChannels) === 0) continue;
    if (skipCapsuleReady && c.runtime.demandCapsuleShadow?.(entry.source)?.status === 'ready')
      continue;
    if (!shadowViewContains(entry.source, viewPlanes, c.shadowCasterBounds)) continue;

    const submeshes = entry.mesh.submeshes;
    const slot = c.shadowSlotForEntity?.(entry.source.worldId, entry.source.entityKey);
    let shadowInstanceDraws:
      | readonly { readonly buffer: Buffer; readonly count: number }[]
      | undefined;
    const indices = entry.submeshIndices ?? submeshes.keys();
    for (const submeshIndex of indices) {
      const submesh = submeshes[submeshIndex];
      if (submesh === undefined) continue;
      if (!isTriangleTopology(submesh.topology)) continue;
      const accepted = shadowMaterial(c, entry.source, submesh.materialSlot);
      const passes = accepted.passes;
      if (!passes.some((pass) => pass.tags.LightMode === 'ShadowCaster')) continue;
      if (
        slot !== undefined &&
        gpuSelections?.some((selection) =>
          selection.ownsSlot(entry.source, submeshIndex, slot.slot, slot.generation),
        )
      )
        continue;
      if (shadowMeshBindGroup === null)
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'the CPU ShadowCaster mesh binding',
          hint: 'prepare mesh resources for each direct shadow draw',
        });
      if (shadowInstanceDraws === undefined) {
        // feat-20260604-mesh-topology-debug-draw M5 / w14 (AC-09, D-A6): the
        // shadow caster PSO is triangle-list; it only projects triangle faces.
        // line-list / line-strip / point-list meshes have no surface to cast a
        // shadow, so skip them here. triangle-strip is still a face topology
        // and projects (the shadow PSO's fixed triangle-list rasterizes its
        // expanded triangles correctly enough for the depth pass).
        //
        // feat-20260608 M4 / w16: per-submesh shadow draw — iterate submeshes
        // and skip non-triangle submeshes individually (each submesh may differ).
        if (entry.mesh.vertexBuffer !== shadowLastVertexBuffer) {
          shadowPass.setVertexBuffer(0, entry.mesh.vertexBuffer.handle);
          shadowLastVertexBuffer = entry.mesh.vertexBuffer;
        }
        if (entry.mesh.indexed && entry.mesh.indexBuffer !== shadowLastIndexBuffer) {
          // indexed=true implies indexBuffer is non-null GpuBuffer.
          if (entry.mesh.indexBuffer !== null) {
            shadowPass.setIndexBuffer(entry.mesh.indexBuffer.handle, entry.mesh.indexFormat);
            shadowLastIndexBuffer = entry.mesh.indexBuffer;
          }
        }

        prepareMeshDraw(c, entry);
        // Shadow and Forward consume the same resident projection, dirty ranges,
        // temporal history and binding limits. A new revision uploads in place.
        shadowInstanceDraws = identityInstanceDraws;
        if (entry.source.instances !== undefined) {
          const draws = resolveGeometryInstanceBuffer(c, entry, [], false);
          if (draws === null || draws.length === 0) break;
          shadowInstanceDraws = draws.map((draw) => ({
            buffer: draw.instanceBuffer,
            count: draw.instanceCount,
          }));
        }
      }
      const sm = submesh;

      // Resolve the ShadowCaster PSO for the material bound to this submesh.
      // Built-in materials normally use the shared vertex-only caster, but an
      // authored `cullMode:'none'`/`frontFace` must still reach that PSO so
      // two-sided casters (such as the Three.js teapot) populate the atlas
      // from both faces. Custom ShadowCaster shaders retain their own path.
      const submeshMaterial = accepted.snapshot;
      const range = submeshRange(entry.mesh, submeshIndex);
      for (const authoredPass of passes) {
        if (authoredPass.tags.LightMode !== 'ShadowCaster') continue;
        const shadowDispatch: MaterialDispatchPass =
          authoredPass.materialShaderId === 'forgeax::default-standard-pbr'
            ? { ...authoredPass, materialShaderId: SHADOW_CASTER_SHADER_ID }
            : authoredPass;
        const entryShadowShaderId = shadowDispatch.materialShaderId;
        const receiver =
          terrainReceiver !== undefined &&
          entry.source.terrain !== undefined &&
          entry.source.worldId === terrainReceiver.worldId &&
          entry.source.entityKey === terrainReceiver.entityKey;
        const entryShadowPipeline = resolveShadowMaterialPipeline(
          c,
          entry,
          sm.topology,
          submeshMaterial,
          shadowDispatch,
          reflected,
          receiver,
        );
        if (entryShadowPipeline === null) {
          throw new RhiError({
            code: 'rhi-not-available',
            expected: `CPU ShadowCaster pipeline ${entryShadowShaderId}`,
            hint: 'publish the exact residual ShadowCaster pipeline; do not substitute the default shader',
          });
        }
        if (entryShadowPipeline.pipeline !== shadowLastPipeline) {
          shadowPass.setPipeline(entryShadowPipeline.pipeline);
          shadowLastPipeline = entryShadowPipeline.pipeline;
        }
        const meshOffset = meshDrawSlot(entry) * MESH_PER_ENTITY_STRIDE;
        const meshBinding = meshSsboBufferBinding(pipelineState.meshStorageBuffer, meshOffset);
        const contract = entryShadowPipeline.group2Contract;
        if (contract === 'skin' || contract === 'skin-cluster') {
          if (entry.source.skinBinding === undefined)
            throw new RhiError({
              code: 'rhi-descriptor-invalid',
              expected: 'a Skin Binding for the selected ShadowCaster contract',
              hint: 'bind a complete Skin source before recording a Skin-input material',
            });
          const task = runtime.demandSkinTask?.(entry.source);
          if (task === undefined) continue;
          const group = geometrySkinBindGroup(c, task, meshBinding, contract);
          if (group === null)
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'the selected ShadowCaster Skin task binding',
              hint: 'prepare the exact material group2 contract before recording',
            });
          shadowPass.setBindGroup(
            2,
            group,
            pbrSkinMeshDynamicOffsets(
              meshBinding.byteOffset,
              task,
              runtime.device.caps.storageBuffer,
            ),
          );
        } else {
          const group =
            contract === 'cluster'
              ? clusteredMeshSlotBindGroup(c, meshOffset)
              : pipelineState.meshStorageBuffer.pages === undefined
                ? shadowMeshBindGroup
                : meshSlotBindGroup(
                    runtime.device,
                    c.frameState,
                    pipelineState,
                    c.bindGroupCounts,
                    meshOffset,
                  );
          if (group === null)
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'the selected ShadowCaster mesh binding',
              hint: 'prepare the exact material group2 contract before recording',
            });
          shadowPass.setBindGroup(2, group, [meshBinding.byteOffset]);
        }
        materialDeps ??= {
          runtime,
          pipelineState,
          world: c.world,
          store: c.store,
          materialSlice: MATERIAL_UNIFORM_BYTES,
          videoHighPerfAvailable: probeVideoHighPerfUpload(runtime.device),
          skylightResources: prepareMaterialSkylight(c).skylightResources,
          resolveRenderTargetTextureSource: runtime.resolveRenderTargetTextureSource,
          materialBgShared: c.frameState.materialBgShared,
          materialBgAssemblyCache: c.materialBgAssemblyCache,
          frameState: c.frameState,
          bindGroupCounts: c.bindGroupCounts,
        };
        const materialSlot =
          c.materialSlotIndices[materialRowBase + i]?.[sm.materialSlot] ??
          c.materialSlotIndices[materialRowBase + i]?.[0];
        if (materialSlot === undefined) {
          throw new RhiError({
            code: 'rhi-descriptor-invalid',
            expected: 'a prepared material slot for each shadow submesh',
            hint: 'repair material slot preparation before recording shadows',
          });
        }
        const materialGroup = buildPerSubmeshMaterialBg(
          materialDeps,
          submeshMaterial,
          entry.source.entityKey,
          entry.world ?? c.world,
          entryShadowShaderId,
          materialSlot,
        );
        shadowPass.setBindGroup(1, materialGroup, [
          meshSsboBufferBinding(
            pipelineState.materialUniformBuffer,
            materialUniformSlot(c.runtime, submeshMaterial) * MATERIAL_PER_ENTITY_STRIDE,
          ).byteOffset,
        ]);
        for (const instanceDraw of shadowInstanceDraws) {
          const shadowInstancesBg = resolveGeometryInstancesBindGroup(c, instanceDraw.buffer);
          shadowPass.setBindGroup(3, shadowInstancesBg);
          if (entry.mesh.indexed) {
            shadowPass.drawIndexed(
              range.count,
              instanceDraw.count,
              range.first,
              range.baseVertex,
              0,
            );
          } else {
            shadowPass.draw(range.count, instanceDraw.count, range.first, 0);
          }
        }
      }
    }
  }
}

/**
 * Build (or reuse) the neutral `shadow-material-singleton` @group(1) BG for
 * default casters without an authored material dispatch. Authored opaque and
 * masked residuals bind their own prepared material slots instead. Directional,
 * point, and spot passes share bindings only while every resource identity
 * matches; scene-table growth or recovery must create a fresh bind group.
 */
function ensureSpotShadowMaterialBg(c: _InternalRenderPipelineContext): BindGroup | null {
  const { runtime, frameState, pipelineState } = c;
  const fb = pipelineState.skylightFallback;
  const sceneMaterialBuffer =
    c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer ??
    meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer;
  const handles = [
    pipelineState.materialBindGroupLayout,
    meshSsboBufferBinding(pipelineState.materialUniformBuffer, 0).buffer,
    pipelineState.defaultSampler,
    pipelineState.defaultNormalTextureView,
    pipelineState.fallbackTextureView,
    sceneMaterialBuffer,
    ...(fb === null ? [] : [fb]),
  ];
  const cached = findFromChain(
    frameState.shadowMaterialBindGroups,
    handles,
    'shadow-material-singleton',
  );
  if (cached !== undefined) return cached;
  const fallbackEntries: BindGroupEntry[] = buildPbrMaterialUserRegionEntries().map((entry) => {
    if (entry.buffer !== undefined) {
      return {
        binding: entry.binding,
        resource: {
          kind: 'buffer' as const,
          value: {
            buffer: meshSsboBufferBinding(pipelineState.materialUniformBuffer, 0).buffer,
            offset: 0,
            size: MATERIAL_UNIFORM_BYTES,
          },
        },
      };
    }
    if (entry.sampler !== undefined) {
      return {
        binding: entry.binding,
        resource: { kind: 'sampler' as const, value: pipelineState.defaultSampler },
      };
    }
    return {
      binding: entry.binding,
      resource: {
        kind: 'textureView' as const,
        value:
          entry.binding === 6
            ? pipelineState.defaultNormalTextureView
            : pipelineState.fallbackTextureView,
      },
    };
  });
  const omitted = omittedStandardMaterialBindings(
    STANDARD_PIPELINE_PARAM_SCHEMA.filter((field) => field.type === 'texture2d').map(
      (field) => field.name,
    ),
    transmissionBackdropAvailable(runtime.device.limits.maxSampledTexturesPerShaderStage),
    true,
    true,
  );
  const merged = (
    fb !== null
      ? assembleMaterialWithSkylightEntries(
          fallbackEntries,
          skylightBindGroupResources(fb),
          transmissionBackdropAvailable(runtime.device.limits.maxSampledTexturesPerShaderStage)
            ? undefined
            : null,
        )
      : fallbackEntries
  ).filter((entry) => !omitted.has(entry.binding));
  // Binding(46) is the optional scene-material storage table.  The material
  // BGL intentionally omits it on the uniform-only WebGL2 lane, so emitting
  // an entry unconditionally creates a deferred-invalid bind group in wgpu's
  // downlevel backend and only surfaces at Queue::submit.  GPU-driven alpha
  // batches build their own receipt-backed group and are storage-capable by
  // admission; this singleton only needs the optional slot when that same
  // capability is present.
  if (runtime.device.caps.storageBuffer) {
    // Scene-index shadow variants read MaterialParameters by the projected
    // row selected in visibleItems.  The legacy singleton used the mesh SSBO
    // here because the old shadow vertex path never consumed binding(46); on
    // the capable scene-index lane that buffer is a different struct and can
    // make the alpha/depth fragment discard every caster.  Reuse the frame's
    // producer-owned scene material table, with the mesh buffer only for
    // direct/legacy callers that do not publish one.
    merged.push({
      binding: 46,
      resource: {
        kind: 'buffer',
        value: { buffer: sceneMaterialBuffer },
      },
    });
  }
  const r = getOrCreateFromChainResult(
    frameState.shadowMaterialBindGroups,
    handles,
    'shadow-material-singleton',
    () =>
      runtime.device.createBindGroup({
        label: 'shadow-material-bg',
        layout: pipelineState.materialBindGroupLayout,
        entries: merged,
      }),
    c.bindGroupCounts,
  );
  if (!r.ok) {
    runtime.errorRegistry.fire(r.error);
    return null;
  }
  return r.value;
}

/**
 * Assemble the material group for a GPU-driven alpha-mask caster from the
 * same material snapshot/residency owner as the main PBR pass. The shadow
 * shader only consumes the base-color pair and the scene-material table, but
 * the complete merged layout is still required by the shared pipeline.
 */
function ensureGpuDrivenAlphaMaskMaterialBg(
  c: _InternalRenderPipelineContext,
  projection: GpuDrivenShadowBatchProjection,
): BindGroup {
  const sceneMaterialBuffer = c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer;
  if (sceneMaterialBuffer === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'GPU Scene material buffer for alpha-mask shadow recording',
      hint: 'publish the receipt-derived scene material table before the capable shadow pass',
    });
  }
  const fallback = c.pipelineState.skylightFallback;
  if (fallback === null) {
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'pipelineState.skylightFallback for alpha-mask shadow material layout',
      hint: 'create the merged Standard PBR material resources before recording shadows',
    });
  }
  const skylightResources = skylightBindGroupResources(fallback);
  const deps: PerSubmeshMaterialBgDeps = {
    runtime: c.runtime,
    pipelineState: c.pipelineState,
    world: c.world,
    store: c.store,
    materialSlice: MATERIAL_UNIFORM_BYTES,
    videoHighPerfAvailable: false,
    skylightResources,
    materialBgShared: c.frameState.materialBgShared,
    materialBgAssemblyCache: c.materialBgAssemblyCache,
    sceneMaterialBuffer,
    bindGroupCounts: c.bindGroupCounts,
    frameState: c.frameState,
  };
  const bindGroup = buildPerSubmeshMaterialBg(
    deps,
    projection.material,
    undefined,
    c.resourceScopes?.[projection.worldId] ?? c.world,
    // The default shadow program uses the canonical Standard layout. The
    // color alias can compact IBL slots and append physical textures, so its
    // group cannot be bound to that shadow pipeline even for an opaque draw.
    'forgeax::default-standard-pbr',
  );
  return bindGroup;
}

/**
 * Build the group(1) binding for a receipt-backed custom shadow program. The
 * ordinary shadow singleton is Standard-only; binding it for a custom layout
 * would make the pipeline appear executable while deferring a BGL mismatch to
 * submit. Custom resources therefore use the same material producer as the
 * main pass, using the selected scene-index row when the published custom ABI
 * declares that resource. No Standard-only alpha or shader rows are
 * synthesized for the custom artifact.
 */
function ensureGpuDrivenCustomShadowMaterialBg(
  c: _InternalRenderPipelineContext,
  projection: GpuDrivenShadowBatchProjection,
): BindGroup {
  const shaderId =
    projection.shadowArtifact.specializationKey ?? projection.shadowArtifact.material;
  const fallback = c.pipelineState.skylightFallback;
  if (fallback === null) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'skylight resources for custom shadow material binding',
      hint: 'publish the custom material resource owner before recording the shadow lane',
    });
  }
  const sceneMaterialBuffer = c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer;
  if (sceneMaterialBuffer === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'producer-owned scene material buffer for custom shadow ABI',
      hint: 'publish the selected shadow MaterialProgramAbi scene-index resource before recording',
    });
  }
  const skylightResources = skylightBindGroupResources(fallback);
  const deps: PerSubmeshMaterialBgDeps = {
    runtime: c.runtime,
    pipelineState: c.pipelineState,
    world: c.world,
    store: c.store,
    materialSlice: MATERIAL_UNIFORM_BYTES,
    videoHighPerfAvailable: false,
    skylightResources,
    materialBgShared: c.frameState.materialBgShared,
    materialBgAssemblyCache: c.materialBgAssemblyCache,
    bindGroupCounts: c.bindGroupCounts,
    frameState: c.frameState,
    sceneMaterialBuffer,
  };
  const bindGroup = buildPerSubmeshMaterialBg(
    deps,
    projection.material,
    undefined,
    c.resourceScopes?.[projection.worldId] ?? c.world,
    shaderId,
  );
  return bindGroup;
}
