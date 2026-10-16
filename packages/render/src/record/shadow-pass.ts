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
import type { MaterialRenderState, PassSelector } from '@forgeax/engine-types';
import { isTriangleTopology } from '@forgeax/engine-types';
import { transmissionBackdropAvailable } from '../assembly/device-feature-admission';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import { atmosphereBindings } from '../environment/bindings';
import { gpuDrivenMaterialArtifactKey, gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import {
  eligibleGpuDrivenDraws,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
  type GpuDrivenBatch,
} from '../gpu-driven/batch-topology';
import { capturedPreparedMaterialArtifactKey } from '../gpu-driven/prepared-draw';
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
  buildPbrMaterialUserRegionEntries,
  createPbrSkinMeshBindGroupEntries,
  omittedStandardMaterialBindings,
  pbrSkinMeshDynamicOffsets,
  SHADOW_CASTER_SHADER_ID,
  shadowCasterVariantSet,
} from '../pbr-pipeline';
import { COOKIE_MATRIX_BYTES } from '../prepare/extended-lighting/resources';
import type {
  DispatchEntry,
  ExtractedLights,
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import { shadowCasterCpuReason } from '../render-system-extract';
import { matchPass, SHADOW_CASTER_PASS_SELECTOR } from '../systems/pass-selector';
import { FirstEntryMap } from './first-entry-map';
import { meshSlotBindGroup } from './frame-lighting';
import {
  type MaterialBgAssemblyCacheEntry,
  type ValidatedRenderable,
  worldEntityKey,
} from './frame-snapshot';
import {
  resolveGeometryInstanceBuffer,
  resolveGeometryInstancesBindGroup,
} from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import {
  findFromChain,
  getOrCreateFromChain,
  getOrCreateFromChainResult,
  MESH_PER_ENTITY_STRIDE,
  MESH_SSBO_BYTES,
  MESH_UBO_FULL_ARRAY_BYTES,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE, MATERIAL_UNIFORM_BYTES } from './render-context';
import { shadowViewContains } from './shadow-culling';
import {
  publishedShadowMembershipKeys,
  shadowMembershipDraw,
  shadowMembershipLookup,
  shadowSourcesByRenderable,
} from './shadow-ownership-index';
import { SingleMaterialHandleSet } from './single-material-handle-set';
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

interface ShadowDispatch {
  readonly passIndex: number;
  readonly materialHandle: number;
  readonly vertexEntry: string | undefined;
  readonly fragmentEntry: string | undefined;
  readonly materialShaderId: string;
  readonly renderState: MaterialRenderState | undefined;
  readonly materialSlot: number | undefined;
  readonly paramSnapshot: DispatchEntry['paramSnapshot'];
}

type ShadowDispatchMap = ReadonlyMap<number, ReadonlyMap<number, readonly ShadowDispatch[]>>;
const DEFAULT_SHADOW_DISPATCH = [undefined] as const;

type ShadowDispatchProjectionInput = Pick<
  _InternalRenderPipelineContext,
  | 'dispatch'
  | 'shadowDispatch'
  | 'validatedOrdered'
  | 'shadowValidatedOrdered'
  | 'materialSlotIndices'
  | 'materialSlots'
>;

export interface PreparedShadowDispatchProjection {
  readonly matchedIndices: Set<number> | null;
  readonly matchedMaterialHandles: ReadonlyMap<number, ReadonlySet<number>> | null;
  readonly shaders: ShadowDispatchMap;
}

interface PreparedShadowCaster {
  readonly entry: ValidatedRenderable;
  readonly pipelines: {
    readonly passIndex: number | undefined;
    readonly reflected: boolean;
    readonly terrainReceiver: boolean;
    readonly pipeline: RenderPipeline;
  }[][];
}

/** One production frame owns this projection; it never enters retained frameState. */
export interface ShadowDispatchProjectionOwner {
  resolve(input: ShadowDispatchProjectionInput): PreparedShadowDispatchProjection;
  residual?(
    input: _InternalRenderPipelineContext,
    claimed: ReadonlySet<string> | undefined,
  ): PreparedShadowDispatchProjection;
  /** Dense roster scratch for successive shadow views of the same record context. */
  casters(input: _InternalRenderPipelineContext): (PreparedShadowCaster | undefined)[];
}

function prepareShadowDispatchProjection(
  c: ShadowDispatchProjectionInput,
  dispatch: readonly DispatchEntry[] = shadowDispatchEntries(c),
): PreparedShadowDispatchProjection {
  const matchedMaterialHandles = buildMatchedMaterialHandlesByRenderable(
    dispatch,
    SHADOW_CASTER_PASS_SELECTOR,
  );
  return {
    matchedIndices:
      dispatch.length === 0 && shadowDispatchEntries(c).length !== 0
        ? new Set()
        : matchedMaterialHandles === null
          ? null
          : new Set(matchedMaterialHandles.keys()),
    matchedMaterialHandles,
    shaders: shadowShaderMap(c, dispatch),
  };
}

/**
 * Called with the record owner's finalized roster and material slot layout.
 * Capture and main views consume the same record-owned readonly facts, including
 * across its shared scene-inputs barrier. View
 * overrides with another roster/layout rebuild locally rather than sharing.
 * Lazy preparation keeps wholly GPU-owned views on their existing early return.
 */
export function createShadowDispatchProjectionOwner(
  input: ShadowDispatchProjectionInput,
): ShadowDispatchProjectionOwner {
  const {
    dispatch,
    shadowDispatch,
    validatedOrdered,
    shadowValidatedOrdered,
    materialSlotIndices,
    materialSlots,
  } = input;
  let prepared: PreparedShadowDispatchProjection | undefined;
  let casterContext: _InternalRenderPipelineContext | undefined;
  let casters: (PreparedShadowCaster | undefined)[] = [];
  let residualContext: _InternalRenderPipelineContext | undefined;
  let residualMembership: readonly ShadowCasterMembership[] | undefined;
  let residualWorldKeys: readonly number[] | undefined;
  let residualClaims: Set<string> | undefined;
  let residualPrepared: PreparedShadowDispatchProjection | undefined;
  return {
    residual(c, claimed) {
      // Only the record owner's captured membership/geometry may be shared
      // across views. Borrowed contexts keep every original observation.
      const membership = c.shadowCasterMembership;
      if (
        claimed === undefined ||
        !(claimed instanceof Set) ||
        Object.getPrototypeOf(claimed) !== Set.prototype ||
        Object.hasOwn(claimed, 'has') ||
        Object.hasOwn(claimed, 'size') ||
        Object.hasOwn(claimed, Symbol.iterator) ||
        claimed.size === 0 ||
        membership === undefined ||
        publishedShadowMembershipKeys(membership) === undefined ||
        c.dispatch !== dispatch ||
        c.shadowDispatch !== shadowDispatch ||
        c.validatedOrdered !== validatedOrdered ||
        c.shadowValidatedOrdered !== shadowValidatedOrdered ||
        c.materialSlotIndices !== materialSlotIndices ||
        c.materialSlots !== materialSlots
      )
        return prepareShadowResidualSelection(c, claimed);
      if (
        residualContext === c &&
        residualMembership === membership &&
        residualWorldKeys === c.shadowCasterWorldKeys &&
        residualClaims !== undefined &&
        residualPrepared !== undefined &&
        residualClaims.size === claimed.size
      ) {
        let equal = true;
        for (const key of residualClaims)
          if (!claimed.has(key)) {
            equal = false;
            break;
          }
        if (equal) return residualPrepared;
      }
      const result = prepareShadowResidualSelection(c, claimed);
      residualContext = c;
      residualMembership = membership;
      residualWorldKeys = c.shadowCasterWorldKeys;
      // A frozen Set is still mutable. Compare the complete captured contents
      // on every view, including views that reuse and mutate the same Set.
      residualClaims = new Set(claimed);
      residualPrepared = result;
      return result;
    },
    casters(c) {
      if (casterContext !== c) {
        casterContext = c;
        casters = [];
      }
      return casters;
    },
    resolve(c) {
      if (
        c.dispatch !== dispatch ||
        c.shadowDispatch !== shadowDispatch ||
        c.validatedOrdered !== validatedOrdered ||
        c.shadowValidatedOrdered !== shadowValidatedOrdered ||
        c.materialSlotIndices !== materialSlotIndices ||
        c.materialSlots !== materialSlots
      )
        return prepareShadowDispatchProjection(c);
      prepared ??= prepareShadowDispatchProjection(c);
      return prepared;
    },
  };
}

export function resolveShadowDispatchProjection(
  c: _InternalRenderPipelineContext,
): PreparedShadowDispatchProjection {
  return c.shadowDispatchProjection?.resolve(c) ?? prepareShadowDispatchProjection(c);
}

function shadowDispatchEntries(
  c: Pick<_InternalRenderPipelineContext, 'dispatch' | 'shadowDispatch'>,
): readonly DispatchEntry[] {
  return c.shadowDispatch ?? c.dispatch;
}

export function shadowShaderMap(
  c: ShadowDispatchProjectionInput,
  dispatch: readonly DispatchEntry[] = shadowDispatchEntries(c),
): ShadowDispatchMap {
  const shaders = new Map<number, Map<number, ShadowDispatch[]>>();
  const shadowRows = c.shadowDispatch !== undefined;
  const rows = (shadowRows ? c.shadowValidatedOrdered : c.validatedOrdered) ?? [];
  const base = shadowRows ? c.validatedOrdered.length : 0;
  const slotsByRenderable = new Map<number, readonly number[]>();
  for (const entry of dispatch) {
    slotsByRenderable.set(entry.renderableIndex, []);
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row !== undefined && slotsByRenderable.has(row.renderableIndex)) {
      slotsByRenderable.set(row.renderableIndex, c.materialSlotIndices?.[base + index] ?? []);
    }
  }
  // One invocation owns these indices. A later view/frame observes its own
  // roster and slot layout, including in-place publication changes.
  let slotLookups:
    | Map<number, { readonly firstSlotByHandle: Map<number, number>; cursor: number }>
    | undefined;
  for (const entry of dispatch) {
    if (entry.tags.LightMode !== 'ShadowCaster' || entry.materialShaderId === undefined) continue;
    let byMaterial = shaders.get(entry.renderableIndex);
    if (byMaterial === undefined) {
      byMaterial = new Map<number, ShadowDispatch[]>();
      shaders.set(entry.renderableIndex, byMaterial);
    }
    const candidateSlots = slotsByRenderable.get(entry.renderableIndex) ?? [];
    let materialSlot: number | undefined;
    if (byMaterial.size === 0) {
      // A single accepted dispatch keeps the existing cheap early-match path.
      materialSlot = candidateSlots.find(
        (slot) => c.materialSlots?.[slot]?.materialHandle === entry.materialHandle,
      );
    } else {
      const previous = byMaterial.get(entry.materialHandle)?.[0];
      if (previous !== undefined) {
        materialSlot = previous.materialSlot;
      } else {
        slotLookups ??= new Map();
        let lookup = slotLookups.get(entry.renderableIndex);
        if (lookup === undefined) {
          lookup = { firstSlotByHandle: new Map(), cursor: 0 };
          slotLookups.set(entry.renderableIndex, lookup);
        }
        // First-slot selection follows roster order. After the initial find,
        // all distinct dispatch handles share at most one more slot traversal.
        while (
          !lookup.firstSlotByHandle.has(entry.materialHandle) &&
          lookup.cursor < candidateSlots.length
        ) {
          const slot = candidateSlots[lookup.cursor++];
          if (slot === undefined) continue;
          const handle = c.materialSlots?.[slot]?.materialHandle;
          // Map uses SameValueZero; find used ===, so NaN must never match.
          if (
            handle !== undefined &&
            !Number.isNaN(handle) &&
            !lookup.firstSlotByHandle.has(handle)
          )
            lookup.firstSlotByHandle.set(handle, slot);
        }
        materialSlot = lookup.firstSlotByHandle.get(entry.materialHandle);
      }
    }
    const dispatches = byMaterial.get(entry.materialHandle) ?? [];
    dispatches.push({
      passIndex: entry.passIndex,
      materialHandle: entry.materialHandle,
      vertexEntry: entry.vertexEntry,
      fragmentEntry: entry.fragmentEntry,
      materialShaderId:
        entry.materialShaderId === 'forgeax::default-standard-pbr'
          ? SHADOW_CASTER_SHADER_ID
          : entry.materialShaderId,
      renderState: entry.renderState,
      materialSlot,
      paramSnapshot: entry.paramSnapshot,
    });
    byMaterial.set(entry.materialHandle, dispatches);
  }
  return shaders;
}

/** Prove complete GPU coverage before preparing CPU dispatch and geometry state. */
function shadowResidualSelection(
  c: _InternalRenderPipelineContext,
  claimed: ReadonlySet<string> | undefined,
): PreparedShadowDispatchProjection {
  return (
    c.shadowDispatchProjection?.residual?.(c, claimed) ?? prepareShadowResidualSelection(c, claimed)
  );
}

function prepareShadowResidualSelection(
  c: _InternalRenderPipelineContext,
  claimed: ReadonlySet<string> | undefined,
): PreparedShadowDispatchProjection {
  const source = shadowDispatchEntries(c);
  let dispatch = source;
  const membership = c.shadowCasterMembership;
  if (claimed !== undefined && membership !== undefined && claimed.size > 0) {
    const lookup = shadowMembershipLookup(membership);
    const fullyClaimed = new Map<number, ValidatedRenderable>();
    for (const entry of c.shadowValidatedOrdered ?? c.validatedOrdered) {
      if (entry.source.gpuDrivenDraws !== undefined) {
        fullyClaimed.set(entry.renderableIndex, entry);
      }
    }
    for (const pass of source) {
      if (pass.tags.LightMode !== 'ShadowCaster') continue;
      const entry = fullyClaimed.get(pass.renderableIndex);
      if (entry === undefined) continue;
      const draws = entry.source.gpuDrivenDraws;
      const submeshes = entry.mesh.submeshes;
      // Compact or legacy draw identities keep the ordinary per-submesh path.
      if (draws === undefined || draws.length !== submeshes.length) {
        fullyClaimed.delete(pass.renderableIndex);
        continue;
      }
      const worldEntity = worldEntityKey(
        c.shadowCasterWorldKeys?.[entry.source.worldId] ?? entry.source.worldId,
        entry.source.entityKey,
      );
      for (let submeshIndex = 0; submeshIndex < submeshes.length; submeshIndex++) {
        const submesh = submeshes[submeshIndex];
        const draw = draws[submeshIndex];
        if (
          submesh === undefined ||
          draw?.drawItemIndex !== submeshIndex ||
          draw.materialSlot !== submesh.materialSlot
        ) {
          fullyClaimed.delete(pass.renderableIndex);
          break;
        }
        const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
        if (
          !isTriangleTopology(submesh.topology) ||
          (material.materialHandle ?? -1) !== pass.materialHandle
        ) {
          continue;
        }
        const matching = shadowMembershipDraw(
          lookup,
          worldEntity,
          pass.materialHandle,
          submeshIndex,
        );
        let owned = false;
        if (matching !== undefined && !matching.cpu) {
          for (const row of matching.rows) {
            const member = membership[row];
            const key = lookup.keys[row];
            if (
              member?.renderableIndex === pass.renderableIndex &&
              member.passIndex === pass.passIndex &&
              key !== undefined &&
              claimed.has(key)
            ) {
              owned = true;
              break;
            }
          }
        }
        if (!owned) {
          fullyClaimed.delete(pass.renderableIndex);
          break;
        }
      }
    }
    // Present membership rows alone cannot prove coverage of actual submeshes/passes.
    dispatch = source.filter((entry) => !fullyClaimed.has(entry.renderableIndex));
  }
  // Reuse the record-owned projection unless this view actually removed GPU
  // entities. Reduced residuals never prepare the full-roster maps first.
  return dispatch.length === source.length
    ? resolveShadowDispatchProjection(c)
    : prepareShadowDispatchProjection(c, dispatch);
}

function shadowRasterState(
  state: MaterialRenderState | undefined,
  reflected: boolean,
): MaterialRenderState | undefined {
  return reflected ? { ...state, frontFace: state?.frontFace === 'cw' ? 'ccw' : 'cw' } : state;
}

function shadowPipeline(
  c: _InternalRenderPipelineContext,
  reflected = false,
): RenderPipeline | null {
  return (
    c.runtime.getMaterialShaderPipeline?.(
      SHADOW_CASTER_SHADER_ID,
      false,
      shadowRasterState(undefined, reflected),
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

function skinnedShadowMeshBindGroup(
  c: _InternalRenderPipelineContext,
  entry: _InternalRenderPipelineContext['validatedOrdered'][number],
  meshOffset: number,
): BindGroup | null {
  const meshBuffer = meshSsboBufferBinding(c.pipelineState.meshStorageBuffer, meshOffset).buffer;
  const skin = entry.source.skin;
  const layout = c.pipelineState.pbrSkinMeshBindGroupLayout;
  const allocator = c.pipelineState.skinPaletteAllocator;
  if (skin === undefined || layout === null || allocator === null) return null;
  return getOrCreateFromChain(
    c.frameState.meshBindGroupCache,
    [meshBuffer, skin.buffer],
    'shadow-pbr-skin-mesh',
    () => {
      const created = c.runtime.device.createBindGroup({
        label: 'shadow-pbr-skin-mesh-bg',
        layout,
        entries: createPbrSkinMeshBindGroupEntries(
          meshBuffer,
          c.runtime.device.caps.storageBuffer ? MESH_SSBO_BYTES : MESH_UBO_FULL_ARRAY_BYTES,
          skin.buffer,
          allocator.bindingWindowBytes,
        ),
      });
      if (!created.ok) throw created.error;
      return created.value;
    },
    c.bindGroupCounts,
  );
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
      pass.setBindGroup(2, raster.meshBindGroup, raster.deformation === 'skin' ? [0, 0, 0] : [0]);
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

/** Sparse source identities stay sorted in extracted snapshots; tolerate unordered publications. */
function shadowCompactDrawIndex(
  draws: NonNullable<RenderableSnapshot['gpuDrivenDraws']>,
  submeshIndex: number,
  ordered: boolean,
): number | undefined {
  if (!ordered) {
    for (let i = draws.length - 1; i >= 0; i--)
      if (draws[i]?.drawItemIndex === submeshIndex) return i;
    return undefined;
  }
  // Dense meshes use their existing position directly. Sparse meshes use a
  // binary search, retaining the old last-match behavior for repeated IDs.
  if (
    draws[submeshIndex]?.drawItemIndex === submeshIndex &&
    draws[submeshIndex + 1]?.drawItemIndex !== submeshIndex
  )
    return submeshIndex;
  let low = 0,
    high = draws.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((draws[middle]?.drawItemIndex ?? Infinity) <= submeshIndex) low = middle + 1;
    else high = middle;
  }
  return draws[low - 1]?.drawItemIndex === submeshIndex ? low - 1 : undefined;
}

function isGpuShadowClaimedSubmesh(
  source: RenderableSnapshot,
  renderableIndex: number,
  compactDrawIndex: number | undefined,
  gpuDrivenShadowDrawKeys: ReadonlySet<string> | undefined,
  shadowDispatchByRenderableIdx: ShadowDispatchMap,
  shadowCasterMembership: readonly ShadowCasterMembership[] | undefined,
  shadowCasterWorldKeys: readonly number[] | undefined,
): boolean {
  if (gpuDrivenShadowDrawKeys === undefined) return false;
  const drawItemIndex = compactDrawIndex;
  const draw = drawItemIndex === undefined ? undefined : source.gpuDrivenDraws?.[drawItemIndex];
  if (drawItemIndex === undefined || draw === undefined) return false;
  const material = source.materials[draw.materialSlot] ?? source.material;
  const worldEntity = worldEntityKey(
    shadowCasterWorldKeys?.[source.worldId] ?? source.worldId,
    source.entityKey,
  );
  const sourceDrawItemIndex = draw.drawItemIndex ?? drawItemIndex;
  if (shadowCasterMembership !== undefined) {
    const lookup = shadowMembershipLookup(shadowCasterMembership);
    const matching = shadowMembershipDraw(
      lookup,
      worldEntity,
      material.materialHandle ?? -1,
      sourceDrawItemIndex,
    );
    if (matching === undefined || matching.cpu) return false;
    for (const row of matching.rows) {
      const key = lookup.keys[row];
      if (key === undefined || !gpuDrivenShadowDrawKeys.has(key)) return false;
    }
    return true;
  }
  const dispatches =
    shadowDispatchByRenderableIdx.get(renderableIndex)?.get(material.materialHandle ?? 0) ?? [];
  if (dispatches.length > 0) {
    return dispatches.every((dispatch) =>
      gpuDrivenShadowDrawKeys.has(
        gpuDrivenShadowDrawKey(
          worldEntity,
          material.materialHandle ?? -1,
          draw.drawItemIndex ?? drawItemIndex,
          dispatch.passIndex,
        ),
      ),
    );
  }
  const base = gpuDrivenShadowDrawKey(
    worldEntity,
    material.materialHandle ?? -1,
    sourceDrawItemIndex,
    0,
  ).split(':');
  return [...gpuDrivenShadowDrawKeys].some((key) => {
    const parts = key.split(':');
    return (
      parts.length === 4 && parts[0] === base[0] && parts[1] === base[1] && parts[2] === base[2]
    );
  });
}

interface GpuDrivenShadowRecordResult {
  readonly claimedKeys: ReadonlySet<string>;
}

const EMPTY_SHADOW_KEYS: ReadonlySet<string> = new Set();

function shadowCasterKeys(c: _InternalRenderPipelineContext): ReadonlySet<string> {
  if (c.shadowCasterMembership !== undefined) {
    return shadowMembershipLookup(c.shadowCasterMembership).keySet;
  }
  return c.gpuDrivenShadowDrawKeys ?? EMPTY_SHADOW_KEYS;
}

function validateShadowOwnership(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  claimedKeys: ReadonlySet<string> | undefined,
  recordedKeys: ReadonlySet<string>,
): void {
  if (
    c.shadowCasterMembership === undefined &&
    (c.gpuDrivenShadowDrawKeys === undefined || c.gpuDrivenShadowDrawKeys.size === 0)
  )
    return;
  const claimed = claimedKeys ?? EMPTY_SHADOW_KEYS;
  const allExpectedKeys = shadowCasterKeys(c);
  // A draw is never both GPU-claimed and CPU-recorded. GPU ownership is
  // projected before its own per-view culling, so a claim outside the CPU
  // residual's visible subset is still valid when it belongs to the extracted
  // membership.
  let valid = true;
  for (const key of claimed) {
    if (recordedKeys.has(key) || !allExpectedKeys.has(key)) {
      valid = false;
      break;
    }
  }
  // Every GPU-eligible membership visible to this view is covered by one lane.
  // CPU-only residuals without a membership row are owned by the record path.
  if (valid) valid = !hasMissingShadowCaster(c, identity, claimed, recordedKeys, allExpectedKeys);
  if (valid) return;
  const visibleExpectedKeys = visibleExpectedShadowKeys(c, identity, allExpectedKeys);
  const union = new Set([...claimed, ...recordedKeys]);
  const overlap = [...claimed].filter((key) => recordedKeys.has(key));
  const missing = [...visibleExpectedKeys].filter((key) => !union.has(key));
  const unexpectedClaims = [...claimed].filter((key) => !allExpectedKeys.has(key));
  throw new RhiError({
    code: 'internal-error',
    expected: `disjoint ShadowCaster ownership for ${shadowViewIdentityKey(identity)}`,
    hint: `expected=${[...allExpectedKeys].sort().join(',')} visibleExpected=${[...visibleExpectedKeys].sort().join(',')} claimed=${[...claimed].sort().join(',')} recorded=${[...recordedKeys].sort().join(',')} overlap=${overlap.sort().join(',')} missing=${missing.sort().join(',')} unexpectedClaims=${unexpectedClaims.sort().join(',')}`,
  });
}

function hasMissingShadowCaster(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  claimed: ReadonlySet<string>,
  recordedKeys: ReadonlySet<string>,
  allExpectedKeys: ReadonlySet<string>,
): boolean {
  const membership = c.shadowCasterMembership;
  const viewPlanes = c.shadowViewPlanesByView?.get(shadowViewIdentityKey(identity));
  if (membership === undefined || viewPlanes === undefined) {
    for (const key of allExpectedKeys) {
      if (!claimed.has(key) && !recordedKeys.has(key)) return true;
    }
    return false;
  }
  const lookup = shadowMembershipLookup(membership);
  let sources: ReadonlyMap<number, RenderableSnapshot> | undefined;
  for (let row = 0; row < membership.length; row++) {
    const key = lookup.keys[row];
    const entry = membership[row];
    if (key === undefined || entry === undefined) continue;
    if (claimed.has(key) || recordedKeys.has(key)) continue;
    sources ??= shadowSourcesByRenderable(c.shadowValidatedOrdered ?? c.validatedOrdered);
    const source = sources.get(entry.renderableIndex);
    if (source !== undefined && shadowViewContains(source, viewPlanes, c.shadowCasterBounds)) {
      return true;
    }
  }
  return false;
}

function visibleExpectedShadowKeys(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  allExpectedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const membership = c.shadowCasterMembership;
  const viewPlanes = c.shadowViewPlanesByView?.get(shadowViewIdentityKey(identity));
  if (membership === undefined || viewPlanes === undefined) return allExpectedKeys;
  const lookup = shadowMembershipLookup(membership);
  const sources = shadowSourcesByRenderable(c.shadowValidatedOrdered ?? c.validatedOrdered);
  const visible = new Set<string>();
  for (let row = 0; row < membership.length; row++) {
    const key = lookup.keys[row];
    const entry = membership[row];
    if (key === undefined || entry === undefined) continue;
    const source = sources.get(entry.renderableIndex);
    if (source !== undefined && shadowViewContains(source, viewPlanes, c.shadowCasterBounds)) {
      visible.add(key);
    }
  }
  return visible;
}

function hasUnclaimedShadowCasters(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  claimedKeys: ReadonlySet<string> | undefined,
): boolean {
  return hasMissingShadowCaster(
    c,
    identity,
    claimedKeys ?? EMPTY_SHADOW_KEYS,
    EMPTY_SHADOW_KEYS,
    shadowCasterKeys(c),
  );
}

/**
 * Membership keys of capsule-ready casters. On the Deferred lane their
 * directional shadow comes from capsules, so directional views treat them as
 * owned without rasterizing them.
 */
function capsuleOwnedShadowKeys(c: _InternalRenderPipelineContext): ReadonlySet<string> {
  const membership = c.shadowCasterMembership;
  if (c.capsuleShadowDirectional !== true || membership === undefined) return EMPTY_SHADOW_KEYS;
  const lookup = shadowMembershipLookup(membership);
  const sources = shadowSourcesByRenderable(c.shadowValidatedOrdered ?? c.validatedOrdered);
  const owned = new Set<string>();
  for (let row = 0; row < membership.length; row++) {
    const key = lookup.keys[row];
    const entry = membership[row];
    if (key === undefined || entry === undefined) continue;
    if (sources.get(entry.renderableIndex)?.capsuleShadow?.status === 'ready') owned.add(key);
  }
  return owned;
}

function hasExpectedShadowCasters(c: _InternalRenderPipelineContext): boolean {
  if ((c.shadowCasterMembership?.length ?? 0) > 0) return true;
  if ((c.gpuDrivenShadowDrawKeys?.size ?? 0) > 0) return true;
  return shadowDispatchEntries(c).some((entry) => entry.tags.LightMode === 'ShadowCaster');
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
    shadowRasterState(projection.shadowRenderState, reflected),
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

function prepareGpuDrivenShadowIfPublished(
  c: _InternalRenderPipelineContext,
  identity: ShadowViewIdentity,
  viewBindGroup: BindGroup,
  reuseAdjacentShadow = false,
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
  const indirect = viewSubmission.view.indirectBuffer;
  const observed: Partial<{
    -readonly [K in keyof PreparedRasterBindings]: PreparedRasterBindings[K];
  }> = { view: viewBindGroup, materialOffset: 0 };
  if (indirect !== undefined) observed.indirect = indirect;
  // These physical inputs are fixed for the recording invocation. Resolve
  // the default opaque binding once, only if an opaque batch needs it.
  let opaqueMaterialGroup: BindGroup | null | undefined;
  let previousBatch: GpuDrivenBatch | undefined;
  let previousProjection: GpuDrivenShadowBatchProjection | undefined;
  let previousPipeline: RenderPipeline | undefined;
  let previousMaterial: MaterialBgAssemblyCacheEntry | undefined;
  let previousPipelineState: typeof c.pipelineState | undefined;
  let previousFallback: typeof c.pipelineState.skylightFallback | undefined;
  for (const batch of viewSubmission.plan.batches) {
    const projection: GpuDrivenShadowBatchProjection | undefined = projections.get(batch.batchId);
    if (projection === undefined) {
      throw new RhiError({
        code: 'internal-error',
        expected: `projected mesh binding for GPU-driven shadow batch ${batch.batchId}`,
        hint: 'keep shadow batch scene rows aligned with the shared SubmissionPlan',
      });
    }
    const shadowArtifact = projection.shadowArtifact;
    const shadowReceipt = shadowArtifact.receipt;
    if (shadowReceipt === undefined) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: `published shadow MaterialProgramAbi for batch ${batch.batchId}`,
        hint: 'keep the shadow draw out of the capable lane until its producer receipt is ready',
      });
    }
    // The stock Renderer graph captures shader/layout owners before recording.
    // Raw and custom calls retain every accessor and factory observation.
    // Artifact and geometry owners already publish immutable shader/layout
    // facts. Adjacent batches may differ only in resources or draw ranges;
    // keep their PSO locally without building another serialized request key.
    // The view kind and device capabilities are fixed for this invocation.
    let pipeline: RenderPipeline | null | undefined = previousPipeline;
    if (
      !reuseAdjacentShadow ||
      previousProjection === undefined ||
      previousBatch === undefined ||
      previousProjection.shadowArtifact !== shadowArtifact ||
      previousProjection.shadowRenderState !== projection.shadowRenderState ||
      previousProjection.shadowVertexEntry !== projection.shadowVertexEntry ||
      previousProjection.shadowFragmentEntry !== projection.shadowFragmentEntry ||
      previousProjection.deformation !== projection.deformation ||
      previousProjection.vertexColorAvailable !== projection.vertexColorAvailable ||
      previousProjection.material.standardTextureMask !== projection.material.standardTextureMask ||
      previousProjection.mesh.layoutProjection !== projection.mesh.layoutProjection ||
      previousBatch.key.admission !== batch.key.admission ||
      previousBatch.key.topology !== batch.key.topology ||
      previousBatch.key.drawKind !== batch.key.drawKind ||
      (batch.key.drawKind === 'indexed' &&
        previousProjection.mesh.indexFormat !== projection.mesh.indexFormat)
    ) {
      pipeline = requestGpuDrivenShadowPipeline(
        c,
        c.runtime.getMaterialShaderPipeline,
        projection,
        batch,
        identity.kind === 'point',
      );
    }
    if (pipeline === null || pipeline === undefined) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: `GPU-driven shadow pipeline variant for batch ${batch.batchId}`,
        hint: 'publish the exact scene-index shadow variant before entering the capable lane',
      });
    }
    if (batch.key.drawKind === 'indexed' && projection.mesh.indexBuffer === null) {
      throw new RhiError({
        code: 'internal-error',
        expected: `indexed mesh buffer for GPU-driven shadow batch ${batch.batchId}`,
        hint: 'keep the geometry residency and topology draw kind aligned before capable recording',
      });
    }
    let materialGroup: BindGroup | null;
    if (!reuseAdjacentShadow) {
      if (shadowArtifact.material !== SHADOW_CASTER_SHADER_ID) {
        materialGroup = ensureGpuDrivenCustomShadowMaterialBg(c, projection);
      } else if (
        batch.key.admission === 'alpha-mask' ||
        projection.material.authoredTextureFields?.has('displacementTexture')
      ) {
        materialGroup = ensureGpuDrivenAlphaMaskMaterialBg(c, projection);
      } else {
        opaqueMaterialGroup ??= ensureSpotShadowMaterialBg(c);
        materialGroup = opaqueMaterialGroup;
      }
    } else if (
      shadowArtifact.material !== SHADOW_CASTER_SHADER_ID ||
      batch.key.admission === 'alpha-mask' ||
      projection.material.authoredTextureFields?.has('displacementTexture')
    ) {
      // These immutable material/program facts select the same group for
      // adjacent batches. Keep the successful result only for this invocation;
      // later invocations still query the current artifact, schema and layout.
      // Logical texture sources can resolve a new physical view without a
      // material replacement, so they always visit the resource owner.
      const staticSources =
        (projection.material.textureSources?.size ?? 0) === 0 &&
        (projection.material.videoTextureFields?.size ?? 0) === 0;
      if (
        staticSources &&
        previousMaterial !== undefined &&
        previousProjection?.material === projection.material &&
        previousProjection.shadowArtifact === shadowArtifact &&
        previousBatch?.key.admission === batch.key.admission &&
        previousMaterial.materialResourceEpoch === c.store.materialResourceEpoch &&
        previousPipelineState === c.pipelineState &&
        previousFallback === c.pipelineState.skylightFallback &&
        previousMaterial.materialBuffer === c.pipelineState.materialUniformBuffer.buffer &&
        previousMaterial.sceneMaterialBuffer ===
          c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer
      ) {
        materialGroup = previousMaterial.bindGroup;
      } else {
        materialGroup =
          shadowArtifact.material !== SHADOW_CASTER_SHADER_ID
            ? ensureGpuDrivenCustomShadowMaterialBg(c, projection)
            : ensureGpuDrivenAlphaMaskMaterialBg(c, projection);
        const handle = staticSources ? projection.material.materialHandle : undefined;
        const shader = staticSources
          ? shadowArtifact.material !== SHADOW_CASTER_SHADER_ID
            ? (shadowArtifact.specializationKey ?? shadowArtifact.material)
            : 'forgeax::default-standard-pbr'
          : undefined;
        const worldIdentity = handle === undefined ? undefined : c.world.identity;
        const accepted = c.materialBgAssemblyCache.get(worldIdentity, handle, shader);
        // The builder can return a fallback after a failed asset upload. Only
        // its accepted cache entry proves complete residency; retry incomplete
        // bindings on the next batch without keeping a second readiness flag.
        previousMaterial =
          accepted?.bindGroup === materialGroup &&
          accepted.material === projection.material &&
          accepted.materialResourceEpoch === c.store.materialResourceEpoch
            ? accepted
            : undefined;
        previousPipelineState = c.pipelineState;
        previousFallback = c.pipelineState.skylightFallback;
      }
    } else {
      opaqueMaterialGroup ??= ensureSpotShadowMaterialBg(c);
      materialGroup = opaqueMaterialGroup;
    }
    if (materialGroup === null) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'material resources for every GPU shadow batch',
        hint: 'publish the shadow material binding before recording the indirect batch',
      });
    }
    previousBatch = batch;
    previousProjection = projection;
    previousPipeline = pipeline;
    observed.pipeline = pipeline;
    observed.material = materialGroup;
    observed.mesh = projection.meshBindGroup;
    observed.skin = projection.deformation === 'skin';
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
    const physical = observed as PreparedRasterBindings;
    bundles.push(viewSubmission.view.resolveShadowBundle(projection.bundles, physical));
  }
  if (indirect === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'GPU-driven shadow view indirect buffer',
      hint: 'publish a prepared view generation before recording a capable shadow pass',
    });
  return {
    view: viewSubmission.view,
    bundles,
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
  );
  if (submission === undefined) return undefined;
  if (submission.bundles.length > 0) submission.view.recordShadow(pass, submission.bundles);
  // executeBundles resets imperative state; the residual lane still consumes
  // this view and the caller's ordinary opaque material binding.
  pass.setBindGroup(0, viewBindGroup, [0, 0]);
  pass.setBindGroup(1, opaqueMaterialGroup, [0]);
  const viewKey = shadowViewIdentityKey(identity);
  const viewClaims = c.gpuDrivenShadowDrawKeysByView;
  return {
    claimedKeys:
      viewClaims === undefined
        ? (c.gpuDrivenShadowDrawKeys ?? EMPTY_SHADOW_KEYS)
        : (viewClaims.get(viewKey) ?? EMPTY_SHADOW_KEYS),
  };
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
    );
    if (submission !== undefined) submission.view.recordShadow(pass, submission.bundles);
  }
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
  drawFeatures?.(viewBg);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  const gpuRecord = recordGpuDrivenShadowIfPublished(
    c,
    pass,
    directionalIdentity,
    viewBg,
    materialBg,
    reuseAdjacentShadow,
  );
  const gpuRecorded = gpuRecord !== undefined;
  const capsuleKeys = capsuleOwnedShadowKeys(c);
  const claimedKeys =
    capsuleKeys.size === 0
      ? gpuRecord?.claimedKeys
      : new Set([...(gpuRecord?.claimedKeys ?? []), ...capsuleKeys]);
  if (capable && !gpuRecorded) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'capable directional GPU-driven shadow projection',
      hint: 'terminate the capable shadow frame instead of enumerating CPU casters',
    });
  }
  if (!hasUnclaimedShadowCasters(c, directionalIdentity, claimedKeys)) {
    if (gpuRecorded || (!capable && !hasExpectedShadowCasters(c))) {
      validateShadowOwnership(c, directionalIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
  }
  if (pipeline === null) {
    if (gpuRecorded && !hasUnclaimedShadowCasters(c, directionalIdentity, claimedKeys)) {
      validateShadowOwnership(c, directionalIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
    if (gpuRecorded) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'CPU residual directional shadow pipeline',
        hint: 'publish the legacy residual caster pipeline alongside the partial GPU shadow lane',
      });
    }
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'directional ShadowCaster pipeline',
      hint: 'publish the CPU ShadowCaster pipeline before recording residual casters',
    });
  }
  pass.setPipeline(pipeline);
  const legacyMeshBindGroup = c.meshBindGroup;
  if (legacyMeshBindGroup === null) {
    if (gpuRecorded && !hasUnclaimedShadowCasters(c, directionalIdentity, claimedKeys)) {
      validateShadowOwnership(c, directionalIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
    if (gpuRecorded) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'CPU residual directional shadow mesh binding',
        hint: 'publish legacy mesh resources for the unclaimed ShadowCaster residual',
      });
    }
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'directional ShadowCaster mesh binding',
      hint: 'publish the CPU mesh binding before recording residual casters',
    });
  }
  if (gpuRecorded) pass.setBindGroup(1, materialBg, [0]);
  const dispatchProjection = shadowResidualSelection(c, claimedKeys);
  const recordedKeys = recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    legacyMeshBindGroup,
    dispatchProjection.matchedIndices,
    dispatchProjection.matchedMaterialHandles,
    dispatchProjection.shaders,
    claimedKeys,
    false,
    c.shadowViewPlanesByView?.get(shadowViewIdentityKey(directionalIdentity)),
    c.capsuleShadowDirectional === true,
    terrainReceiver,
  );
  validateShadowOwnership(c, directionalIdentity, claimedKeys, recordedKeys);
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
  drawFeatures?.(viewBg);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  const gpuRecord = recordGpuDrivenShadowIfPublished(
    c,
    pass,
    pointIdentity,
    viewBg,
    materialBg,
    reuseAdjacentShadow,
  );
  const gpuRecorded = gpuRecord !== undefined;
  const claimedKeys = gpuRecord?.claimedKeys;
  if (capable && !gpuRecorded) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'capable point GPU-driven shadow projection',
      hint: 'terminate the capable shadow frame instead of enumerating CPU casters',
    });
  }
  if (!hasUnclaimedShadowCasters(c, pointIdentity, claimedKeys)) {
    if (gpuRecorded || (!capable && !hasExpectedShadowCasters(c))) {
      validateShadowOwnership(c, pointIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
  }
  if (pipeline === null) {
    if (gpuRecorded && !hasUnclaimedShadowCasters(c, pointIdentity, claimedKeys)) {
      validateShadowOwnership(c, pointIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
    if (gpuRecorded) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'CPU residual point shadow pipeline',
        hint: 'publish the legacy residual caster pipeline alongside the partial GPU shadow lane',
      });
    }
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'point ShadowCaster pipeline',
      hint: 'publish the CPU ShadowCaster pipeline before recording residual casters',
    });
  }
  pass.setPipeline(pipeline);
  const legacyMeshBindGroup = c.meshBindGroup;
  if (legacyMeshBindGroup === null) {
    if (gpuRecorded && !hasUnclaimedShadowCasters(c, pointIdentity, claimedKeys)) {
      validateShadowOwnership(c, pointIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
    if (gpuRecorded) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'CPU residual point shadow mesh binding',
        hint: 'publish legacy mesh resources for the unclaimed ShadowCaster residual',
      });
    }
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'point ShadowCaster mesh binding',
      hint: 'publish the CPU mesh binding before recording residual casters',
    });
  }
  if (gpuRecorded) pass.setBindGroup(1, materialBg, [0]);
  const dispatchProjection = shadowResidualSelection(c, claimedKeys);
  const recordedKeys = recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    legacyMeshBindGroup,
    dispatchProjection.matchedIndices,
    dispatchProjection.matchedMaterialHandles,
    dispatchProjection.shaders,
    claimedKeys,
    true,
    c.shadowViewPlanesByView?.get(shadowViewIdentityKey(pointIdentity)),
  );
  validateShadowOwnership(c, pointIdentity, claimedKeys, recordedKeys);
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
  drawFeatures?.(viewBg);
  pass.setBindGroup(0, viewBg, [0, 0]);
  pass.setBindGroup(1, materialBg, [0]);
  // Reuse the shared caster recorder. The compact spot-only loop used to
  // depend on instance bindings created by a directional pass, so a scene
  // containing only a SpotLight opened the atlas pass but emitted no caster
  // draws.
  const gpuRecord = recordGpuDrivenShadowIfPublished(
    c,
    pass,
    spotIdentity,
    viewBg,
    materialBg,
    reuseAdjacentShadow,
  );
  const gpuRecorded = gpuRecord !== undefined;
  const claimedKeys = gpuRecord?.claimedKeys;
  if (capable && !gpuRecorded) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'capable spot GPU-driven shadow projection',
      hint: 'terminate the capable shadow frame instead of enumerating CPU casters',
    });
  }
  if (!hasUnclaimedShadowCasters(c, spotIdentity, claimedKeys)) {
    if (gpuRecorded || (!capable && !hasExpectedShadowCasters(c))) {
      validateShadowOwnership(c, spotIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
  }
  if (pipeline === null) {
    if (gpuRecorded && !hasUnclaimedShadowCasters(c, spotIdentity, claimedKeys)) {
      validateShadowOwnership(c, spotIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
    if (gpuRecorded) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'CPU residual spot shadow pipeline',
        hint: 'publish the legacy residual caster pipeline alongside the partial GPU shadow lane',
      });
    }
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'spot ShadowCaster pipeline',
      hint: 'publish the CPU ShadowCaster pipeline before recording residual casters',
    });
  }
  pass.setPipeline(pipeline);
  const legacyMeshBindGroup = c.meshBindGroup;
  if (legacyMeshBindGroup === null) {
    if (gpuRecorded && !hasUnclaimedShadowCasters(c, spotIdentity, claimedKeys)) {
      validateShadowOwnership(c, spotIdentity, claimedKeys, EMPTY_SHADOW_KEYS);
      return;
    }
    if (gpuRecorded) {
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'CPU residual spot shadow mesh binding',
        hint: 'publish legacy mesh resources for the unclaimed ShadowCaster residual',
      });
    }
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'spot ShadowCaster mesh binding',
      hint: 'publish the CPU mesh binding before recording residual casters',
    });
  }
  if (gpuRecorded) pass.setBindGroup(1, materialBg, [0]);
  const dispatchProjection = shadowResidualSelection(c, claimedKeys);
  const recordedKeys = recordShadowCasterDraws(
    c,
    pass,
    pipeline,
    legacyMeshBindGroup,
    dispatchProjection.matchedIndices,
    dispatchProjection.matchedMaterialHandles,
    dispatchProjection.shaders,
    claimedKeys,
    false,
    c.shadowViewPlanesByView?.get(shadowViewIdentityKey(spotIdentity)),
  );
  validateShadowOwnership(c, spotIdentity, claimedKeys, recordedKeys);
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
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): readonly DispatchEntry[] {
  if (Object.keys(selector).length === 0) return dispatch;
  return dispatch.filter((e) => matchPass(e.tags, selector));
}

/**
 * feat-20260609 M2: build a set of renderable indices whose dispatch entries
 * match the given selector.  Used by the record pass closures to skip entities
 * that do not belong to the current pass.
 *
 * Returns null when the dispatch array is empty (no dispatch-based filtering
 * to apply — draw all entities).  Returns an empty set when dispatch is
 * non-empty but no entries matched (draw nothing).  Returns a populated set
 * when at least one dispatch entry matched.
 */
export function buildMatchedRenderableIndices(
  dispatch: readonly DispatchEntry[],
  selector: PassSelector,
): Set<number> | null {
  // PRODUCTION INVARIANT: in real frames extractFrame always populates
  // dispatch[] for every visible renderable (Forward + ShadowCaster tags
  // emitted per validated entity, including the default-material handle=0
  // path — see render-system-extract.ts default-material dispatch emission).
  // The empty-dispatch null fallback below exists ONLY for unit-test
  // fixtures that mock dispatch out (early w-* tests written before
  // dispatch existed). Returning null causes the downstream loop to skip
  // selector filtering, preserving back-compat for those fixtures. If a
  // future refactor moves dispatch population earlier or makes it
  // conditional, the test fixtures should be updated rather than this
  // fallback widened to production.
  if (dispatch.length === 0) return null;
  const filtered = filterDispatchBySelector(dispatch, selector);
  const set = new Set<number>();
  for (const e of filtered) {
    set.add(e.renderableIndex);
  }
  return set;
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
  dispatch: readonly DispatchEntry[],
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

/**
 * feat-20260704 M3/w20: per-entity directional shadow-caster draw loop,
 * extracted verbatim from {@link encodeDirectionalShadowPass}. Walks `c.validatedOrdered`,
 * selects the per-entity shadow PSO (default vertex-only caster or a custom
 * cutout caster), binds the per-entity mesh dynamic-offset + instance buffer,
 * and issues the per-submesh depth draws. `shadowPass` view/material bind
 * groups (@group 0/1) are already set by the caller; this loop owns @group
 * 2/3 + the vertex/index/pipeline de-dup state. Receives the explicit
 * `_InternalRenderPipelineContext` (`c`) plus the caller-resolved
 * mesh bind group, pass-selector match set, and per-material
 * ShadowCaster dispatch map so no cross-function mutable state is introduced.
 */
/** The request is shared by hidden preparation and the real ShadowCaster draw. */
function resolveShadowMaterialPipeline(
  c: _InternalRenderPipelineContext,
  entry: ValidatedRenderable,
  topology: import('@forgeax/engine-types').PrimitiveTopology,
  submeshMaterial: MaterialSnapshot,
  shadowDispatch:
    | Pick<
        DispatchEntry,
        'materialShaderId' | 'renderState' | 'vertexEntry' | 'fragmentEntry' | 'paramSnapshot'
      >
    | undefined,
  reflected: boolean,
  receiver: boolean,
  preparation = false,
): RenderPipeline | null {
  const entryShadowShaderId = shadowDispatch?.materialShaderId;
  const entryShadowRenderState = shadowRasterState(
    receiver ? { ...shadowDispatch?.renderState, cullMode: 'front' } : shadowDispatch?.renderState,
    reflected,
  );
  const skinned = entry.source.skin !== undefined;
  return (
    (preparation
      ? (c.runtime.prepareMaterialShaderPipeline ?? c.runtime.getMaterialShaderPipeline)
      : c.runtime.getMaterialShaderPipeline)?.(
      entryShadowShaderId ?? SHADOW_CASTER_SHADER_ID,
      false,
      entryShadowRenderState,
      topology,
      entry.mesh.indexFormat,
      shadowCasterVariantSet(
        c.runtime.device.caps.storageBuffer,
        skinned,
        false,
        Number(shadowDispatch?.paramSnapshot?.alphaCutoff ?? 0) > 0 ||
          Number(shadowDispatch?.paramSnapshot?.alphaHash ?? 0) > 0.5,
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
      preparation ||
        entryShadowShaderId === undefined ||
        entryShadowShaderId === SHADOW_CASTER_SHADER_ID
        ? 'validated'
        : 'immediate',
      skinned ? 'pbr-skin' : 'pbr',
      undefined, // vertexEntryPoint
      undefined, // additionalColorFormats
      shadowDispatch?.vertexEntry,
      shadowDispatch?.fragmentEntry,
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
  const shadowArtifacts = c.gpuDrivenShadowPreparationArtifacts;
  // Only actual declared shadow view kinds participate. Hidden rows stay outside
  // the scene/culling lists, but their accepted receipt owns the future native PSO.
  const views = c.gpuDrivenShadowViews?.inspect() ?? [];
  const reflections = new Set(views.map((view) => view.identity.kind === 'point'));
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
        c.frameState.pipelinePreparationPending = true;
      } else {
        preparedBatches?.set(batch.batchId, { projection, key: batch.key, reflected });
      }
    }
  }
  if (
    c.runtime.prepareMaterialShaderPipeline !== undefined &&
    shadowArtifacts !== undefined &&
    reflections.size > 0
  ) {
    for (const entry of c.pipelinePreparationEntries ?? []) {
      if (entry.source.authorVisible !== false) continue;
      for (const draw of eligibleGpuDrivenDraws(entry.source)) {
        const prepared = draw.prepared;
        if (prepared === undefined) continue;
        const material = entry.source.materials[draw.key.materialSlot] ?? entry.source.material;
        const artifactKey =
          capturedPreparedMaterialArtifactKey(prepared) ??
          gpuDrivenMaterialArtifactKey({
            material: prepared.identity.material,
            deformation: prepared.identity.deformation,
            receiptIdentity: prepared.receiptIdentity,
            receiptGeneration: prepared.receiptGeneration,
          });
        const passes =
          entry.source.pipelinePreparation?.filter(
            (pass) =>
              pass.tags.LightMode === 'ShadowCaster' &&
              pass.materialHandle === (material.materialHandle ?? 0),
          ) ?? [];
        const sourceDraw = entry.source.gpuDrivenDraws?.find(
          (candidate, index) => (candidate.drawItemIndex ?? index) === draw.sourceDrawIndex,
        );
        if (
          shadowCasterCpuReason(
            material,
            sourceDraw,
            passes,
            entry.source.morph,
            entry.source.skin,
          ) !== undefined
        )
          continue;
        for (const pass of passes) {
          const artifact = shadowArtifacts.get(artifactKey);
          if (artifact === undefined) {
            c.frameState.pipelinePreparationPending = true;
            continue;
          }
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
                  ...(pass.renderState === undefined
                    ? {}
                    : { shadowRenderState: pass.renderState }),
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
              c.frameState.pipelinePreparationPending = true;
          }
        }
      }
    }
  }
  for (const entry of c.pipelinePreparationEntries ?? []) {
    for (const sm of entry.mesh.submeshes) {
      const material = entry.source.materials[sm.materialSlot] ?? entry.source.material;
      for (const pass of entry.source.pipelinePreparation ?? []) {
        if (
          pass.tags.LightMode !== 'ShadowCaster' ||
          pass.materialHandle !== (material.materialHandle ?? 0)
        )
          continue;
        if (
          resolveShadowMaterialPipeline(
            c,
            entry,
            sm.topology,
            material,
            pass,
            false,
            false,
            true,
          ) === null
        )
          c.frameState.pipelinePreparationPending = true;
      }
    }
  }
}

export function recordShadowCasterDraws(
  c: _InternalRenderPipelineContext,
  shadowPass: RhiRenderPassEncoder,
  shadowPipeline: RenderPipeline,
  shadowMeshBindGroup: BindGroup,
  matchedIndices: Set<number> | null,
  matchedMaterialHandles: ReadonlyMap<number, ReadonlySet<number>> | null,
  shadowDispatchByRenderableIdx: ShadowDispatchMap,
  gpuDrivenShadowDrawKeys: ReadonlySet<string> | undefined,
  reflected = false,
  viewPlanes?: Float32Array,
  skipCapsuleReady = false,
  terrainReceiver?: import('../terrain/shadow-family').TerrainShadowReceiver,
): ReadonlySet<string> {
  const {
    runtime,
    pipelineState,
    validatedOrdered: mainValidatedOrdered,
    shadowValidatedOrdered,
  } = c;
  const validatedOrdered = shadowValidatedOrdered ?? mainValidatedOrdered;
  const meshSsboBase = c.shadowMeshSsboBase ?? 0;
  // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer
  // (the wrapper) -- the de-dup compare uses wrapper identity (one wrapper
  // per RHI handle from gpuStore), and `.handle` is passed to the RHI
  // setVertexBuffer / setIndexBuffer call.
  let shadowLastVertexBuffer: GpuBuffer | null = null;
  let shadowLastIndexBuffer: GpuBuffer | null = null;
  const recordedKeys = new Set<string>();
  // bug-20260619-csm RC-3 (D-3): track the currently-bound shadow PSO so
  // per-entity setPipeline only fires on change (same de-dup discipline as
  // vertex/index buffers above). The default-shadow-caster PSO is already
  // bound by the setPipeline call above; the loop switches to a custom
  // ShadowCaster PSO when a material supplies one.
  let shadowLastPipeline: RenderPipeline = shadowPipeline;
  let materialDeps: PerSubmeshMaterialBgDeps | undefined;
  const preparedCasters = c.shadowDispatchProjection?.casters(c);
  const identityInstanceDraws = [{ buffer: pipelineState.identityInstanceBuffer, count: 1 }];

  for (let i = 0; i < validatedOrdered.length; i++) {
    const entry = validatedOrdered[i];
    if (entry === undefined) continue;
    if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;
    if (skipCapsuleReady && entry.source.capsuleShadow?.status === 'ready') continue;
    if (!shadowViewContains(entry.source, viewPlanes, c.shadowCasterBounds)) continue;

    let prepared = preparedCasters?.[i];
    if (preparedCasters !== undefined && prepared?.entry !== entry) {
      prepared = { entry, pipelines: [] };
      preparedCasters[i] = prepared;
    }
    const submeshes = entry.mesh.submeshes;
    const draws = entry.source.gpuDrivenDraws;
    const ordered = draws?.every(
      (draw, index) =>
        draw.drawItemIndex !== undefined &&
        (index === 0 || (draws[index - 1]?.drawItemIndex ?? Infinity) <= draw.drawItemIndex),
    );
    const stable = ordered || draws?.some((draw) => draw.drawItemIndex !== undefined);
    const handles = matchedMaterialHandles?.get(entry.renderableIndex);
    let nonIndexedFirst = 0,
      drawCursor = 0;
    let shadowInstanceDraws:
      | readonly { readonly buffer: Buffer; readonly count: number }[]
      | undefined;
    for (let submeshIndex = 0; submeshIndex < submeshes.length; submeshIndex++) {
      const submesh = submeshes[submeshIndex];
      if (submesh === undefined) continue;
      let compactDrawIndex: number | undefined;
      if (stable && draws !== undefined)
        compactDrawIndex = shadowCompactDrawIndex(draws, submeshIndex, ordered === true);
      else {
        // Legacy publications match compact geometry in source order.
        const first = entry.mesh.indexed ? submesh.indexOffset : nonIndexedFirst;
        const count = entry.mesh.indexed ? submesh.indexCount : submesh.vertexCount;
        const draw = draws?.[drawCursor];
        if (
          draw !== undefined &&
          draw.first === first &&
          draw.count === count &&
          draw.materialSlot === submesh.materialSlot &&
          draw.topology === submesh.topology
        )
          compactDrawIndex = drawCursor++;
      }
      if (!entry.mesh.indexed) nonIndexedFirst += submesh.vertexCount;
      if (!isTriangleTopology(submesh.topology)) continue;
      if (matchedMaterialHandles !== null) {
        const material = entry.source.materials[submesh.materialSlot] ?? entry.source.material;
        if (handles === undefined || !handles.has(material.materialHandle ?? -1)) continue;
      }
      if (
        isGpuShadowClaimedSubmesh(
          entry.source,
          entry.renderableIndex,
          compactDrawIndex,
          gpuDrivenShadowDrawKeys,
          shadowDispatchByRenderableIdx,
          c.shadowCasterMembership,
          c.shadowCasterWorldKeys,
        )
      )
        continue;
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

        if (entry.source.skin !== undefined) {
          const skinMeshBindGroup = skinnedShadowMeshBindGroup(
            c,
            entry,
            (meshSsboBase + i) * MESH_PER_ENTITY_STRIDE,
          );
          if (skinMeshBindGroup === null) {
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'CPU skinned ShadowCaster mesh binding',
              hint: 'publish the skin mesh/palette bind group before recording the residual',
            });
          }
          shadowPass.setBindGroup(
            2,
            skinMeshBindGroup,
            pbrSkinMeshDynamicOffsets(
              meshSsboBufferBinding(
                pipelineState.meshStorageBuffer,
                (meshSsboBase + i) * MESH_PER_ENTITY_STRIDE,
              ).byteOffset,
              entry.source.skin.byteOffset,
            ),
          );
        } else {
          const meshOffset = (meshSsboBase + i) * MESH_PER_ENTITY_STRIDE;
          const group =
            pipelineState.meshStorageBuffer.pages === undefined
              ? shadowMeshBindGroup
              : meshSlotBindGroup(
                  runtime.device,
                  c.frameState,
                  pipelineState,
                  c.bindGroupCounts,
                  meshOffset,
                );
          shadowPass.setBindGroup(2, group, [
            meshSsboBufferBinding(pipelineState.meshStorageBuffer, meshOffset).byteOffset,
          ]);
        }

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
      const submeshMaterial = entry.source.materials[sm.materialSlot] ?? entry.source.material;
      const shadowDispatches =
        shadowDispatchByRenderableIdx
          .get(entry.renderableIndex)
          ?.get(submeshMaterial.materialHandle ?? 0) ?? [];
      const draw =
        compactDrawIndex === undefined
          ? undefined
          : entry.source.gpuDrivenDraws?.[compactDrawIndex];
      const drawItemIndex = draw?.drawItemIndex ?? compactDrawIndex ?? submeshIndex;
      const physicalRange = entry.mesh.lodRanges?.[0]?.[submeshIndex];
      const worldEntity = worldEntityKey(
        c.shadowCasterWorldKeys?.[entry.source.worldId] ?? entry.source.worldId,
        entry.source.entityKey,
      );
      if (gpuDrivenShadowDrawKeys !== undefined && shadowDispatches.length === 0) continue;
      const passes = shadowDispatches.length === 0 ? DEFAULT_SHADOW_DISPATCH : shadowDispatches;
      // Deformation selects the mesh/palette layout, never the material program.
      // Each residual keeps its authored shader, entries, state and bindings.
      for (const shadowDispatch of passes) {
        const shadowKey =
          shadowDispatch === undefined
            ? undefined
            : gpuDrivenShadowDrawKey(
                worldEntity,
                submeshMaterial.materialHandle ?? -1,
                drawItemIndex,
                shadowDispatch.passIndex,
              );
        if (shadowKey !== undefined && gpuDrivenShadowDrawKeys?.has(shadowKey)) continue;
        const entryShadowShaderId = shadowDispatch?.materialShaderId;
        const receiver =
          terrainReceiver !== undefined &&
          entry.source.terrain !== undefined &&
          entry.source.worldId === terrainReceiver.worldId &&
          entry.source.entityKey === terrainReceiver.entityKey;
        const skinned = entry.source.skin !== undefined;
        let entryShadowPipeline: RenderPipeline | null = shadowPipeline;
        const needsDedicatedPipeline =
          shadowDispatch !== undefined || skinned || sm.topology !== 'triangle-list';
        if (shadowDispatch !== undefined && entryShadowShaderId === undefined) {
          throw new RhiError({
            code: 'rhi-not-available',
            expected: 'material shader identity for CPU ShadowCaster residual',
            hint: 'publish a producer-owned ShadowCaster shader identity before recording the residual',
          });
        }
        if (needsDedicatedPipeline) {
          const cached = prepared?.pipelines[submeshIndex]?.find(
            (candidate) =>
              candidate.passIndex === shadowDispatch?.passIndex &&
              candidate.reflected === reflected &&
              candidate.terrainReceiver === receiver,
          );
          entryShadowPipeline =
            cached?.pipeline ??
            resolveShadowMaterialPipeline(
              c,
              entry,
              sm.topology,
              submeshMaterial,
              shadowDispatch,
              reflected,
              receiver,
            ) ??
            null;
          if (cached === undefined && entryShadowPipeline !== null && prepared !== undefined) {
            const pipelines = prepared.pipelines[submeshIndex] ?? [];
            prepared.pipelines[submeshIndex] = pipelines;
            pipelines.push({
              passIndex: shadowDispatch?.passIndex,
              reflected,
              terrainReceiver: receiver,
              pipeline: entryShadowPipeline,
            });
          }
        }
        if (entryShadowPipeline === null) {
          throw new RhiError({
            code: 'rhi-not-available',
            expected: `CPU ShadowCaster pipeline ${entryShadowShaderId ?? '<missing>'}`,
            hint: 'publish the exact residual ShadowCaster pipeline; do not substitute the default shader',
          });
        }
        if (entryShadowPipeline !== shadowLastPipeline && entryShadowPipeline !== null) {
          shadowPass.setPipeline(entryShadowPipeline);
          shadowLastPipeline = entryShadowPipeline;
        }
        if (shadowDispatch !== undefined && entryShadowShaderId !== undefined) {
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
            shadowDispatch?.materialSlot ??
            c.materialSlotIndices[i]?.[sm.materialSlot] ??
            c.materialSlotIndices[i]?.[0];
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
              materialSlot * MATERIAL_PER_ENTITY_STRIDE,
            ).byteOffset,
          ]);
        } else {
          const materialGroup = ensureSpotShadowMaterialBg(c);
          if (materialGroup === null) {
            throw new RhiError({
              code: 'rhi-not-available',
              expected: 'CPU residual shadow material bind group',
              hint: 'publish the residual material resources before recording shadows',
            });
          }
          shadowPass.setBindGroup(1, materialGroup, [0]);
        }
        for (const instanceDraw of shadowInstanceDraws) {
          const shadowInstancesBg = resolveGeometryInstancesBindGroup(c, instanceDraw.buffer);
          shadowPass.setBindGroup(3, shadowInstancesBg);
          if (entry.mesh.indexed) {
            shadowPass.drawIndexed(
              physicalRange?.count ?? sm.indexCount,
              instanceDraw.count,
              physicalRange?.first ?? sm.indexOffset,
              physicalRange?.baseVertex ?? 0,
              0,
            );
          } else {
            shadowPass.draw(sm.vertexCount, instanceDraw.count, 0, 0);
          }
        }
        if (shadowKey !== undefined) recordedKeys.add(shadowKey);
      }
    }
  }
  return recordedKeys;
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
    projection.materialEntityKey,
    c.world,
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
    projection.materialEntityKey,
    c.world,
    shaderId,
  );
  return bindGroup;
}
