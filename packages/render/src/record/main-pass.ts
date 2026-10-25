import { probeVideoHighPerfUpload } from '@forgeax/engine-graphics-extras';
import type { GraphResourceResolver } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type RenderBundleEncoderDescriptor,
  RhiError,
  type RhiRenderPassEncoder,
  type TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type PassKind, type PassSelector } from '@forgeax/engine-types';
import { meshSsboBufferBinding } from '../assembly/mesh-ssbo-grow';
import {
  createHdrpSkinUnifiedBindGroup,
  createHdrpUnifiedBindGroup,
  getOrCreateHdrpBuffers,
  type HdrpBuffers,
  type SsaoBindOptions,
} from '../hdrp-buffers';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { standardTopologyBindGroupReady } from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderRecordPhase } from '../render-contract';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type { DispatchList, MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { materialPasses } from '../scene/material-dispatch';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
  matchPass,
} from '../systems/pass-selector';
import type { ValidatedRenderable } from './frame-snapshot';
import { getOpaqueResourceIdentity } from './frame-snapshot';
import { recordGeometryDraws } from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg as buildPerSubmeshMaterialBgImpl,
  materialDiagnosticsEnabled,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import { recordSpritePass } from './main-pass-sprite-draws';
import {
  type MaterialRecordMode,
  matchesRecordMode,
  materialMatchesPass,
} from './material-pass-selection';
import { materialUniformSlot } from './material-uniforms';
import { getOrCreateFromChainResult } from './mesh-ssbo';
import { reflectionProbeMaterial } from './reflection-probe-material';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_PER_ENTITY_STRIDE, MATERIAL_UNIFORM_BYTES } from './render-context';
import { buildMatchedMaterialHandlesByRenderable, filterDispatchBySelector } from './shadow-pass';
import { selectForwardFragmentEntry } from './standard-opaque-entry';

/** Chain key standing in for the SSAO view when group(2) binds the fallback. */
const NO_SSAO_VIEW = {};

export type MainPassOptions = {
  readonly bundleDescriptor?: RenderBundleEncoderDescriptor;
  readonly selection?: { readonly worldId: number; readonly entities: readonly number[] };
  readonly colorFormats?: readonly GPUTextureFormat[];
  readonly passKind?: PassKind;
  readonly recordMode?: MaterialRecordMode;
  readonly gpuDrivenFilter?: RenderPipelineGpuDrivenFilter;
  /** Write transparent fragment depth for depth-bounded medium transport. */
  readonly transparentDepthWrite?: boolean;
  /** Exclude material/pass pairs already consumed by an earlier graph lane. */
  readonly excludeSelector?: PassSelector;
  readonly transmissionBackdropView?: TextureView | null;
  /** Independent sampled raw depth produced before the medium passes. */
  readonly surfaceRawDepthView?: TextureView | null;
  /** Nearest-layer color produced by the preceding medium pass. */
  readonly surfaceNearestLayerView?: TextureView | null;
  /** Nearest-layer depth produced by the preceding medium pass. */
  readonly surfaceNearestDepthView?: TextureView | null;
  /** Surface shader fragment entry selected by the typed pass owner. */
  readonly fragmentEntryPoint?: string;
  /** Select the material temporal entry's binary coverage output. */
  readonly coverageOnly?: boolean;
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
  for (let slot = 0; slot < materials.length; slot++) {
    const snapshot = materials[slot];
    if (snapshot === undefined || (mode !== undefined && !matchesRecordMode(snapshot, mode)))
      continue;
    if (
      materialMatchesPass(
        { snapshot, passes: materialPasses(snapshot) },
        selector,
        mode,
        excludeSelector,
      )
    )
      selected.add(slot);
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
  for (const entry of c.pipelinePreparationEntries ?? []) {
    for (const sm of entry.mesh.submeshes) {
      const material = c.materialFrame?.get(
        entry.source.materials[sm.materialSlot] ?? entry.source.material,
      )?.snapshot;
      if (material === undefined) throw new Error('Pipeline preparation has no accepted material');
      if (
        (mode !== undefined && !matchesRecordMode(material, mode)) ||
        preparationMaterialExcluded(entry, material.materialHandle ?? 0, excludeSelector)
      )
        continue;
      for (const pass of entry.source.pipelinePreparation ?? []) {
        if (
          pass.materialHandle === (material.materialHandle ?? 0) &&
          matchPass(pass.tags, selector)
        )
          return true;
      }
    }
  }
  return false;
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
  if (!hasMainPassPipelinePreparation(c, selector, options.recordMode, options.excludeSelector))
    return;
  const mode = options.recordMode;
  const blended = mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual';
  recordGeometryDraws(
    {
      ...c,
      ...(colorFormats[0] === undefined ? {} : { transparentColorFormat: colorFormats[0] }),
      msaaActive: sampleCount === 4,
      translucentFog: blended && (c.viewBindGroupDynamicOffset ?? 0) === 0,
      splitLdrSprite: blended ? false : c.splitLdrSprite,
    },
    undefined,
    null,
    [],
    sampleCount,
    null,
    null,
    undefined,
    options.passKind ?? 'forward',
    undefined,
    colorFormats,
    options.coverageOnly ?? false,
    options.fragmentEntryPoint,
    surfacePassForRecordMode(mode),
    options.transparentDepthWrite ?? false,
    oitPhaseForRecordMode(mode),
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

type MainPassMaterialSelection = ReadonlyMap<number, ReadonlySet<number>> | null;
type MainPassRecordMode = MainPassOptions['recordMode'];

/** One finalized record frame owns its selections; nothing enters retained frameState. */
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
  if (mode === 'transmission') return 2;
  if (mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual') return 3;
  if (mode === 'translucent' || mode === 'translucent-before-transmission') return 5;
  return 4;
}

/** Capture finalized facts only after the record owner has ordered its validation rows. */
export function createMainPassMaterialSelectionOwner(
  input: Omit<MaterialSelectionContext, 'mainPassMaterialSelection'>,
): MainPassMaterialSelectionOwner {
  const { dispatch, validatedOrdered, materialSlots, materialSlotIndices } = input;
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
  return {
    selectDispatch(c, selector) {
      const index = stockSelectorIndex(selector);
      if (c.dispatch !== dispatch || c.validatedOrdered !== validatedOrdered || index < 0)
        return filterDispatchBySelector(c.dispatch, selector);
      selectedDispatch[index] ??= filterDispatchBySelector(dispatch, selector);
      return selectedDispatch[index];
    },
    resolve(c, selector, mode, excludeSelector) {
      const selectorIndex = stockSelectorIndex(selector);
      const excludeIndex = stockSelectorIndex(excludeSelector);
      // Capture/camera overrides and borrowed custom selectors keep every read.
      if (
        c.dispatch !== dispatch ||
        c.validatedOrdered !== validatedOrdered ||
        c.materialSlots !== materialSlots ||
        c.materialSlotIndices !== materialSlotIndices ||
        selectorIndex < 0 ||
        excludeIndex < 0
      )
        return selectMainPassMaterialsUncached(c, selector, mode, excludeSelector);
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
  matchedMaterials: ReadonlyMap<number, ReadonlySet<number>> | null,
  mode: MaterialRecordMode | undefined,
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (mode === undefined) return matchedMaterials;
  const surfaceMode =
    mode === 'single-layer-medium-nearest-layer' || mode === 'single-layer-medium-color';
  const filtered = new Map<number, ReadonlySet<number>>();
  if (mode === 'transmission' && matchedMaterials === null) return filtered;
  let nextRow = 0;
  for (const entry of c.validatedOrdered) {
    const row = nextRow++;
    const dispatchHandles = matchedMaterials?.get(entry.renderableIndex);
    if (!surfaceMode && matchedMaterials !== null && dispatchHandles === undefined) continue;
    let handles: Set<number> | undefined;
    for (const slot of c.materialSlotIndices[row] ?? []) {
      const material = c.materialSlots[slot];
      if (material === undefined) throw new Error('Material selection has no submitted material');
      const handle = material.materialHandle ?? 0;
      if (!surfaceMode && dispatchHandles !== undefined && !dispatchHandles.has(handle)) continue;
      if (!matchesRecordMode(material, mode)) continue;
      if (!surfaceMode && dispatchHandles?.size === 1) {
        filtered.set(entry.renderableIndex, dispatchHandles);
        break;
      }
      handles ??= new Set<number>();
      handles.add(handle);
    }
    if (handles !== undefined) filtered.set(entry.renderableIndex, handles);
  }
  return filtered;
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: main forward
 * (geometry) pass recording into the graph-owned `pass`; the graph declares
 * its attachments, load ops and resolves. The geometry + optional LDR
 * sprite-split draws share that pass.
 */
export function encodeMainPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  selector?: PassSelector,
  options?: MainPassOptions,
): GpuDrivenStandardPbrFrameResources | undefined {
  const {
    validatedOrdered,
    dispatch,
    viewBindGroup,
    viewBindGroupDynamicOffset = 0,
    gpuDrivenStandardPbrFrameResources,
  } = c;
  const passKind = options?.passKind ?? 'forward';
  const recordMode = options?.recordMode;
  assertRecordModeBackdrop(recordMode, options?.transmissionBackdropView);
  const clusteredBindGroupMissing = reportClusteredStandardGroupMissing(c, options);
  const meshGroup2 = resolveStandardGroup2(c, options);
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
  // Shared GPU materials are work even when there are no direct draw rows.
  if (
    clusteredBindGroupMissing ||
    !(
      selectsCpuDraws(validatedOrdered, matchedMaterials) ||
      hasGpuMaterials ||
      hasMainPassPipelinePreparation(c, passSelector, recordMode, options?.excludeSelector)
    )
  )
    return gpuDrivenStandardPbrFrameResources;

  // Per-entity material bind groups assemble inside the draw loops from the
  // scene-level Skylight resources resolved once here.
  const { skylightResources, activeViews } = prepareMaterialSkylight(c);
  if (materialDiagnosticsEnabled()) publishIblBindingInspection(c, skylightResources, activeViews);
  const resolveMaterialBindGroup = createMaterialBindGroupResolver(c, options, skylightResources);
  const colorFormats = mainPassColorFormats(c, options);
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
      resolveMaterialBindGroup,
    );
  }

  // GPU-driven batches carry only opaque queues, so they encode before the
  // CPU list: a later-queue CPU draw (e.g. depthCompare 'always' x-ray) must
  // land after the opaque geometry it is meant to overdraw.
  if (hasGpuMaterials && options?.gpuDriven !== undefined)
    encodeGpuDrivenBatches(c, pass, options, options.gpuDriven, passKind);

  // A preparation-only lane (hidden transparent PSOs, no validated rows) has
  // no frame view group and records no draws; binding null with dynamic
  // offsets is a GPU validation error that fails the whole frame.
  if (viewBindGroup !== null) pass.setBindGroup(0, viewBindGroup, [viewBindGroupDynamicOffset, 0]);

  const recordContext = mainPassRecordContext(c, recordMode);
  const recordGeometry = (): void => {
    recordGeometryDraws(
      recordContext,
      pass,
      matchedMaterials,
      c.materialSlotIndices,
      c.msaaActive ? 4 : 1,
      meshGroup2,
      c.meshBindGroup,
      resolveMaterialBindGroup,
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
      (entry, index) => preparationSubmeshExcluded(entry, index, options?.excludeSelector),
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
      resolveMaterialBindGroup,
      selectedDispatch,
    );
  return gpuDrivenStandardPbrFrameResources;
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
    recordMode === 'single-layer-medium-color'
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
  if (!consumesGroup2 || standardTopologyBindGroupReady(c.standardLighting, c.hdrpClusterBindGroup))
    return false;
  c.runtime.errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'clustered Standard frame has a unified group(2) BindGroup',
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

/**
 * Standard clustered lighting swaps the group(2) bindGroup for the unified
 * 7-entry layout (mesh SSBO at binding 0 + cluster 4 buffer at bindings 3..6).
 * The dynamic offset from the draw's physical mesh slot stays valid because
 * the unified BGL binds the SAME mesh SSBO at binding 0. When clustered
 * lighting is not selected the ordinary mesh bind group path runs verbatim.
 * GPU-driven producers receive the same group(2) at this binding seam.
 */
function resolveStandardGroup2(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
): BindGroup | null {
  const clusteredLighting = c.standardLighting?.kind === 'clustered';
  const hdrpBuffers = clusteredLighting
    ? getOrCreateHdrpBuffers(c.runtime, c.frameState.installedPipelineConfig?.clusterGrid)
    : null;
  const meshGroup2 = clusteredLighting
    ? (resolveHdrpSsaoBindGroup(c, hdrpBuffers) ?? c.hdrpClusterBindGroup)
    : c.meshBindGroup;
  const resources = c.gpuDrivenStandardPbrFrameResources;
  if (options?.gpuDriven !== undefined && resources !== undefined) {
    // The GPU-driven owner prepares before transient graph resources exist;
    // publish the actual Standard group(2) here, immediately before indirect
    // encoding.
    resources.clusterBindGroup = clusteredLighting && meshGroup2 !== null ? meshGroup2 : undefined;
    publishGpuDrivenClusterGroups(c, resources, hdrpBuffers);
  }
  return meshGroup2;
}

/**
 * feat-20260612-hdrp-ssao wiring fix: when the HDRP forward pass resolved a
 * real `ssaoBlurred` view (stashed on ctx by the pass execute closure), build
 * the unified group(2) bind group with that view at binding 7 so fs_main reads
 * the actual occlusion factor instead of the 1x1 white fallback. The default
 * `hdrpClusterBindGroup` (built ahead of graph.execute) always carries the
 * fallback because the transient SSAO texture does not exist that early.
 * Graph resource leases keep the resolved view stable until replacement.
 * Reuse follows the physical mesh, lighting bundle and SSAO view identities.
 */
function resolveHdrpSsaoBindGroup(
  c: _InternalRenderPipelineContext,
  hdrpBuffers: HdrpBuffers | null,
): BindGroup | null {
  const ssaoView = c.hdrpSsaoBlurredView;
  if (c.hdrpClusterBindGroup === null || ssaoView === undefined || hdrpBuffers === null)
    return null;
  const { runtime } = c;
  const meshBuffer = meshSsboBufferBinding(c.pipelineState.meshStorageBuffer, 0).buffer;
  const cached = getOrCreateFromChainResult(
    c.frameState.meshBindGroupCache,
    [meshBuffer, hdrpBuffers, ssaoView],
    'hdrp-unified',
    () => {
      const group = createHdrpUnifiedBindGroup(runtime, hdrpBuffers, meshBuffer, {
        enabled: true,
        ssaoBlurredView: ssaoView,
      });
      return group === null ? err(undefined) : ok(group);
    },
    c.bindGroupCounts,
  );
  return cached.ok ? cached.value : null;
}

/**
 * Device-scoped chain keyed on every bound handle: an unchanged batch re-emits
 * the identical group(2), so its render bundle segment stays reusable instead
 * of mismatching on a per-frame bind group identity.
 */
function publishGpuDrivenClusterGroups(
  c: _InternalRenderPipelineContext,
  resources: GpuDrivenStandardPbrFrameResources,
  hdrpBuffers: HdrpBuffers | null,
): void {
  if (hdrpBuffers === null) {
    resources.clusterBindGroupForMesh = undefined;
    resources.clusterBindGroupForSkin = undefined;
    return;
  }
  const { runtime, pipelineState, frameState, bindGroupCounts } = c;
  const ssaoView = c.hdrpSsaoBlurredView;
  const ssao: SsaoBindOptions =
    ssaoView === undefined ? { enabled: false } : { enabled: true, ssaoBlurredView: ssaoView };
  const lighting = [hdrpBuffers, ssaoView ?? NO_SSAO_VIEW];
  const cachedGroup = (
    handles: readonly object[],
    variant: string,
    create: () => BindGroup | null,
  ): BindGroup | undefined => {
    const result = getOrCreateFromChainResult(
      frameState.meshBindGroupCache,
      handles,
      variant,
      () => {
        const created = create();
        return created === null ? err(undefined) : ok(created);
      },
      bindGroupCounts,
    );
    return result.ok ? result.value : undefined;
  };
  resources.clusterBindGroupForMesh = (meshBuffer, bindingBytes) =>
    cachedGroup(
      [meshBuffer, hdrpBuffers.unifiedBindGroupLayout, ...lighting],
      `gpu-driven-hdrp:${bindingBytes}`,
      () => createHdrpUnifiedBindGroup(runtime, hdrpBuffers, meshBuffer, ssao, bindingBytes),
    );
  resources.clusterBindGroupForSkin = (meshBuffer, meshBindingBytes, task) => {
    const skinLayout = pipelineState.hdrpSkinMeshBindGroupLayout;
    if (skinLayout === null) return undefined;
    return cachedGroup(
      [meshBuffer, task.data, task.auxiliary, skinLayout, ...lighting],
      `gpu-driven-hdrp-skin:${meshBindingBytes}:${task.dataSize}:${task.auxiliarySize}`,
      () =>
        createHdrpSkinUnifiedBindGroup(
          runtime,
          hdrpBuffers,
          skinLayout,
          meshBuffer,
          task,
          ssao,
          meshBindingBytes,
        ),
    );
  };
}

/** Restrict material membership to the explicitly selected entities of one World. */
function selectEntityMaterials(
  c: _InternalRenderPipelineContext,
  matchedMaterials: MainPassMaterialSelection,
  selection: NonNullable<MainPassOptions['selection']>,
): Map<number, ReadonlySet<number>> {
  const entities = new Set(selection.entities);
  const selected = new Map<number, ReadonlySet<number>>();
  let nextIndex = 0;
  for (const entry of c.validatedOrdered) {
    const index = nextIndex++;
    if (entry.source.worldId !== selection.worldId || !entities.has(entry.source.entityKey))
      continue;
    const handles = matchedMaterials?.get(entry.renderableIndex);
    if (matchedMaterials !== null && handles === undefined) continue;
    selected.set(
      entry.renderableIndex,
      handles ??
        new Set(
          (c.materialSlotIndices[index] ?? []).map(
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
  validatedOrdered: readonly ValidatedRenderable[],
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
): _InternalRenderPipelineContext {
  if (recordMode === undefined) return c;
  const blendedRecordMode =
    recordMode === 'transparent' ||
    recordMode === 'translucent' ||
    recordMode === 'translucent-before-transmission' ||
    recordMode === 'oit-accumulate' ||
    recordMode === 'oit-residual';
  return {
    ...c,
    translucentFog: blendedRecordMode && (c.viewBindGroupDynamicOffset ?? 0) === 0,
    splitLdrSprite: blendedRecordMode ? false : c.splitLdrSprite,
  };
}

function surfacePassForRecordMode(
  mode: MaterialRecordMode | undefined,
): 'nearest-layer' | 'color' | undefined {
  if (mode === 'single-layer-medium-nearest-layer') return 'nearest-layer';
  return mode === 'single-layer-medium-color' ? 'color' : undefined;
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
): void {
  const { runtime, frameState, pipelineState } = c;
  const activeCache =
    c.skylight === undefined
      ? undefined
      : c.store.getCubemapIbl(c.skylight.equirectHandle, c.world);
  const prefilterViewMipCount =
    activeCache?.prefilterLevelCount ?? (activeViews === undefined ? 1 : 0);
  const deviceGeneration = runtime.deviceScope.generation;
  const resource = (view: object, sampler: object) => ({
    viewIdentity: getOpaqueResourceIdentity(view),
    samplerIdentity: getOpaqueResourceIdentity(sampler),
    deviceGeneration,
  });
  frameState.iblBindingInspection = {
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
        skylightResources.irradianceView as object,
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
  };
}

/**
 * Per-submesh material bind-group resolver shared by the geometry pass and
 * the LDR blend sub-pass, so a transparent PBR submesh binds the identical
 * metallic/roughness/normal/emissive/occlusion + Skylight layout the geometry
 * pass uses. Material snapshots are interned by extract-owned identity before
 * this pass; repeated scene instances share one UBO slot, and a pass prepares
 * a slot's group only when its first actual draw consumes it. Selection keys
 * use the extracted frame index, never RenderResourceScope.identity.
 */
function createMaterialBindGroupResolver(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
  skylightResources: SkylightBindGroupResources,
) {
  const { world, materialBindings } = c;
  const hasProbeBindings = (c.reflectionProbes?.table.rows.length ?? 0) > 0;
  const deps = createPerSubmeshMaterialBgDeps(c, options, skylightResources, hasProbeBindings);
  const preparedMaterialBindGroups = new Map<number, BindGroup>();
  return (
    materialSlot: number,
    material: MaterialSnapshot,
    entityKey: number | undefined,
    materialWorld: RenderResourceScope = world,
    materialShaderId: string | undefined = material.materialShaderId,
  ): BindGroup => {
    const shared =
      !hasProbeBindings &&
      (material.videoTextureFields?.size ?? 0) === 0 &&
      materialShaderId === material.materialShaderId &&
      materialShaderId !== POINTS_LINES_MATERIAL_SHADER_ID;
    const cached = shared ? preparedMaterialBindGroups.get(materialSlot) : undefined;
    if (cached !== undefined) return cached;
    const group = buildPerSubmeshMaterialBgImpl(
      deps,
      material,
      entityKey,
      materialWorld,
      materialShaderId,
      materialSlot,
      materialBindings[materialSlot]?.resourceClass,
    );
    if (shared) preparedMaterialBindGroups.set(materialSlot, group);
    return group;
  };
}

/**
 * feat-20260623-world-space-video-asset M4 / w17 (D-2 / AC-09): video sources
 * take the high-perf GPUExternalTexture upload only when the RhiCaps-based
 * capability probe admits it; otherwise copyExternalImageToTexture is the
 * sole route. The material UBO slice mirrors the post-split Standard schema
 * (MATERIAL_UNIFORM_BYTES).
 */
function createPerSubmeshMaterialBgDeps(
  c: _InternalRenderPipelineContext,
  options: MainPassOptions | undefined,
  skylightResources: SkylightBindGroupResources,
  hasProbeBindings: boolean,
): PerSubmeshMaterialBgDeps {
  const { runtime, world, frameState } = c;
  const worldIndices = hasProbeBindings
    ? new Map((c.resourceScopes ?? [world]).map((scope, index) => [scope, index] as const))
    : undefined;
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
    resolveRenderTargetTextureSource: runtime.resolveRenderTargetTextureSource,
    resolveReflectionProbeResources: (materialWorld, entityKey, resourceClass) => {
      const reflectionProbes = c.reflectionProbes;
      return reflectionProbes === undefined || !hasProbeBindings
        ? undefined
        : reflectionProbeMaterial(
            reflectionProbes,
            skylightResources,
            resourceClass,
            worldIndices?.get(materialWorld),
            entityKey,
          );
    },
    ...(c.planarReflectionView === undefined
      ? {}
      : { planarReflectionView: c.planarReflectionView }),
    materialBgShared: frameState.materialBgShared,
    materialBgAssemblyCache: c.materialBgAssemblyCache,
    diagnostics: materialDiagnosticsEnabled(),
    frameState,
    bindGroupCounts: c.bindGroupCounts,
    ...(sceneMaterialBuffer === undefined ? {} : { sceneMaterialBuffer }),
    ...surfaceMediumViews(options),
  };
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
> {
  const transmissionBackdropView = options?.transmissionBackdropView;
  const surfaceRawDepthView = options?.surfaceRawDepthView;
  const surfaceNearestLayerView = options?.surfaceNearestLayerView;
  const surfaceNearestDepthView = options?.surfaceNearestDepthView;
  return {
    ...(transmissionBackdropView === undefined ? {} : { transmissionBackdropView }),
    ...(surfaceRawDepthView === undefined ? {} : { surfaceRawDepthView }),
    ...(surfaceNearestLayerView === undefined ? {} : { surfaceNearestLayerView }),
    ...(surfaceNearestDepthView === undefined ? {} : { surfaceNearestDepthView }),
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
  if (options.bundleDescriptor === undefined) delete resources.bundleDescriptor;
  else resources.bundleDescriptor = options.bundleDescriptor;
  if (selectedGpuMaterialSlots === undefined) delete resources.selectedMaterialSlots;
  else resources.selectedMaterialSlots = selectedGpuMaterialSlots;
  // Rebuilt for every pass: keep each material's class map and refill it in
  // place, then drop materials this pass no longer binds. The GPU-driven
  // encoder only reads this table during the pass.
  const bindings = resources.materialSlotIndicesByBinding;
  for (const classes of bindings.values()) classes.clear();
  for (let slot = 0; slot < c.materialSlots.length; slot++) {
    const binding = c.materialBindings[slot];
    if (binding === undefined) continue;
    const resource = binding.material;
    let classes = bindings.get(resource);
    if (classes === undefined) {
      classes = new Map();
      bindings.set(resource, classes);
    }
    classes.set(binding.resourceClass, slot);
  }
  for (const resource of bindings.keys())
    if (bindings.get(resource)?.size === 0) bindings.delete(resource);
}

/** Prepare a batch's exact physical material binding only when it is recorded. */
function publishMaterialBindingPreparer(
  c: _InternalRenderPipelineContext,
  resources: GpuDrivenStandardPbrFrameResources,
  selectedGpuMaterialSlots: ReadonlySet<number> | undefined,
  resolveMaterialBindGroup: ReturnType<typeof createMaterialBindGroupResolver>,
): void {
  const { runtime, world, materialSlots, materialBindings, pipelineState } = c;
  resources.prepareMaterialBinding = (slot) => {
    const material = materialSlots[slot];
    const binding = materialBindings[slot];
    if (material === undefined || binding === undefined) return undefined;
    if (selectedGpuMaterialSlots !== undefined && !selectedGpuMaterialSlots.has(slot))
      return undefined;
    return {
      group: resolveMaterialBindGroup(slot, material, binding.entityKey, binding.world ?? world),
      byteOffset: meshSsboBufferBinding(
        pipelineState.materialUniformBuffer,
        materialUniformSlot(runtime, material) * MATERIAL_PER_ENTITY_STRIDE,
      ).byteOffset,
    };
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
    // Indirect draws bind the base View slot (offset 0) and carry only opaque
    // queues, so outside atmosphere captures their forward entry skips the
    // translucent fog chain exactly like direct draws.
    selectForwardFragmentEntry({
      passKind,
      fragmentEntry: options.fragmentEntryPoint,
      oitAccumulate: options.recordMode === 'oit-accumulate',
      viewOffset: 0,
      atmosphereCapture: c.capturedAtmosphere !== undefined,
    }),
    options.coverageOnly ?? false,
    gpuDriven.phase ?? 'all',
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
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (c.validatedOrdered.length === 0) return new Map();
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
): boolean {
  const read = (resource: import('../material-resource').MaterialResource) => {
    const material = c.materialFrame?.get(resource)?.snapshot;
    if (material === undefined)
      throw new Error('SSR admission requires the accepted material frame');
    return material;
  };
  if (renderPath === 'forward')
    return (
      c.renderables.length > 0 &&
      c.renderables.every(
        (source) => read(source.material).materialShaderId === 'forgeax::default-standard-pbr',
      )
    );
  const selected = buildMatchedMaterialHandlesByRenderable(c.dispatch, DEFERRED_PASS_SELECTOR);
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
