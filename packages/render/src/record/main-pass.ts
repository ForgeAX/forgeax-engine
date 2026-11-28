import { probeVideoHighPerfUpload } from '@forgeax/engine-graphics-extras';
import type { GraphResourceResolver, GraphTextureView } from '@forgeax/engine-render-graph';
import {
  type Buffer,
  type RenderBundleEncoderDescriptor,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import type {
  MaterialSurfacePassKind,
  MeshAsset,
  PassKind,
  PassSelector,
} from '@forgeax/engine-types';
import { waterBodyOwnerKey } from '@forgeax/engine-water';
import { prepareMorphGeometryPipeline } from '../device/morph-geometry';
import { viewWithSkylight } from '../environment/bindings';
import { atmosphereStoragePinned, currentAtmosphereStorage } from '../environment/storage';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { RendererContractFailureError } from '../errors/render';
import type { EnvironmentSource } from '../extract/environment';
import { renderFeatureViewIdentity } from '../features/view';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { isCanonicalStandardPbrMaterialShader, materialLayoutSlotKey } from '../pbr-pipeline';
import { standardTopologyBindGroupReady } from '../pipeline-spec';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderRecordPhase } from '../render-contract';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type { DispatchList, MaterialSnapshot } from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type { FrameList } from '../scene/frame-list';
import { materialPasses } from '../scene/material-dispatch';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
  matchPass,
} from '../systems/pass-selector';
import {
  EMPTY_WATER_CLOSURE,
  isOwnedWaterMeshAdmissionUploadClosure,
  type WaterMaterialAdmissionDraw,
  type WaterMaterialAdmissionDrawClosure,
  waterMeshAdmissionUpload,
} from '../water/mesh-source-admission';
import { type WaterMaterialFrameBindings, waterMaterialDrawBinding } from '../water/wave-material';
import { recordContext } from '../world/view-record-context';
import { FirstEntryMap } from './first-entry-map';
import { materialSlotsByClass } from './fold-buckets';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';
import { getOpaqueResourceIdentity } from './frame-snapshot';
import {
  type GeometryPipelinePreparationContext,
  geometryPipelineRequestContext,
  prepareGeometryPipelineRequests,
} from './geometry-pipeline-requests';
import type { GraphBindingViews } from './graph-binding-views';
import { IblBindingObservation } from './ibl-binding-observation';
import {
  recordGeometryDraws,
  recordIblPipelineBinding,
  requestVisibleMeshPipelines,
} from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg,
  type MainPassMaterialBinding,
  type MainPassMaterialBindingResolver,
  type MaterialBindingAddress,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import { recordSpritePass } from './main-pass-sprite-draws';
import type {
  MaterialHandles,
  MaterialPassLookup,
  MaterialSelectionRows,
} from './material-pass-groups';
import {
  isSurfaceRecordMode,
  type MaterialRecordMode,
  matchesRecordMode,
  materialMatchesPass,
  waterRecordPass,
} from './material-pass-selection';
import { reflectionProbeMaterial } from './reflection-probe-material';
import type {
  _InternalRenderPipelineContext,
  RenderSystemInternals,
  WaterMaterialRecordCacheCandidate,
} from './render-context';
import { MATERIAL_UNIFORM_BYTES } from './render-context';
import { buildMatchedMaterialHandlesByRenderable, filterDispatchBySelector } from './shadow-pass';
import { SingleMaterialHandleSet } from './single-material-handle-set';
import { selectForwardFragmentEntry } from './standard-opaque-entry';

export type MainPassOptions = {
  readonly preparedSkylight?: ReturnType<typeof prepareMaterialSkylight> | undefined;
  readonly materialGraphViews?: GraphBindingViews;
  readonly materialSceneDepth?: TextureView;
  readonly bundleDescriptor?: RenderBundleEncoderDescriptor;
  readonly sampleCount?: number;
  readonly selection?: { readonly entities: readonly number[] };
  readonly colorFormats?: readonly GPUTextureFormat[];
  readonly passKind?: PassKind;
  readonly recordMode?: MaterialRecordMode;
  readonly gpuDrivenFilter?: RenderPipelineGpuDrivenFilter;
  /** Write transparent fragment depth for depth-bounded medium transport. */
  readonly transparentDepthWrite?: boolean;
  /** This pass shades the main opaque prepass's exact depth projection. */
  readonly opaqueDepthPrimed?: boolean;
  /** Exclude material/pass pairs already consumed by an earlier graph lane. */
  readonly excludeSelector?: PassSelector;
  readonly transmissionBackdropView?: TextureView | null;
  /** Independent sampled raw depth produced before the medium passes. */
  readonly surfaceRawDepthView?: TextureView | null;
  /** Nearest-layer color produced by the preceding medium pass. */
  readonly surfaceNearestLayerView?: TextureView | null;
  /** Nearest-layer depth produced by the preceding medium pass. */
  readonly surfaceNearestDepthView?: TextureView | null;
  /** Sampled FoamRT resolved from the Water graph for this pass. */
  readonly surfaceFoamSimulationView?: TextureView | null;
  readonly surfaceFluidSimulation?: { readonly fields: TextureView; readonly descriptors: Buffer };
  /** Graph-owned WaterInfo arrays sampled by water materials in this pass. */
  readonly waterFrame?: {
    readonly resources: GraphResourceResolver;
    readonly targets: ReadonlyMap<
      string,
      Readonly<{ view: GraphTextureView; format: import('@forgeax/engine-rhi').TextureFormat }>
    >;
  };
  /** Surface shader fragment entry selected by the typed pass owner. */
  readonly fragmentEntryPoint?: string;
  /** Select the material temporal entry's binary coverage output. */
  readonly coverageOnly?: boolean;
  /** The loaded depth is the exact prepass raster of this pass's opaque draws. */
  readonly seededDepth?: boolean;
  readonly gpuDriven?: {
    readonly projection: RenderPipelineGpuDrivenProjection;
    readonly resources: GraphResourceResolver;
    /** `late` re-enters the pass for HZB-revealed GPU items only. */
    readonly phase?: GpuDrivenDrawPhase;
  };
};

/** GPU membership is a shared material fact, independent of instance rows. */
export function selectGpuMaterialSlots(
  materials: readonly MaterialSnapshot[],
  selector: PassSelector | undefined,
  mode: MainPassOptions['recordMode'],
  excludeSelector?: PassSelector,
): ReadonlySet<number> | undefined {
  if (selector === undefined && mode === undefined && excludeSelector === undefined)
    return undefined;
  const selected = new Set<number>();
  let candidate:
    | { snapshot: MaterialSnapshot; passes: ReturnType<typeof materialPasses> }
    | undefined;
  for (let slot = 0; slot < materials.length; slot++) {
    const snapshot = materials[slot];
    if (snapshot === undefined || (mode !== undefined && !matchesRecordMode(snapshot, mode)))
      continue;
    const passes = materialPasses(snapshot);
    if (candidate === undefined) candidate = { snapshot, passes };
    else {
      candidate.snapshot = snapshot;
      candidate.passes = passes;
    }
    if (materialMatchesPass(candidate, selector, mode, excludeSelector)) selected.add(slot);
  }
  return selected;
}

/** Membership of the Standard transparent set (sorted or weighted blended). */
export function isTransparentLaneMaterial(material: MaterialSnapshot): boolean {
  return matchesRecordMode(material, 'transparent');
}

/** Exclusion is material-wide, just like buildMatchedMaterialHandlesByRenderable. */
function preparationMaterialExcluded(
  entry: ValidatedRenderable,
  materialHandle: number,
  selector: PassSelector | undefined,
): boolean {
  return (
    selector !== undefined &&
    (entry.source.pipelinePreparation ?? []).some(
      (pass) => pass.materialHandle === materialHandle && matchPass(pass.tags, selector),
    )
  );
}

function preparationSubmeshExcluded(
  entry: ValidatedRenderable,
  index: number,
  selector: PassSelector | undefined,
): boolean {
  if (selector === undefined) return false;
  const submesh = entry.mesh.submeshes[index];
  if (submesh === undefined) return true;
  return preparationMaterialExcluded(
    entry,
    (entry.source.materials[submesh.materialSlot] ?? entry.source.material).snapshot
      .materialHandle ?? 0,
    selector,
  );
}

/** Explicit preparation is work even when no visible draw selects this lane. */
export function hasMainPassPipelinePreparation(
  c: Pick<_InternalRenderPipelineContext, 'pipelinePreparationEntries' | 'materialFrame'>,
  selector: PassSelector,
  mode: MainPassOptions['recordMode'],
  excludeSelector?: PassSelector,
): boolean {
  for (const entry of c.pipelinePreparationEntries ?? [])
    if (entryHasPipelinePreparation(c, entry, selector, mode, excludeSelector)) return true;
  return false;
}

function entryHasPipelinePreparation(
  c: Pick<_InternalRenderPipelineContext, 'materialFrame'>,
  entry: ValidatedRenderable,
  selector: PassSelector,
  mode: MainPassOptions['recordMode'],
  excludeSelector?: PassSelector,
  skipDraw?: (entry: ValidatedRenderable, submeshIndex: number) => boolean,
): boolean {
  let index = 0;
  for (const sm of entry.mesh.submeshes) {
    if (skipDraw?.(entry, index++)) continue;
    const material = c.materialFrame?.get(
      entry.source.materials[sm.materialSlot] ?? entry.source.material,
    )?.snapshot;
    if (material === undefined) throw new Error('Pipeline preparation has no accepted material');
    if (
      (mode !== undefined && !matchesRecordMode(material, mode)) ||
      preparationMaterialExcluded(entry, material.materialHandle ?? 0, excludeSelector)
    )
      continue;
    for (const pass of entry.source.pipelinePreparation ?? [])
      if (pass.materialHandle === (material.materialHandle ?? 0) && matchPass(pass.tags, selector))
        return true;
  }
  return false;
}

/** Prepare deformation only for explicit rows selected by this actual scene pass. */
export function prepareMainPassGeometryPipelines(
  c: _InternalRenderPipelineContext,
  selector: PassSelector,
  options: {
    readonly recordMode?: MainPassOptions['recordMode'];
    readonly excludeSelector?: PassSelector | undefined;
  },
  entries = c.pipelinePreparationEntries,
  skipDraw?: (entry: ValidatedRenderable, submeshIndex: number) => boolean,
): void {
  for (const entry of entries ?? []) {
    if (
      !entryHasPipelinePreparation(
        c,
        entry,
        selector,
        options.recordMode,
        options.excludeSelector,
        skipDraw,
      )
    )
      continue;
    const handle = entry.source.assetHandle;
    const asset =
      handle === undefined ? undefined : (entry.world ?? c.world).resolveAsset<MeshAsset>(handle);
    // Idle morph weights deliberately have no MorphSnapshot. Use admitted Mesh metadata.
    if (
      entry.source.morph === undefined &&
      !(asset?.ok === true && (asset.value.morphTargets?.length ?? 0) > 0)
    )
      continue;
    if (!prepareMorphGeometryPipeline(c.runtime, c.store.morphGeometry))
      markPipelinePreparationPending(c.frameState, {
        code: 'scene-pipeline-preparation',
        entity: entry.source.entityKey,
        shader: 'morph-geometry',
      });
    // All selected meshes share this one device-owned utility pipeline.
    return;
  }
}

/** Prepare an otherwise empty graph lane without opening its attachments. */
export function prepareMainPassPipelines(
  c: _InternalRenderPipelineContext,
  selector: PassSelector,
  options: MainPassOptions,
  sampleCount: number,
  colorFormats: readonly GPUTextureFormat[],
  skipDraw?: (entry: ValidatedRenderable, submeshIndex: number) => boolean,
): void {
  prepareMainPassGeometryPipelines(c, selector, options, c.pipelinePreparationEntries, skipDraw);
  prepareMainPassPipelineDemand(
    {
      ...geometryPipelineRequestContext(c),
      frameState: c.frameState,
      ...(c.materialFrame === undefined ? {} : { materialFrame: c.materialFrame }),
      ...(c.pipelinePreparationEntries === undefined
        ? {}
        : { pipelinePreparationEntries: c.pipelinePreparationEntries }),
      tonemapActive: c.tonemapActive,
      ...(c.viewBindGroupDynamicOffset === undefined
        ? {}
        : { viewBindGroupDynamicOffset: c.viewBindGroupDynamicOffset }),
    },
    selector,
    options,
    sampleCount,
    colorFormats,
    skipDraw,
  );
}

export function prepareMainPassPipelineDemand(
  c: GeometryPipelinePreparationContext &
    Pick<_InternalRenderPipelineContext, 'tonemapActive' | 'viewBindGroupDynamicOffset'>,
  selector: PassSelector,
  options: MainPassOptions,
  sampleCount: number,
  colorFormats: readonly GPUTextureFormat[],
  skipDraw?: (entry: ValidatedRenderable, submeshIndex: number) => boolean,
): void {
  if (!hasMainPassPipelinePreparation(c, selector, options.recordMode, options.excludeSelector))
    return;
  const mode = options.recordMode;
  const surfacePass = surfacePassForRecordMode(mode);
  const blended = mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual';
  prepareGeometryPipelineRequests(
    {
      ...c,
      ...(colorFormats[0] === undefined ? {} : { transparentColorFormat: colorFormats[0] }),
      translucentFog: blended && (c.viewBindGroupDynamicOffset ?? 0) === 0 && c.viewFog !== false,
      splitLdrSprite: blended ? false : c.splitLdrSprite,
    },
    {
      passKind: options.passKind ?? 'forward',
      sampleCount,
      colorFormats,
      coverageOnly: options.coverageOnly ?? false,
      tonemapActive: c.tonemapActive,
      msaaActive: sampleCount === 4,
      viewBindGroupDynamicOffset: c.viewBindGroupDynamicOffset ?? 0,
      transparentDepthWrite: options.transparentDepthWrite ?? false,
      seededDepth: options.seededDepth === true,
      depthPrepass: mode === 'opaque-depth',
      opaqueDepthPrimed: options.opaqueDepthPrimed ?? false,
      ...(surfacePass === undefined ? {} : { surfacePass }),
      oit: oitPhaseForRecordMode(mode),
      ...(options.fragmentEntryPoint === undefined
        ? {}
        : { fragmentEntryPoint: options.fragmentEntryPoint }),
    },
    (pass, material) =>
      matchPass(pass.tags, selector) && (mode === undefined || matchesRecordMode(material, mode)),
    (entry, index) =>
      skipDraw?.(entry, index) === true ||
      preparationSubmeshExcluded(entry, index, options.excludeSelector),
  );
}

type MaterialSelectionContext = Pick<
  _InternalRenderPipelineContext,
  | 'dispatch'
  | 'validatedOrdered'
  | 'mainPassMaterialSelection'
  | 'materialSlots'
  | 'materialSlotIndices'
>;

type MainPassMaterialSelection = MaterialSelectionRows | null;
const EMPTY_MATERIAL_SELECTION: ReadonlyMap<number, ReadonlySet<number>> = new Map();
type MainPassRecordMode = MainPassOptions['recordMode'];

/** One finalized record frame owns its selections and may share fixed membership. */
export interface MainPassMaterialSelectionOwner {
  selectDispatch?(input: MaterialSelectionContext, selector: PassSelector): DispatchList;
  resolve(
    input: MaterialSelectionContext,
    selector: PassSelector | undefined,
    mode: MainPassRecordMode,
    excludeSelector: PassSelector | undefined,
  ): MainPassMaterialSelection;
}

function stockSelectorIndex(selector: PassSelector | undefined): number {
  if (selector === undefined) return 0;
  if (selector === FORWARD_PASS_SELECTOR) return 1;
  if (selector === DEFERRED_PASS_SELECTOR) return 2;
  if (selector === COLOR_PASS_SELECTOR) return 3;
  return -1;
}

function recordModeIndex(mode: MainPassRecordMode): number {
  if (mode === undefined) return 0;
  if (mode === 'opaque') return 1;
  if (mode === 'opaque-depth') return 8;
  if (mode === 'transmission') return 2;
  if (mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual') return 3;
  if (mode === 'translucent' || mode === 'translucent-before-transmission') return 5;
  if (mode === 'opaque-fogged') return 6;
  if (mode === 'opaque-unfogged') return 7;
  return 4;
}

/** Capture finalized facts only after the record owner has ordered its validation rows. */
export function createMainPassMaterialSelectionOwner(
  input: Omit<MaterialSelectionContext, 'mainPassMaterialSelection'>,
  prepared?: {
    readonly selector: PassSelector | undefined;
    readonly excludeSelector: PassSelector | undefined;
    readonly recordMode: MainPassRecordMode;
  },
  groups?: MaterialPassLookup,
): MainPassMaterialSelectionOwner {
  const { dispatch, validatedOrdered, materialSlots, materialSlotIndices } = input;
  const preparedSelector = prepared?.selector;
  const preparedMode = prepared?.recordMode;
  const preparedExclude = prepared?.excludeSelector;
  const selectedDispatch: (DispatchList | undefined)[] = [];
  // Four exact selector identities and five equivalent material modes bound
  // this scratch to sixteen lane pairs; no per-query key strings or hash maps.
  const selections: (
    | {
        readonly membership: MainPassMaterialSelection;
        readonly modes: (MainPassMaterialSelection | undefined)[];
      }
    | undefined
  )[] = [];
  // Capture and custom selectors keep the ordinary material reads.
  const ownsSelection = (
    c: MaterialSelectionContext,
    selectorIndex: number,
    excludeIndex: number,
  ) =>
    c.dispatch === dispatch &&
    c.validatedOrdered === validatedOrdered &&
    (validatedOrdered.length === 0 || c.materialSlots === materialSlots) &&
    c.materialSlotIndices === materialSlotIndices &&
    selectorIndex >= 0 &&
    excludeIndex >= 0;
  return {
    selectDispatch(c, selector) {
      const index = stockSelectorIndex(selector);
      if (c.dispatch !== dispatch || c.validatedOrdered !== validatedOrdered || index < 0)
        return filterDispatchBySelector(c.dispatch, selector);
      // The Scene Pass producer already selected every entry with this exact
      // stock selector. Preserve its fixed dispatch key for downstream grouping.
      if (selector === preparedSelector) return dispatch;
      selectedDispatch[index] ??= filterDispatchBySelector(dispatch, selector);
      return selectedDispatch[index];
    },
    resolve(c, selector, mode, excludeSelector) {
      const selectorIndex = stockSelectorIndex(selector);
      const excludeIndex = stockSelectorIndex(excludeSelector);
      if (!ownsSelection(c, selectorIndex, excludeIndex))
        return selectMainPassMaterialsUncached(c, selector, mode, excludeSelector);
      const exactPrepared =
        prepared !== undefined &&
        selector === preparedSelector &&
        mode === preparedMode &&
        excludeSelector === preparedExclude;
      if (
        groups !== undefined &&
        exactPrepared &&
        selector !== undefined &&
        excludeSelector === undefined &&
        dispatch.length > 0 &&
        recordModeIndex(mode) !== 4
      )
        return groups;
      const index = selectorIndex * 4 + excludeIndex;
      let selected = selections[index];
      if (selected === undefined) {
        selected = {
          membership:
            selector === undefined
              ? null
              : buildMatchedMaterialHandlesByRenderable(dispatch, selector, excludeSelector),
          modes: [],
        };
        selections[index] = selected;
      }
      const modeIndex = recordModeIndex(mode);
      const cached = selected.modes[modeIndex];
      if (cached !== undefined) return cached;
      // A complete owned Scene Pass already admitted each selected submesh.
      // Its exact request needs no second row/material-mode projection.
      if (exactPrepared && modeIndex !== 4 && selected.membership !== null)
        return selected.membership;
      const value =
        modeIndex !== 4 && selected.membership?.size === 0
          ? selected.membership
          : matchedMaterialsForRecordMode(c, selected.membership, mode);
      selected.modes[modeIndex] = value;
      return value;
    },
  };
}

export function matchedMaterialsForRecordMode(
  c: MaterialSelectionContext,
  matchedMaterials: MainPassMaterialSelection,
  mode: MaterialRecordMode | undefined,
): MainPassMaterialSelection {
  if (mode === undefined) return matchedMaterials;
  const surfaceMode = isSurfaceRecordMode(mode);
  const filtered = new Map<number, MaterialHandles>();
  if (mode === 'transmission' && matchedMaterials === null) return filtered;
  const singletons = new FirstEntryMap<number, SingleMaterialHandleSet>();
  let nextRow = 0;
  for (const entry of c.validatedOrdered) {
    const row = nextRow++;
    const dispatchHandles = matchedMaterials?.get(entry.renderableIndex);
    if (!surfaceMode && matchedMaterials !== null && dispatchHandles === undefined) continue;
    let handles: Set<number> | SingleMaterialHandleSet | undefined;
    for (const slot of c.materialSlotIndices.at(row) ?? []) {
      const material = c.materialSlots[slot];
      if (material === undefined) throw new Error('Material selection has no submitted material');
      const handle = material.materialHandle ?? 0;
      if (!surfaceMode && dispatchHandles !== undefined && !dispatchHandles.has(handle)) continue;
      if (!matchesRecordMode(material, mode)) continue;
      if (!surfaceMode && dispatchHandles?.size === 1) {
        filtered.set(entry.renderableIndex, dispatchHandles);
        break;
      }
      handles = includeMaterialHandle(handles, handle, singletons);
    }
    if (handles !== undefined) filtered.set(entry.renderableIndex, handles);
  }
  return filtered;
}

/** Repeated singleton lanes share a value; a second distinct handle owns its Set. */
function includeMaterialHandle(
  handles: Set<number> | SingleMaterialHandleSet | undefined,
  handle: number,
  singletons: FirstEntryMap<number, SingleMaterialHandleSet>,
): Set<number> | SingleMaterialHandleSet {
  if (handles === undefined) {
    let singleton = singletons.get(handle);
    if (singleton === undefined) {
      singleton = new SingleMaterialHandleSet(handle);
      singletons.set(handle, singleton);
    }
    return singleton;
  }
  if (handles instanceof SingleMaterialHandleSet)
    return handles.has(handle) ? handles : new Set([handles.onlyHandle, handle]);
  handles.add(handle);
  return handles;
}

/** Native Scene Pass rows include all CPU geometry and hidden pipeline preparation. */
export function hasMainPassCpuWork(c: _InternalRenderPipelineContext): boolean {
  return (
    c.scenePassWork === undefined ||
    c.validatedOrdered.length > 0 ||
    (c.pipelinePreparationEntries?.length ?? 0) > 0
  );
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: main forward
 * (geometry) pass recording into the graph-owned `pass`; the graph declares
 * its attachments, load ops and resolves. The geometry + optional LDR
 * sprite-split draws share that pass.
 */
function prepareMainPassGpuBindings(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
  colorFormats: ReturnType<typeof mainPassColorFormats>,
  selectedGpuMaterialSlots: ReturnType<typeof selectPassGpuMaterialSlots>,
  resolveMaterialBinding: ReturnType<typeof createMaterialBindGroupResolver>,
): void {
  const gpuDrivenStandardPbrFrameResources = c.gpuDrivenStandardPbrFrameResources;
  if (gpuDrivenStandardPbrFrameResources !== undefined) {
    // Direct Surface draws retain producer resources, but only indirect
    // encoding consumes the pass-local material slot projection.
    if (options?.gpuDriven !== undefined)
      publishGpuDrivenMaterialSlots(
        c,
        gpuDrivenStandardPbrFrameResources,
        options,
        colorFormats,
        selectedGpuMaterialSlots,
      );
    publishMaterialBindingPreparer(
      c,
      gpuDrivenStandardPbrFrameResources,
      selectedGpuMaterialSlots,
      resolveMaterialBinding,
    );
  }
}

function applyPassSkylight(
  c: _InternalRenderPipelineContext,
  prepared: MainPassOptions['preparedSkylight'],
  sky: ReturnType<typeof prepareMaterialSkylight>['skylightResources'],
): _InternalRenderPipelineContext {
  if (prepared !== undefined || c.viewBindGroup === null) return c;
  const viewBindGroup = viewWithSkylight(c.runtime.device, c.viewBindGroup, sky);
  return viewBindGroup === c.viewBindGroup ? c : { ...c, viewBindGroup };
}

export function encodeMainPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  selector?: PassSelector,
  options?: MainPassOptions,
): GpuDrivenStandardPbrFrameResources | undefined {
  const {
    validatedOrdered,
    dispatch,
    viewBindGroupDynamicOffset = 0,
    gpuDrivenStandardPbrFrameResources,
  } = c;
  const passKind = options?.passKind ?? 'forward';
  const recordMode = options?.recordMode;
  assertRecordModeBackdrop(recordMode, options?.transmissionBackdropView);
  const clusteredBindGroupMissing = reportClusteredStandardGroupMissing(c, options);
  const meshGroup2 = c.meshBindGroup;
  // Geometry submission block: setPipeline + 4 bind groups + per-entity
  // material uploads + drawIndexed.
  let matchedMaterials = selectMainPassMaterials(c, selector, recordMode, options?.excludeSelector);
  if (options?.selection !== undefined)
    matchedMaterials = selectEntityMaterials(c, matchedMaterials, options.selection);
  const passSelector = mainPassSelector(selector, passKind);
  const selectedDispatch =
    validatedOrdered.length === 0 || dispatch.length === 0
      ? undefined
      : selectMainPassDispatch(c, passSelector);
  const selectedGpuMaterialSlots = selectPassGpuMaterialSlots(c, selector, options);
  const hasGpuMaterials = selectsGpuMaterials(c, options, selectedGpuMaterialSlots);
  const hasCpuDraws = selectsCpuDraws(validatedOrdered, matchedMaterials);
  const hasDrawWork = hasGpuMaterials || hasCpuDraws;
  // Shared GPU materials are work even when there are no direct draw rows.
  if (
    clusteredBindGroupMissing ||
    !(
      hasDrawWork ||
      hasMainPassPipelinePreparation(c, passSelector, recordMode, options?.excludeSelector)
    )
  )
    return gpuDrivenStandardPbrFrameResources;

  // Per-entity material bind groups assemble inside the draw loops from the
  // scene-level Skylight resources resolved once here.
  const { skylightResources, activeViews } =
    options?.preparedSkylight ?? prepareMaterialSkylight(c);
  c = applyPassSkylight(c, options?.preparedSkylight, skylightResources);
  const { viewBindGroup } = c;
  publishIblBindingInspection(c, skylightResources, activeViews, hasDrawWork);
  const resolveMaterialBinding = createMaterialBindGroupResolver(c, options, skylightResources);
  const colorFormats = mainPassColorFormats(c, options);
  prepareMainPassGpuBindings(
    c,
    options,
    colorFormats,
    selectedGpuMaterialSlots,
    resolveMaterialBinding,
  );

  // GPU-driven batches carry only opaque queues, so they encode before the
  // CPU list: a later-queue CPU draw (e.g. depthCompare 'always' x-ray) must
  // land after the opaque geometry it is meant to overdraw.
  if (hasGpuMaterials && options?.gpuDriven !== undefined)
    encodeGpuDrivenBatches(c, pass, options, options.gpuDriven, passKind);

  // Native Scene Pass work already fixed its CPU roster. GPU-only work has
  // just encoded; no CPU geometry/sprite context or loop is consumed below.
  // Hidden preparation still enters the existing resolver, and raw helper
  // callers retain their original recording/profile callback observations.
  if (!hasMainPassCpuWork(c)) return gpuDrivenStandardPbrFrameResources;

  // A preparation-only lane (hidden transparent PSOs, no validated rows) has
  // no frame view group and records no draws; binding null with dynamic
  // offsets is a GPU validation error that fails the whole frame.
  if (viewBindGroup !== null) pass.setBindGroup(0, viewBindGroup, [viewBindGroupDynamicOffset]);

  const waterAdmission = resolveWaterMaterialFrameBindings(c, options, matchedMaterials).admission;
  if (waterAdmission === undefined) throw new Error('Water material admission returned no result');
  const recordMaterials = excludeWaterMeshRowsFromMaterialSelection(
    c,
    matchedMaterials,
    waterAdmission.excludedRenderableIndices,
  );
  const recordContext = mainPassRecordContext(c, recordMode, waterAdmission);
  const recordGeometry = (): void => {
    recordGeometryDraws(
      recordContext,
      pass,
      recordMaterials,
      c.materialSlotIndices,
      c.msaaActive ? 4 : 1,
      meshGroup2,
      c.meshBindGroup,
      resolveMaterialBinding,
      passKind,
      selectedDispatch,
      colorFormats,
      options?.coverageOnly ?? false,
      options?.fragmentEntryPoint,
      surfacePassForRecordMode(recordMode),
      options?.transparentDepthWrite ?? false,
      oitPhaseForRecordMode(recordMode),
      (preparedPass, material) =>
        matchPass(preparedPass.tags, passSelector) &&
        (recordMode === undefined || matchesRecordMode(material, recordMode)),
      (entry, index) =>
        waterAdmission.excludedRenderableIndices.has(entry.renderableIndex) ||
        preparationSubmeshExcluded(entry, index, options?.excludeSelector),
      options?.seededDepth === true,
      recordMode === 'opaque-depth',
      options?.opaqueDepthPrimed ?? false,
      options?.materialSceneDepth,
      options?.gpuDrivenFilter,
    );
  };
  // The late occlusion pass only adds GPU items the HZB revealed; the CPU
  // lane already drew its complete set in the early pass.
  if (options?.gpuDriven?.phase !== 'late') recordCpuGeometry(c, passKind, recordGeometry);

  // LDR sprites record into the same graph pass after the geometry draws,
  // sharing its depth attachment so sprite-vs-mesh occlusion
  // (depthCompare=less-equal) is preserved.
  if (passKind === 'forward' && recordMode === undefined)
    recordSpritePass(
      c,
      pass,
      spriteMembership(selector, options, matchedMaterials, selectedDispatch),
      c.materialSlotIndices,
      c.msaaActive ? 4 : 1,
      resolveMaterialBinding,
      selectedDispatch,
    );
  return gpuDrivenStandardPbrFrameResources;
}

/** Start the stock opaque raster requests while capture or shadows prepare their own programs. */
export function requestVisibleForwardPipelines(
  c: _InternalRenderPipelineContext,
  selector: PassSelector | undefined,
  options: Pick<
    MainPassOptions,
    | 'recordMode'
    | 'excludeSelector'
    | 'seededDepth'
    | 'opaqueDepthPrimed'
    | 'coverageOnly'
    | 'fragmentEntryPoint'
  > & {
    readonly formats: readonly GPUTextureFormat[];
    readonly sampleCount: number;
  },
): void {
  if (c.validatedOrdered.length === 0 || c.gpuDrivenSelection !== undefined) return;
  requestVisibleMeshPipelines(
    c,
    selectMainPassMaterials(c, selector, options.recordMode, options.excludeSelector),
    c.dispatch.length === 0
      ? undefined
      : selectMainPassDispatch(c, mainPassSelector(selector, 'forward')),
    {
      passKind: 'forward',
      sampleCount: options.sampleCount,
      colorFormats: options.formats,
      coverageOnly: options.coverageOnly ?? false,
      tonemapActive: c.tonemapActive,
      msaaActive: options.sampleCount === 4,
      viewBindGroupDynamicOffset: c.viewBindGroupDynamicOffset ?? 0,
      transparentDepthWrite: false,
      seededDepth: options.seededDepth === true,
      depthPrepass: options.recordMode === 'opaque-depth',
      opaqueDepthPrimed: options.opaqueDepthPrimed ?? false,
      fragmentEntryPoint: options.fragmentEntryPoint,
      oit: undefined,
    },
  );
}

/** Backdrop-consuming record modes sample the graph-paired color view. */
function assertRecordModeBackdrop(
  recordMode: MaterialRecordMode | undefined,
  transmissionBackdropView: TextureView | null | undefined,
): void {
  if (transmissionBackdropView != null) return;
  if (
    recordMode === 'transmission' ||
    recordMode === 'translucent' ||
    recordMode === 'single-layer-medium-nearest-layer' ||
    recordMode === 'single-layer-medium-color' ||
    (waterRecordPass(recordMode) !== undefined &&
      recordMode !== 'water-shadow' &&
      recordMode !== 'water-velocity')
  )
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'transmissionBackdropView != null for a backdrop-consuming record mode',
      hint: 'the typed Standard backdrop pass must resolve its graph-paired color view',
    });
}

/**
 * The prepared Standard topology is the frame authority. Do not infer the
 * shader lane from a resource that may be absent after a failed rebuild: a
 * clustered frame with no unified group must fail closed (reported once here), never fall back to a
 * direct-lighting shader with an incompatible group(2) contract. A
 * camera-only/clear frame has no group(2) consumer yet, so its absence there
 * is harmless.
 */
function reportClusteredStandardGroupMissing(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
): boolean {
  const consumesGroup2 =
    c.validatedOrdered.length > 0 || (options?.gpuDriven !== undefined && c.materialSlotCount > 0);
  if (!consumesGroup2 || standardTopologyBindGroupReady(c.standardLighting, c.clusterViewReady))
    return false;
  c.runtime.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'clustered Standard frame has current View Cluster resources',
      hint: 'repair the clustered buffer/layout admission before retrying the frame; direct URP fallback is unsafe',
    }),
  );
  return true;
}

/** GPU membership of an indirect pass; absent when the pass has no GPU-driven lane. */
function selectPassGpuMaterialSlots(
  c: _InternalRenderPipelineContext,
  selector: PassSelector | undefined,
  options: MainPassOptions | undefined,
): ReadonlySet<number> | undefined {
  if (options?.gpuDriven === undefined) return undefined;
  return selectGpuMaterialSlots(
    c.materialSlots,
    selector,
    options.recordMode,
    options.excludeSelector,
  );
}

function selectsGpuMaterials(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
  selectedGpuMaterialSlots: ReadonlySet<number> | undefined,
): boolean {
  return (
    options?.gpuDriven !== undefined && (selectedGpuMaterialSlots?.size ?? c.materialSlotCount) > 0
  );
}

/** Restrict material membership to the explicitly selected entities of one World. */
function selectEntityMaterials(
  c: _InternalRenderPipelineContext,
  matchedMaterials: MainPassMaterialSelection,
  selection: NonNullable<MainPassOptions['selection']>,
): Map<number, MaterialHandles> {
  const entities = new Set(selection.entities);
  const selected = new Map<number, MaterialHandles>();
  let nextIndex = 0;
  for (const entry of c.validatedOrdered) {
    const index = nextIndex++;
    if (!entities.has(entry.source.entityKey)) continue;
    const handles = matchedMaterials?.get(entry.renderableIndex);
    if (matchedMaterials !== null && handles === undefined) continue;
    selected.set(
      entry.renderableIndex,
      handles ??
        new Set(
          (c.materialSlotIndices.at(index) ?? []).map(
            (slot) => c.materialSlots[slot]?.materialHandle ?? 0,
          ),
        ),
    );
  }
  return selected;
}

/** The stock pass selector of a pass kind, unless the graph lane names its own. */
function mainPassSelector(selector: PassSelector | undefined, passKind: PassKind): PassSelector {
  return selector ?? (passKind === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR);
}

function selectsCpuDraws(
  validatedOrdered: DrawRows,
  matchedMaterials: MainPassMaterialSelection,
): boolean {
  return validatedOrdered.length > 0 && (matchedMaterials === null || matchedMaterials.size > 0);
}

/** Pass-owned attachment formats; the default is the graph's scene color target. */
function mainPassColorFormats(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
): readonly GPUTextureFormat[] {
  return (
    options?.colorFormats ?? [
      (c.tonemapActive || c.transparentColorFormat === 'rgba16float'
        ? 'rgba16float'
        : c.pipelineState.colorAttachmentFormat) as GPUTextureFormat,
    ]
  );
}

/**
 * Blended writers of the display view fog themselves at their own depth;
 * auxiliary captures keep their own unfogged slot.
 */
function mainPassRecordContext(
  c: _InternalRenderPipelineContext,
  recordMode: MaterialRecordMode | undefined,
  waterAdmission: WaterMaterialAdmission,
): _InternalRenderPipelineContext {
  const resolveWaterMaterialDrawBinding = !waterAdmission.hasWaterMeshDraws
    ? c.resolveWaterMaterialDrawBinding
    : (source: import('../render-system-extract').RenderableSnapshot) => {
        const owner = source.waterOwner;
        const waterBindings = waterAdmission.bindings;
        if (owner === undefined || waterBindings === undefined) return undefined;
        const bodyKey = waterBodyOwnerKey(
          owner.worldIdentity,
          owner.guid,
          owner.generation,
          owner.zoneGeneration,
        );
        const resolved = waterMaterialDrawBinding(
          waterBindings,
          bodyKey,
          {
            viewIdentity: renderFeatureViewIdentity(c.camera),
            zoneGeneration: owner.zoneGeneration,
            deviceGeneration: c.runtime.deviceGeneration ?? 0,
            frameGeneration: waterAdmission.frameGeneration,
            bodyGeneration: owner.generation,
          },
          owner.drawKey ?? source.waterMeshTiles?.drawKey,
        );
        if (!resolved.ok) {
          if (resolved.error.code === 'water-material-binding-missing')
            throw new GpuDrivenPreparationError('resource-not-ready', {
              reason: 'material-resource-missing',
              owner: 'material',
              expected: `submitted generation-qualified WaterInfo/wave closure for ${bodyKey}`,
              recovery: 'retry-same-draw',
            });
          throw new GpuDrivenPreparationError('stale-generation', {
            reason: 'generation-stale',
            owner: 'generation',
            expected: resolved.error.expected,
            actual: JSON.stringify(resolved.error.detail) ?? 'unknown',
            recovery: 'rebuild-generation',
          });
        }
        const actualFormat = resolved.value.frameBindings.bodyTargetFormats.get(bodyKey);
        if (
          actualFormat !== undefined &&
          owner.targetFormat !== undefined &&
          actualFormat !== owner.targetFormat
        )
          throw new GpuDrivenPreparationError('stale-generation', {
            reason: 'generation-stale',
            owner: 'generation',
            expected: `WaterInfo target format ${owner.targetFormat} for ${bodyKey}`,
            actual: actualFormat ?? 'missing',
            recovery: 'rebuild-generation',
          });
        return resolved.value;
      };
  if (
    recordMode === undefined &&
    resolveWaterMaterialDrawBinding === c.resolveWaterMaterialDrawBinding
  )
    return c;
  if (recordMode === undefined) return { ...c, resolveWaterMaterialDrawBinding };
  const blendedRecordMode =
    recordMode === 'transparent' ||
    recordMode === 'translucent' ||
    recordMode === 'translucent-before-transmission' ||
    recordMode === 'oit-accumulate' ||
    recordMode === 'oit-residual';
  const translucentFog =
    blendedRecordMode && (c.viewBindGroupDynamicOffset ?? 0) === 0 && c.viewFog !== false;
  const splitLdrSprite = blendedRecordMode ? false : c.splitLdrSprite;
  if (
    (c.translucentFog === true) === translucentFog &&
    c.splitLdrSprite === splitLdrSprite &&
    resolveWaterMaterialDrawBinding === c.resolveWaterMaterialDrawBinding
  )
    return c;
  return {
    ...c,
    resolveWaterMaterialDrawBinding,
    translucentFog,
    splitLdrSprite,
  };
}

/** Shadow and color share one WaterInfo publication and resource admission. */
export function waterMaterialRecordContext(
  c: _InternalRenderPipelineContext,
  waterFrame: MainPassOptions['waterFrame'],
): _InternalRenderPipelineContext {
  const cacheOwnerCandidate = c.waterMaterialRecordCache;
  const currentRendererFrame = c.runtime.rendererFrameNumber;
  const frameGeneration =
    currentRendererFrame !== undefined &&
    Number.isSafeInteger(currentRendererFrame) &&
    currentRendererFrame > 0
      ? currentRendererFrame
      : undefined;
  const cacheOwner =
    cacheOwnerCandidate !== undefined &&
    frameGeneration !== undefined &&
    cacheOwnerCandidate.validatedOrdered === c.validatedOrdered &&
    cacheOwnerCandidate.frameGeneration === frameGeneration
      ? cacheOwnerCandidate
      : undefined;
  const drawClosure = waterDrawsForRecord(c);
  if (drawClosure?.draws.length === 0) return c;
  const viewIdentity = renderFeatureViewIdentity(c.camera);
  const deviceGeneration = c.runtime.deviceGeneration ?? 0;
  const x = c.camera.position[0] ?? 0;
  const y = c.camera.position[1] ?? 0;
  const z = c.camera.position[2] ?? 0;
  const previous = cacheOwner?.candidate;
  const sameOwnedFrame =
    previous !== undefined &&
    previous.inputContext === c &&
    previous.validatedOrdered === c.validatedOrdered &&
    previous.drawClosure === cacheOwner?.drawClosure &&
    previous.frameGeneration === frameGeneration &&
    previous.viewIdentity === viewIdentity &&
    previous.deviceGeneration === deviceGeneration &&
    previous.pipelineState === c.pipelineState &&
    previous.viewOrigin[0] === x &&
    previous.viewOrigin[1] === y &&
    previous.viewOrigin[2] === z &&
    previous.publicationResolver === c.runtime.getWaterMaterialFramePublication &&
    previous.bindingResolver === c.runtime.getWaterMaterialFrameBindings;

  const resolution = resolveWaterMaterialFrameBindings(
    c,
    waterFrame === undefined ? undefined : { waterFrame },
    null,
    drawClosure === undefined
      ? undefined
      : {
          drawClosure,
          frameGeneration: frameGeneration ?? requireWaterRendererFrameNumber(c.runtime),
          viewIdentity,
          deviceGeneration,
          viewOrigin:
            sameOwnedFrame && previous !== undefined ? previous.viewOrigin : ([x, y, z] as const),
          ...(sameOwnedFrame && previous !== undefined ? { previous } : {}),
        },
  );
  if (resolution.cachedContext !== undefined) return resolution.cachedContext;
  const admission = resolution.admission;
  if (admission === undefined) throw new Error('Water material admission returned no result');
  const context = mainPassRecordContext(c, undefined, admission);
  const recordContext =
    admission.excludedRenderableIndices.size === 0
      ? context
      : {
          ...context,
          validatedOrdered: context.validatedOrdered.filter(
            (entry) => !admission.excludedRenderableIndices.has(entry.renderableIndex),
          ),
        };
  if (
    cacheOwner !== undefined &&
    resolution.cacheFacts !== undefined &&
    admission.excludedRenderableIndices.size === 0
  )
    cacheOwner.candidate = Object.freeze({ ...resolution.cacheFacts, context: recordContext });
  else if (cacheOwner !== undefined) cacheOwner.candidate = undefined;
  return recordContext;
}

type WaterMaterialAdmission =
  | Readonly<{
      readonly excludedRenderableIndices: ReadonlySet<number>;
      readonly hasWaterMeshDraws: false;
    }>
  | Readonly<{
      readonly bindings?: ReadonlyMap<string, WaterMaterialFrameBindings>;
      readonly excludedRenderableIndices: ReadonlySet<number>;
      readonly frameGeneration: number;
      readonly hasWaterMeshDraws: true;
    }>;

/** Renderer frame IDs key both WaterInfo publication and the consuming draw. */
export function requireWaterRendererFrameNumber(runtime: {
  readonly rendererFrameNumber?: number | undefined;
}): number {
  const frameNumber = runtime.rendererFrameNumber;
  if (frameNumber === undefined || !Number.isSafeInteger(frameNumber) || frameNumber < 1)
    throw new RendererContractFailureError(
      'draw',
      `WaterInfo admission requires a positive Renderer submission frame ID; actual ${frameNumber ?? 'missing'}`,
    );
  return frameNumber;
}

/** Missing same-frame rows exclude only their WaterMesh owners; stale rows stay fatal. */
export function admitWaterMeshDraws(
  draws: readonly WaterMaterialAdmissionDraw[],
  bindings: ReadonlyMap<string, WaterMaterialFrameBindings> | undefined,
  expected: Readonly<{
    viewIdentity: string;
    deviceGeneration: number;
    frameGeneration: number;
  }>,
  drawOwnersAlreadyValidated = false,
): ReadonlySet<number> {
  const excluded = new Set<number>();
  for (const draw of draws) {
    if (!drawOwnersAlreadyValidated) assertCurrentWaterMeshDraw(draw, expected.viewIdentity);
    if (bindings === undefined) {
      excluded.add(draw.renderableIndex);
      continue;
    }
    const bodyKey = waterBodyOwnerKey(
      draw.owner.worldIdentity,
      draw.owner.guid,
      draw.owner.generation,
      draw.owner.zoneGeneration,
    );
    let published = waterBodyPublicationPresent(bindings, bodyKey, draw.tiles !== undefined);
    const tiles = draw.tiles;
    if (published && tiles?.transitionTargets !== undefined) {
      for (const target of tiles.transitionTargets) {
        const transitionKey = waterBodyOwnerKey(
          tiles.worldIdentity,
          target.bodyGuid,
          target.bodyGeneration,
          draw.owner.zoneGeneration,
        );
        if (!waterBodyPublicationPresent(bindings, transitionKey, true)) {
          published = false;
          break;
        }
      }
    }
    if (!published) {
      excluded.add(draw.renderableIndex);
      continue;
    }
    const resolved = waterMaterialDrawBinding(
      bindings,
      bodyKey,
      {
        viewIdentity: expected.viewIdentity,
        zoneGeneration: draw.owner.zoneGeneration,
        deviceGeneration: expected.deviceGeneration,
        frameGeneration: expected.frameGeneration,
        bodyGeneration: draw.owner.generation,
      },
      draw.owner.drawKey ?? draw.tiles?.drawKey,
    );
    if (!resolved.ok) {
      if (resolved.error.code === 'water-material-binding-missing') {
        throw new GpuDrivenPreparationError('resource-not-ready', {
          reason: 'material-resource-missing',
          owner: 'material',
          expected: resolved.error.expected,
          actual: JSON.stringify(resolved.error.detail) ?? 'unknown',
          recovery: 'retry-same-draw',
        });
      }
      throw new GpuDrivenPreparationError('stale-generation', {
        reason: 'generation-stale',
        owner: 'generation',
        expected: resolved.error.expected,
        actual: JSON.stringify(resolved.error.detail) ?? 'unknown',
        recovery: 'rebuild-generation',
      });
    }
    const actualFormat = resolved.value.frameBindings.bodyTargetFormats.get(bodyKey);
    if (
      actualFormat !== undefined &&
      draw.owner.targetFormat !== undefined &&
      actualFormat !== draw.owner.targetFormat
    )
      throw new GpuDrivenPreparationError('stale-generation', {
        reason: 'generation-stale',
        owner: 'generation',
        expected: `WaterInfo target format ${draw.owner.targetFormat} for ${bodyKey}`,
        actual: actualFormat ?? 'missing',
        recovery: 'rebuild-generation',
      });
  }
  return excluded;
}

function waterBodyPublicationPresent(
  bindings: ReadonlyMap<string, WaterMaterialFrameBindings>,
  bodyKey: string,
  requiresWaterInfo: boolean,
): boolean {
  for (const frame of bindings.values()) {
    const targetName = frame.bodyTargetNames.get(bodyKey);
    if (
      (targetName !== undefined && bindings.has(targetName)) ||
      (!requiresWaterInfo && frame.bodyIndices.has(bodyKey))
    )
      return true;
  }
  return false;
}

function assertCurrentWaterMeshDraw(draw: WaterMaterialAdmissionDraw, viewIdentity: string): void {
  const { owner, tiles } = draw;
  if (owner.viewIdentity !== undefined && owner.viewIdentity !== viewIdentity)
    throw new GpuDrivenPreparationError('stale-generation', {
      reason: 'generation-stale',
      owner: 'generation',
      expected: `WaterMesh owner view ${viewIdentity}`,
      actual: owner.viewIdentity,
      recovery: 'rebuild-generation',
    });
  if (tiles === undefined) return;
  const ownerBodyKey = waterBodyOwnerKey(
    owner.worldIdentity,
    owner.guid,
    owner.generation,
    owner.zoneGeneration,
  );
  const tilesBodyKey = waterBodyOwnerKey(
    tiles.worldIdentity,
    tiles.bodyGuid,
    tiles.bodyGeneration,
    tiles.zoneGeneration,
  );
  if (
    ownerBodyKey !== tilesBodyKey ||
    tiles.viewIdentity !== owner.viewIdentity ||
    (owner.drawKey !== undefined && owner.drawKey !== tiles.drawKey)
  )
    throw new GpuDrivenPreparationError('stale-generation', {
      reason: 'generation-stale',
      owner: 'generation',
      expected: `WaterMesh tile closure matching owner ${ownerBodyKey}/${owner.drawKey ?? tiles.drawKey}`,
      actual: `${tilesBodyKey}/${tiles.drawKey}@${tiles.viewIdentity}`,
      recovery: 'rebuild-generation',
    });
}

export function excludeWaterMeshRowsFromMaterialSelection(
  c: _InternalRenderPipelineContext,
  selected: MainPassMaterialSelection,
  excludedRenderableIndices: ReadonlySet<number>,
): MainPassMaterialSelection {
  if (excludedRenderableIndices.size === 0) return selected;
  const admitted = new Map<number, MaterialHandles>();
  let row = 0;
  for (const entry of c.validatedOrdered) {
    const currentRow = row++;
    if (excludedRenderableIndices.has(entry.renderableIndex)) continue;
    const selectedHandles = selected?.get(entry.renderableIndex);
    if (selected !== null && selectedHandles === undefined) continue;
    admitted.set(
      entry.renderableIndex,
      selectedHandles ??
        new Set(
          (c.materialSlotIndices.at(currentRow) ?? []).map(
            (slot) => c.materialSlots[slot]?.materialHandle ?? 0,
          ),
        ),
    );
  }
  return admitted;
}

/** @internal */
export function selectedWaterMeshAdmissionDraws<
  TDraw extends Pick<WaterMaterialAdmissionDraw, 'renderableIndex'>,
>(draws: readonly TDraw[], selectedMaterials: MainPassMaterialSelection): readonly TDraw[] {
  return selectedMaterials === null || draws.length === 0
    ? draws
    : draws.filter((draw) => selectedMaterials.has(draw.renderableIndex));
}

type WaterMaterialCacheFacts = Omit<WaterMaterialRecordCacheCandidate, 'context'>;

interface WaterMaterialFrameResolution {
  readonly admission?: WaterMaterialAdmission;
  readonly cachedContext?: _InternalRenderPipelineContext;
  readonly cacheFacts?: WaterMaterialCacheFacts;
}

const EMPTY_WATER_DRAWS: readonly WaterMaterialAdmissionDraw[] = Object.freeze([]);
const NO_WATER_RESOLUTION: WaterMaterialFrameResolution = {
  admission: { excludedRenderableIndices: new Set<number>(), hasWaterMeshDraws: false },
};

interface WaterMaterialFrameCacheInput {
  readonly drawClosure: WaterMaterialAdmissionDrawClosure;
  readonly frameGeneration: number;
  readonly viewIdentity: string;
  readonly deviceGeneration: number;
  readonly viewOrigin: readonly [number, number, number];
  readonly previous?: WaterMaterialRecordCacheCandidate;
}

function sameTextureViews(
  previous: ReadonlyMap<string, TextureView> | undefined,
  current: ReadonlyMap<string, TextureView>,
): boolean {
  if (previous === undefined || previous.size !== current.size) return false;
  for (const [name, view] of current) if (previous.get(name) !== view) return false;
  return true;
}

type WaterFrameTargets = NonNullable<MainPassOptions['waterFrame']>['targets'];

function sameGraphTargetViews(
  previous: ReadonlyMap<string, GraphTextureView> | undefined,
  current: WaterFrameTargets | undefined,
): boolean {
  if (previous === undefined) return current === undefined;
  if (current === undefined || previous.size !== current.size) return false;
  for (const [name, target] of current) if (previous.get(name) !== target.view) return false;
  return true;
}

function selectedWaterMeshUploads(draws: readonly WaterMaterialAdmissionDraw[]) {
  const uploads: ReturnType<typeof waterMeshAdmissionUpload>[] = [];
  for (const draw of draws)
    if (draw.tiles !== undefined) uploads.push(waterMeshAdmissionUpload(draw.tiles));
  return uploads;
}

/** The emitting pass owns the subset of this attempt's finalized addresses. */
function waterDrawsForRecord(
  c: _InternalRenderPipelineContext,
): WaterMaterialAdmissionDrawClosure | undefined {
  const owner = c.waterMaterialRecordCache;
  if (owner === undefined || owner.frameGeneration !== c.runtime.rendererFrameNumber)
    return undefined;
  if (owner.validatedOrdered === c.validatedOrdered) return owner.drawClosure;
  const pass = c.scenePassDraws;
  return pass !== undefined &&
    pass.validatedOrdered === c.validatedOrdered &&
    owner.drawClosure !== undefined &&
    owner.passes !== undefined &&
    owner.passes === c.scenePassWork
    ? (owner.waterByPass?.get(pass) ?? EMPTY_WATER_CLOSURE)
    : undefined;
}

function resolveWaterMaterialFrameBindings(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
  selectedMaterials: MainPassMaterialSelection,
  cache?: WaterMaterialFrameCacheInput,
): WaterMaterialFrameResolution {
  const closure = cache?.drawClosure ?? waterDrawsForRecord(c);
  let waterDraws: readonly WaterMaterialAdmissionDraw[];
  if (closure !== undefined) {
    waterDraws = selectedWaterMeshAdmissionDraws(closure.draws, selectedMaterials);
  } else {
    let admitted: WaterMaterialAdmissionDraw[] | undefined;
    for (const entry of c.validatedOrdered) {
      const owner = entry.source.waterOwner;
      if (
        owner === undefined ||
        (selectedMaterials !== null && !selectedMaterials.has(entry.renderableIndex))
      )
        continue;
      const tiles = entry.source.waterMeshTiles;
      admitted ??= [];
      admitted.push({
        renderableIndex: entry.renderableIndex,
        owner,
        ...(tiles === undefined ? {} : { tiles }),
      });
    }
    waterDraws = admitted ?? EMPTY_WATER_DRAWS;
  }
  if (waterDraws.length === 0) return NO_WATER_RESOLUTION;
  const viewIdentity = cache?.viewIdentity ?? renderFeatureViewIdentity(c.camera);
  const ownersAlreadyValidated = cache?.previous !== undefined;
  if (!ownersAlreadyValidated)
    for (const draw of waterDraws) assertCurrentWaterMeshDraw(draw, viewIdentity);

  const expected = {
    viewIdentity,
    deviceGeneration: cache?.deviceGeneration ?? c.runtime.deviceGeneration ?? 0,
    frameGeneration: cache?.frameGeneration ?? requireWaterRendererFrameNumber(c.runtime),
  } as const;
  const waterFrame = options?.waterFrame;
  const waterInfoTextureViews = new Map<string, TextureView>();
  if (waterFrame !== undefined) {
    for (const [targetName, target] of waterFrame.targets) {
      const view = waterFrame.resources.textureView(target.view);
      if (!view.ok) throw view.error;
      waterInfoTextureViews.set(targetName, view.value);
    }
  }
  const viewOriginM =
    cache?.viewOrigin ??
    ([c.camera.position[0] ?? 0, c.camera.position[1] ?? 0, c.camera.position[2] ?? 0] as const);
  const publication =
    cache === undefined
      ? undefined
      : c.runtime.getWaterMaterialFramePublication?.(
          expected.viewIdentity,
          expected.frameGeneration,
          expected.deviceGeneration,
        );
  const waterMeshDraws =
    cache !== undefined && selectedMaterials === null
      ? cache.drawClosure.uploads
      : selectedWaterMeshUploads(waterDraws);
  const bindings = c.runtime.getWaterMaterialFrameBindings?.({
    waterInfoTextureViews,
    ...(publication === undefined ? {} : { waterInfoPublication: publication }),
    viewOriginM,
    ...expected,
    waterMeshDraws,
    ...(cache === undefined || selectedMaterials !== null
      ? {}
      : {
          waterMeshDrawsOwned: isOwnedWaterMeshAdmissionUploadClosure(cache.drawClosure.uploads),
        }),
  });
  const previous = cache?.previous;
  if (
    previous !== undefined &&
    previous.publication === publication &&
    previous.bindings === bindings &&
    previous.waterTargets === waterFrame?.targets &&
    previous.publicationResolver === c.runtime.getWaterMaterialFramePublication &&
    previous.bindingResolver === c.runtime.getWaterMaterialFrameBindings &&
    sameGraphTargetViews(previous.graphTargets, waterFrame?.targets) &&
    sameTextureViews(previous.textureViews, waterInfoTextureViews)
  )
    return { cachedContext: previous.context };

  const excludedRenderableIndices = admitWaterMeshDraws(waterDraws, bindings, expected, true);
  const admission: WaterMaterialAdmission = {
    ...(bindings === undefined ? {} : { bindings }),
    excludedRenderableIndices,
    frameGeneration: expected.frameGeneration,
    hasWaterMeshDraws: true,
  };
  if (
    cache === undefined ||
    publication === undefined ||
    bindings === undefined ||
    excludedRenderableIndices.size !== 0
  )
    return { admission };

  const graphTargets = waterFrame === undefined ? undefined : new Map<string, GraphTextureView>();
  if (graphTargets !== undefined && waterFrame !== undefined)
    for (const [name, target] of waterFrame.targets) graphTargets.set(name, target.view);
  return {
    admission,
    cacheFacts: {
      inputContext: c,
      validatedOrdered: c.validatedOrdered,
      drawClosure: cache.drawClosure,
      frameGeneration: expected.frameGeneration,
      viewIdentity: expected.viewIdentity,
      deviceGeneration: expected.deviceGeneration,
      pipelineState: c.pipelineState,
      viewOrigin: viewOriginM,
      waterTargets: waterFrame?.targets,
      graphTargets,
      textureViews: new Map(waterInfoTextureViews),
      publication,
      publicationResolver: c.runtime.getWaterMaterialFramePublication,
      bindingResolver: c.runtime.getWaterMaterialFrameBindings,
      bindings,
    },
  };
}

function surfacePassForRecordMode(
  mode: MaterialRecordMode | undefined,
): MaterialSurfacePassKind | undefined {
  if (mode === 'single-layer-medium-nearest-layer') return 'nearest-layer';
  if (mode === 'single-layer-medium-color' || mode === 'water-color') return 'color';
  return waterRecordPass(mode)?.[0];
}

function oitPhaseForRecordMode(
  mode: MaterialRecordMode | undefined,
): 'accumulate' | 'residual' | undefined {
  if (mode === 'oit-accumulate') return 'accumulate';
  return mode === 'oit-residual' ? 'residual' : undefined;
}

/** Record the CPU geometry loop, inside its profile phase when one is attached. */
function recordCpuGeometry(
  c: _InternalRenderPipelineContext,
  passKind: PassKind,
  recordGeometry: () => void,
): void {
  if (c.profilePhase === undefined) {
    recordGeometry();
    return;
  }
  const passName = passKind === 'deferred' ? 'g-buffer' : 'forward';
  c.profilePhase(
    `record/graph-execute/${passName}/geometry-loop` as RenderRecordPhase,
    recordGeometry,
  );
}

/**
 * Only legacy sprite recording consumes entity-level membership. Reuse this
 * invocation's selected dispatch; material/exclusion lanes have their own
 * pair-level membership and never need this extra set.
 */
function spriteMembership(
  selector: PassSelector | undefined,
  options: MainPassOptions | undefined,
  matchedMaterials: MainPassMaterialSelection,
  selectedDispatch: DispatchList | undefined,
): Set<number> | null {
  if (options?.selection !== undefined) return new Set(matchedMaterials?.keys());
  if (selector === undefined || selectedDispatch === undefined) return null;
  const matchedIndices = new Set<number>();
  for (const entry of selectedDispatch) matchedIndices.add(entry.renderableIndex);
  return matchedIndices;
}

/** Diagnostics receipt proving the Skylight binding chain this pass consumes. */
function publishIblBindingInspection(
  c: _InternalRenderPipelineContext,
  skylightResources: SkylightBindGroupResources,
  activeViews: object | undefined,
  hasDrawWork: boolean,
): void {
  if (!hasDrawWork) return;
  const { runtime, frameState, pipelineState } = c;
  const activeCache =
    c.skylight === undefined
      ? undefined
      : c.store.getCubemapIbl(c.skylight.equirectHandle, c.world);
  const prefilterViewMipCount =
    activeCache?.prefilterLevelCount ?? (activeViews === undefined ? 1 : 0);
  const deviceGeneration = recordContext(runtime).deviceScope.generation;
  const resource = (view: object, sampler: object) => ({
    viewIdentity: getOpaqueResourceIdentity(view),
    samplerIdentity: getOpaqueResourceIdentity(sampler),
    deviceGeneration,
  });
  frameState.iblBindings = new IblBindingObservation({
    status: 'binding-chain-consistent',
    frameId: frameState.frameNumber,
    deviceGeneration,
    active: activeViews === undefined ? 'fallback' : 'active',
    cache: {
      identity: getOpaqueResourceIdentity(
        (activeCache ?? pipelineState.skylightFallback) as object,
      ),
      generation: deviceGeneration,
      prefilterMipCount: prefilterViewMipCount,
      prefilterViewMipCount,
    },
    sampler: {
      expected: {
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      },
      identities: [
        getOpaqueResourceIdentity(skylightResources.irradianceSampler as object),
        getOpaqueResourceIdentity(skylightResources.prefilterSampler as object),
        getOpaqueResourceIdentity(skylightResources.irradianceSampler as object),
      ],
    },
    resources: {
      irradiance: resource(
        skylightResources.skySh as object,
        skylightResources.irradianceSampler as object,
      ),
      prefilter: resource(
        skylightResources.prefilterView as object,
        skylightResources.prefilterSampler as object,
      ),
      brdfLut: resource(
        skylightResources.brdfLutView as object,
        skylightResources.irradianceSampler as object,
      ),
      intensityBufferIdentity: getOpaqueResourceIdentity(
        skylightResources.intensityBuffer as object,
      ),
    },
    errors: [],
  });
}

/** Each draw resolves its live resources. Share the returned value only after its
 * physical group, address, layout and reflection inputs have been established. */
function createMaterialBindGroupResolver(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
  skylightResources: SkylightBindGroupResources,
): MainPassMaterialBindingResolver {
  const { world, materialBindings } = c;
  const hasProbeBindings = (c.reflectionProbes?.table.rows.length ?? 0) > 0;
  const deps = createPerSubmeshMaterialBgDeps(c, options, skylightResources, hasProbeBindings);
  return (
    materialSlot: number,
    material: MaterialSnapshot,
    entityKey: number | undefined,
    materialWorld: RenderResourceScope = world,
    address: MaterialBindingAddress,
    materialShaderId: string | undefined = material.materialShaderId,
    standardMaterialLayoutIndex = 0,
    selectedLayout,
  ) => {
    const resourceClass = materialBindings[materialSlot]?.resourceClass;
    return buildPerSubmeshMaterialBg(
      deps,
      material,
      entityKey,
      materialWorld,
      materialShaderId,
      materialSlot,
      resourceClass,
      standardMaterialLayoutIndex,
      undefined,
      address,
      selectedLayout,
    );
  };
}

/**
 * feat-20260623-world-space-video-asset M4 / w17 (D-2 / AC-09): video sources
 * take the high-perf GPUExternalTexture upload only when the RhiCaps-based
 * capability probe admits it; otherwise copyExternalImageToTexture is the
 * sole route. The material UBO slice mirrors the post-split Standard schema
 * (MATERIAL_UNIFORM_BYTES).
 */
export type MaterialBindingInputs = Pick<
  _InternalRenderPipelineContext,
  | 'runtime'
  | 'world'
  | 'frameState'
  | 'pipelineState'
  | 'store'
  | 'gpuDrivenStandardPbrFrameResources'
  | 'gpuDrivenSceneMaterialBuffer'
  | 'reflectionProbes'
  | 'planarReflectionView'
  | 'skylight'
  | 'capturedAtmosphere'
  | 'planarReflectionAllowed'
  | 'materialBgAssemblyCache'
  | 'bindGroupCounts'
>;

export function createPerSubmeshMaterialBgDeps(
  c: MaterialBindingInputs,
  options: MainPassOptions | undefined,
  skylightResources: SkylightBindGroupResources,
  hasProbeBindings: boolean,
): PerSubmeshMaterialBgDeps {
  const { runtime, world, frameState } = c;
  const sceneMaterialBuffer =
    c.gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer ?? c.gpuDrivenSceneMaterialBuffer;
  return {
    runtime,
    pipelineState: c.pipelineState,
    world,
    store: c.store,
    materialSlice: MATERIAL_UNIFORM_BYTES,
    videoHighPerfAvailable: probeVideoHighPerfUpload(runtime.device),
    skylightResources,
    bindingSceneCurrent: materialSceneBindingCurrency(c),
    resolveRenderTargetTextureSource: runtime.resolveRenderTargetTextureSource,
    resolveFeatureTextureSource: (name) => {
      const graphFrame = options?.waterFrame;
      const target = graphFrame?.targets.get(name);
      if (target === undefined || graphFrame === undefined) return undefined;
      const resolved = graphFrame.resources.textureView(target.view);
      if (!resolved.ok) throw resolved.error;
      return resolved.value;
    },
    resolveReflectionProbeResources: (_materialWorld, entityKey, resourceClass) => {
      const reflectionProbes = c.reflectionProbes;
      return reflectionProbes === undefined || !hasProbeBindings
        ? undefined
        : reflectionProbeMaterial(reflectionProbes, skylightResources, resourceClass, entityKey);
    },
    ...(c.planarReflectionView === undefined
      ? {}
      : { planarReflectionView: c.planarReflectionView }),
    materialBgAssemblyCache: c.materialBgAssemblyCache,
    frameState,
    bindGroupCounts: c.bindGroupCounts,
    ...(sceneMaterialBuffer === undefined ? {} : { sceneMaterialBuffer }),
    ...surfaceMediumViews(options),
    ...(options?.materialGraphViews === undefined
      ? {}
      : { graphViews: options.materialGraphViews }),
  };
}

/** Keep persistent owners and physical facts, never the pass context or its resource reader. */
export function materialSceneBindingCurrency(
  c: Pick<
    _InternalRenderPipelineContext,
    | 'runtime'
    | 'frameState'
    | 'store'
    | 'world'
    | 'pipelineState'
    | 'skylight'
    | 'capturedAtmosphere'
    | 'planarReflectionView'
    | 'planarReflectionAllowed'
  >,
): NonNullable<PerSubmeshMaterialBgDeps['bindingSceneCurrent']> {
  const { runtime, frameState, store, world, pipelineState } = c;
  const owner = (runtime as RenderSystemInternals).viewOwner;
  const lifecycle = frameState.environmentLifecycle;
  const environment = frameState.environmentFrame?.source ?? lifecycle?.activeFrame?.source;
  const handle = c.skylight?.equirectHandle;
  const image = handle === undefined ? undefined : store.getCubemapIbl(handle, world);
  const atmosphere = currentAtmosphereStorage(runtime);
  const capturedAtmosphere = c.capturedAtmosphere;
  const planarView = c.planarReflectionView;
  const planarAllowed = c.planarReflectionAllowed !== false;
  const planarUniform = pipelineState.viewUniformBuffer;
  const environmentCurrent = () =>
    capturedAtmosphere === undefined
      ? sameEnvironmentBindingSource(environment, lifecycle?.activeFrame?.source) &&
        (lifecycle?.activeGeneration === undefined ||
          (!lifecycle.activeGeneration.retired && lifecycle.activeGeneration.scope.isAlive())) &&
        currentAtmosphereStorage(runtime) === atmosphere
      : atmosphereStoragePinned(capturedAtmosphere);
  return (skylight, probeIndex, planar) => {
    const current = handle === undefined ? undefined : store.getCubemapIbl(handle, world);
    return (
      environmentCurrent() &&
      current?.skySh === image?.skySh &&
      current?.prefilterView === image?.prefilterView &&
      current?.brdfLutView === image?.brdfLutView &&
      (!planar ||
        ((planarAllowed ? owner?.captures.planar?.current()?.physical.resolveView : undefined) ===
          planarView &&
          pipelineState.viewUniformBuffer === planarUniform)) &&
      (probeIndex === undefined ||
        owner?.reflectionProbes.materialBindingCurrent(probeIndex, skylight) === true)
    );
  };
}

function sameEnvironmentBindingSource(
  a: EnvironmentSource | undefined,
  b: EnvironmentSource | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.kind === b.kind && (a.kind !== 'image' || (b.kind === 'image' && a.sourceKey === b.sourceKey))
  );
}

/** The optional backdrop and medium views a pass consumes, omitting absent ones. */
function surfaceMediumViews(
  options: MainPassOptions | undefined,
): Pick<
  PerSubmeshMaterialBgDeps,
  | 'transmissionBackdropView'
  | 'surfaceRawDepthView'
  | 'surfaceNearestLayerView'
  | 'surfaceNearestDepthView'
  | 'surfaceFoamSimulationView'
  | 'surfaceFluidSimulation'
> {
  const transmissionBackdropView = options?.transmissionBackdropView;
  const surfaceRawDepthView = options?.surfaceRawDepthView;
  const surfaceNearestLayerView = options?.surfaceNearestLayerView;
  const surfaceNearestDepthView = options?.surfaceNearestDepthView;
  const surfaceFoamSimulationView = options?.surfaceFoamSimulationView;
  const surfaceFluidSimulation = options?.surfaceFluidSimulation;
  return {
    ...(transmissionBackdropView === undefined ? {} : { transmissionBackdropView }),
    ...(surfaceRawDepthView === undefined ? {} : { surfaceRawDepthView }),
    ...(surfaceNearestLayerView === undefined ? {} : { surfaceNearestLayerView }),
    ...(surfaceNearestDepthView === undefined ? {} : { surfaceNearestDepthView }),
    ...(surfaceFoamSimulationView === undefined ? {} : { surfaceFoamSimulationView }),
    ...(surfaceFluidSimulation === undefined ? {} : { surfaceFluidSimulation }),
  };
}

/** Pass-local attachment formats, bundle, membership and slot projection for indirect encode. */
function publishGpuDrivenMaterialSlots(
  c: _InternalRenderPipelineContext,
  resources: GpuDrivenStandardPbrFrameResources,
  options: MainPassOptions,
  colorFormats: readonly GPUTextureFormat[],
  selectedGpuMaterialSlots: ReadonlySet<number> | undefined,
): void {
  resources.colorFormats = colorFormats;
  if (options.sampleCount === undefined) delete resources.sampleCount;
  else resources.sampleCount = options.sampleCount;
  resources.opaqueDepthPrimed = options.opaqueDepthPrimed ?? false;
  if (options.bundleDescriptor === undefined) delete resources.bundleDescriptor;
  else resources.bundleDescriptor = options.bundleDescriptor;
  if (selectedGpuMaterialSlots === undefined) delete resources.selectedMaterialSlots;
  else resources.selectedMaterialSlots = selectedGpuMaterialSlots;
  // The accepted table owns this index. Raw helper callers build their own
  // table here, observing their current borrowed binding rows on each call.
  resources.materialSlotIndicesByBinding =
    c.materialBindingSlots ?? materialSlotsByClass(c.materialBindings);
}

export function publishMaterialBindingPreparer(
  c: _InternalRenderPipelineContext,
  resources: GpuDrivenStandardPbrFrameResources,
  selectedGpuMaterialSlots: ReadonlySet<number> | undefined,
  resolveMaterialBinding: MainPassMaterialBindingResolver,
): void {
  const { world, materialSlots, materialBindings } = c;
  // Only consumers retaining indirect material selections need independently owned results.
  const address: MaterialBindingAddress = {
    byteOffset: 0,
    dynamicOffsetCount: 1,
    reflection: undefined,
  };
  let preparedBindings: Map<number, MainPassMaterialBinding> | undefined;
  resources.prepareMaterialBinding = (slot, standardMaterialLayoutIndex, program) => {
    const material = materialSlots[slot];
    const binding = materialBindings[slot];
    if (material === undefined || binding === undefined) return undefined;
    if (selectedGpuMaterialSlots !== undefined && !selectedGpuMaterialSlots.has(slot))
      return undefined;
    // The accepted direct/scene pair already owns the indirect program. Its
    // group1 projection must also own this binding; direct and scene modules
    // can read different resources even when their parameter schema is equal.
    let materialShaderId = program ?? material.materialShaderId;
    const scenePrograms = material.materialSceneIndexProgramKeys;
    if (program === undefined && scenePrograms !== undefined) {
      materialShaderId = undefined;
      for (const name in scenePrograms) {
        const program = scenePrograms[name];
        if (
          program?.pass === 'forward' &&
          material.materialProgramKeys?.[name] === material.materialShaderId
        ) {
          materialShaderId = program.specializationKey;
          break;
        }
      }
      if (materialShaderId === undefined) return undefined;
    }
    const group = resolveMaterialBinding(
      slot,
      material,
      binding.entityKey,
      binding.world ?? world,
      address,
      materialShaderId,
      standardMaterialLayoutIndex,
    );
    const key = materialLayoutSlotKey(slot, standardMaterialLayoutIndex ?? 0);
    const previous = preparedBindings?.get(key);
    if (
      previous?.group === group &&
      previous.byteOffset === address.byteOffset &&
      previous.dynamicOffsetCount === address.dynamicOffsetCount &&
      previous.reflection === address.reflection
    )
      return previous;
    const result: MainPassMaterialBinding = {
      group,
      byteOffset: address.byteOffset,
      dynamicOffsetCount: address.dynamicOffsetCount,
      ...(address.reflection === undefined ? {} : { reflection: address.reflection }),
    };
    preparedBindings ??= new Map();
    preparedBindings.set(key, result);
    return result;
  };
  resources.recordMaterialPipelineBinding = (slot, pipeline, group) => {
    const material = materialSlots[slot];
    if (material !== undefined) recordIblPipelineBinding(c, material, pipeline, group);
  };
}

function encodeGpuDrivenBatches(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  options: MainPassOptions,
  gpuDriven: NonNullable<MainPassOptions['gpuDriven']>,
  passKind: PassKind,
): void {
  if (c.viewBindGroup === null) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'main-pass Standard PBR view bind group for GPU-driven encode',
      hint: 'publish the current frame view/light/shadow bind group before GPU raster',
    });
  }
  if (c.gpuDrivenStandardPbrFrameResources === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'complete main-pass Standard PBR material bind-group receipt',
      hint: 'finish frame material producer assembly before GPU-driven encode',
    });
  }
  gpuDriven.projection.encode(
    c.viewBindGroup,
    pass,
    gpuDriven.resources,
    c.gpuDrivenStandardPbrFrameResources,
    options.gpuDrivenFilter,
    selectForwardFragmentEntry({
      passKind,
      fragmentEntry: options.fragmentEntryPoint,
      oitAccumulate: options.recordMode === 'oit-accumulate',
      viewOffset: c.viewBindGroupDynamicOffset ?? 0,
      atmosphereCapture: c.capturedAtmosphere !== undefined,
    }),
    options.coverageOnly ?? false,
    gpuDriven.phase ?? 'all',
    options.seededDepth === true,
    c.viewBindGroupDynamicOffset ?? 0,
  );
}

/** One CPU material selection for graph admission and geometry recording. */
export function selectMainPassDispatch(
  c: MaterialSelectionContext,
  selector: PassSelector,
): DispatchList {
  return (
    c.mainPassMaterialSelection?.selectDispatch?.(c, selector) ??
    filterDispatchBySelector(c.dispatch, selector)
  );
}

export function selectMainPassMaterials(
  c: MaterialSelectionContext,
  selector: PassSelector | undefined,
  recordMode: MainPassOptions['recordMode'],
  excludeSelector?: PassSelector,
): MainPassMaterialSelection {
  if (c.validatedOrdered.length === 0) return EMPTY_MATERIAL_SELECTION;
  return c.mainPassMaterialSelection === undefined
    ? selectMainPassMaterialsUncached(c, selector, recordMode, excludeSelector)
    : c.mainPassMaterialSelection.resolve(c, selector, recordMode, excludeSelector);
}

function selectMainPassMaterialsUncached(
  c: MaterialSelectionContext,
  selector: PassSelector | undefined,
  recordMode: MainPassRecordMode,
  excludeSelector?: PassSelector,
): MainPassMaterialSelection {
  return matchedMaterialsForRecordMode(
    c,
    selector === undefined
      ? null
      : buildMatchedMaterialHandlesByRenderable(c.dispatch, selector, excludeSelector),
    recordMode,
  );
}

/** Qualify the same receiver selection used by the mandatory geometry pass.
 * This is a selection-domain check, not a replacement for cooked output ABI validation. */
export function hasSsrSceneInputs(
  c: {
    readonly renderables: FrameList<import('../render-system-extract').RenderableSnapshot>;
    readonly dispatch: import('../render-system-extract').DispatchList;
    readonly materialFrame: import('../scene/material-dispatch').MaterialFrame;
  },
  renderPath: 'forward' | 'deferred',
  pairedMsaaSurface = false,
): boolean {
  const read = (resource: import('../material-resource').MaterialResource) => {
    const material = c.materialFrame?.get(resource)?.snapshot;
    if (material === undefined)
      throw new Error('SSR admission requires the accepted material frame');
    return material;
  };
  if (renderPath === 'forward' && !pairedMsaaSurface)
    return (
      c.renderables.length > 0 &&
      c.renderables.every((source) =>
        (source.materials.length === 0 ? [source.material] : source.materials).every((resource) =>
          isCanonicalStandardPbrMaterialShader(read(resource).materialShaderId),
        ),
      )
    );
  const selected = buildMatchedMaterialHandlesByRenderable(
    c.dispatch,
    pairedMsaaSurface ? FORWARD_PASS_SELECTOR : DEFERRED_PASS_SELECTOR,
  );
  if (selected === null) return false;
  let receivers = 0;
  let nextIndex = 0;
  for (const source of c.renderables) {
    const index = nextIndex++;
    const handles = selected.get(index);
    if (handles === undefined) continue;
    const slots = source.materials;
    for (let slot = 0; slot < Math.max(1, slots.length); slot++) {
      const material = read(
        slots.length === 0
          ? source.material
          : (slots[slot] as import('../material-resource').MaterialResource),
      );
      if (!handles.has(material.materialHandle ?? 0) || !matchesRecordMode(material, 'opaque'))
        continue;
      if (material.deferredPass !== true) return false;
      receivers++;
    }
  }
  return receivers > 0;
}
