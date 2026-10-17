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
  type SsaoBindOptions,
} from '../hdrp-buffers';
import { getOrCreateIblCache } from '../ibl/IblPipelineCache';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { buildBeginRenderPassDescriptor, standardTopologyBindGroupReady } from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderRecordPhase } from '../render-contract';
import type {
  GpuDrivenDrawPhase,
  GpuDrivenStandardPbrFrameResources,
  RenderPipelineGpuDrivenFilter,
  RenderPipelineGpuDrivenProjection,
} from '../render-pipeline';
import type { MaterialSnapshot } from '../render-system-extract';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
  matchPass,
} from '../systems/pass-selector';
import { resolveReflectionProbeBinding } from './frame-lighting';
import type { ValidatedRenderable } from './frame-snapshot';
import { getOpaqueResourceIdentity, worldEntityKey } from './frame-snapshot';
import { recordGeometryDraws } from './main-pass-geometry';
import {
  buildPerSubmeshMaterialBg as buildPerSubmeshMaterialBgImpl,
  type PerSubmeshMaterialBgDeps,
  prepareMaterialSkylight,
} from './main-pass-material';
import { recordSpritePass } from './main-pass-sprite-draws';
import { getOrCreateFromChainResult } from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';
import { MATERIAL_UNIFORM_BYTES } from './render-context';
import { buildMatchedMaterialHandlesByRenderable, filterDispatchBySelector } from './shadow-pass';
import { selectForwardFragmentEntry } from './standard-opaque-entry';

/** Chain key standing in for the SSAO view when group(2) binds the fallback. */
const NO_SSAO_VIEW = {};
const CULLED_GPU_MATERIAL_SLOTS: readonly number[] = Object.freeze([]);

function materialDiagnosticsEnabled(): boolean {
  if (typeof globalThis !== 'object' || globalThis === null || !('process' in globalThis)) {
    return false;
  }
  const processValue = (
    globalThis as {
      readonly process?: { readonly env?: Record<string, string | undefined> };
    }
  ).process;
  return processValue?.env?.FORGEAX_MATERIAL_DIAGNOSTICS === '1';
}

export type MainPassOptions = {
  readonly bundleDescriptor?: RenderBundleEncoderDescriptor;
  readonly selection?: { readonly worldId: number; readonly entities: readonly number[] };
  readonly colorViews?: readonly (TextureView | null)[];
  readonly colorFormats?: readonly GPUTextureFormat[];
  readonly depthView?: TextureView | null;
  readonly passKind?: PassKind;
  readonly clearColor?: readonly [number, number, number, number];
  readonly recordMode?:
    | 'opaque'
    | 'transmission'
    | 'transparent'
    | 'oit-accumulate'
    | 'oit-residual'
    | 'single-layer-medium-nearest-layer'
    | 'single-layer-medium-color';
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

function isTransmissionMaterial(material: MaterialSnapshot): boolean {
  return (
    material.materialShaderId === 'forgeax::default-standard-pbr' &&
    typeof material.paramSnapshot?.transmission === 'number' &&
    material.paramSnapshot.transmission > 0
  );
}

function matchesRecordMode(
  material: MaterialSnapshot,
  mode:
    | 'opaque'
    | 'transmission'
    | 'transparent'
    | 'oit-accumulate'
    | 'oit-residual'
    | 'single-layer-medium-nearest-layer'
    | 'single-layer-medium-color',
): boolean {
  const medium =
    material.surfaceModel === 'single-layer-medium' ||
    material.materialShaderId === 'forgeax::single-layer-medium';
  if (mode === 'single-layer-medium-nearest-layer' || mode === 'single-layer-medium-color') {
    return medium;
  }
  const transmission = isTransmissionMaterial(material);
  if (mode === 'transmission') return transmission;
  if (mode === 'transparent' || mode === 'oit-accumulate' || mode === 'oit-residual') {
    return material.transparent === true && !transmission && !medium;
  }
  return !transmission && material.transparent !== true && !medium;
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
    (entry.source.materials[submesh.materialSlot] ?? entry.source.material).materialHandle ?? 0,
    selector,
  );
}

/** Explicit preparation is work even when no visible draw selects this lane. */
export function hasMainPassPipelinePreparation(
  c: Pick<_InternalRenderPipelineContext, 'pipelinePreparationEntries'>,
  selector: PassSelector,
  mode: MainPassOptions['recordMode'],
  excludeSelector?: PassSelector,
): boolean {
  for (const entry of c.pipelinePreparationEntries ?? []) {
    for (const sm of entry.mesh.submeshes) {
      const material = entry.source.materials[sm.materialSlot] ?? entry.source.material;
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
    mode === 'single-layer-medium-nearest-layer'
      ? 'nearest-layer'
      : mode === 'single-layer-medium-color'
        ? 'color'
        : undefined,
    options.transparentDepthWrite ?? false,
    mode === 'oit-accumulate' ? 'accumulate' : mode === 'oit-residual' ? 'residual' : undefined,
    (pass, material) =>
      matchPass(pass.tags, selector) && (mode === undefined || matchesRecordMode(material, mode)),
    (entry, index) =>
      skipDraw?.(entry, index) === true ||
      preparationSubmeshExcluded(entry, index, options.excludeSelector),
  );
}

type MaterialSelectionContext = Pick<
  _InternalRenderPipelineContext,
  'dispatch' | 'validatedOrdered' | 'mainPassMaterialSelection'
>;

type MainPassMaterialSelection = ReadonlyMap<number, ReadonlySet<number>> | null;
type MainPassRecordMode = MainPassOptions['recordMode'];

/** One finalized record frame owns its selections; nothing enters retained frameState. */
export interface MainPassMaterialSelectionOwner {
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
  return 4;
}

/** Capture finalized facts only after the record owner has ordered its validation rows. */
export function createMainPassMaterialSelectionOwner(
  input: Pick<MaterialSelectionContext, 'dispatch' | 'validatedOrdered'>,
): MainPassMaterialSelectionOwner {
  const { dispatch, validatedOrdered } = input;
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
    resolve(c, selector, mode, excludeSelector) {
      const selectorIndex = stockSelectorIndex(selector);
      const excludeIndex = stockSelectorIndex(excludeSelector);
      // Capture/camera overrides and borrowed custom selectors keep every read.
      if (
        c.dispatch !== dispatch ||
        c.validatedOrdered !== validatedOrdered ||
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

const EMPTY_MATERIAL_HANDLES: readonly number[] = Object.freeze([]);

export function matchedMaterialsForRecordMode(
  c: MaterialSelectionContext,
  matchedMaterials: ReadonlyMap<number, ReadonlySet<number>> | null,
  mode:
    | 'opaque'
    | 'transmission'
    | 'transparent'
    | 'oit-accumulate'
    | 'oit-residual'
    | 'single-layer-medium-nearest-layer'
    | 'single-layer-medium-color'
    | undefined,
): ReadonlyMap<number, ReadonlySet<number>> | null {
  if (mode === undefined) return matchedMaterials;
  const surfaceMode =
    mode === 'single-layer-medium-nearest-layer' || mode === 'single-layer-medium-color';
  const filtered = new Map<number, ReadonlySet<number>>();
  for (const entry of c.validatedOrdered) {
    const dispatchHandles = matchedMaterials?.get(entry.renderableIndex);
    // Surface graph membership is owned by the resolved surface model. A
    // Surface-authored pass does not need to duplicate the generic Forward
    // LightMode tag: its prepared direct program already carries the pass
    // specialization selected by the material producer.
    if (!surfaceMode && matchedMaterials !== null && dispatchHandles === undefined) continue;
    const candidates = surfaceMode
      ? entry.source.materials
      : (dispatchHandles ??
        (mode === 'transmission' ? EMPTY_MATERIAL_HANDLES : entry.source.materials));
    let handles: Set<number> | undefined;
    for (const candidate of candidates) {
      const handle = typeof candidate === 'number' ? candidate : (candidate.materialHandle ?? 0);
      const material =
        entry.source.materials.find((candidate) => (candidate.materialHandle ?? 0) === handle) ??
        entry.source.material;
      if (!matchesRecordMode(material, mode)) continue;
      if (!surfaceMode && dispatchHandles?.size === 1) {
        // This call owns the dispatch set; reuse it only after material matching.
        filtered.set(entry.renderableIndex, dispatchHandles);
      } else {
        handles ??= new Set<number>();
        handles.add(handle);
      }
    }
    if (handles !== undefined) filtered.set(entry.renderableIndex, handles);
  }
  return filtered;
}

/**
 * feat-20260529-rendergraph-pass-abstraction M4 / w13b: main forward
 * (geometry) pass recording, extracted verbatim from recordFrame. Uses the
 * SHARED frame encoder (c.encoder); the geometry + optional LDR sprite-split
 * sub-pass write into geometryColorView (HDR target or swap-chain view).
 * Driven by the render-graph 'main' pass execute closure.
 */
export function recordMainPass(
  c: _InternalRenderPipelineContext,
  selector?: PassSelector,
  options?: MainPassOptions,
  graphPass?: RhiRenderPassEncoder,
): GpuDrivenStandardPbrFrameResources | undefined {
  const {
    runtime,
    world,
    store,
    pipelineState,
    encoder,
    clear,
    geometryColorView,
    geometryDepthView,
    validatedOrdered,
    viewBindGroup,
    viewBindGroupDynamicOffset = 0,
    meshBindGroup,
    frameState,
    bindGroupCounts,
    skyboxActive,
    splitLdrSprite,
    msaaActive,
    geometryColorResolveView,
    dispatch,
    hdrpClusterBindGroup,
    materialSlotIndices,
    materialSlots,
    materialSlotOwners,
    materialSlotCount,
    gpuDrivenStandardPbrFrameResources,
    gpuDrivenSceneMaterialBuffer,
  } = c;
  // bug-20260615 M3 / m3-1: sampleCount is threaded through every
  // getMaterialShaderPipeline call site so the cache key / builder
  // disambiguate count=1 vs count=4 PSOs. Derived from the per-camera
  // msaaActive boolean (already on the context).
  const sampleCount = msaaActive ? 4 : 1;
  const passKind = options?.passKind ?? 'forward';
  const recordMode = options?.recordMode;
  const transmissionBackdropView = options?.transmissionBackdropView;
  const surfaceRawDepthView = options?.surfaceRawDepthView;
  const surfaceNearestLayerView = options?.surfaceNearestLayerView;
  const surfaceNearestDepthView = options?.surfaceNearestDepthView;
  if (
    (recordMode === 'transmission' ||
      recordMode === 'single-layer-medium-nearest-layer' ||
      recordMode === 'single-layer-medium-color') &&
    transmissionBackdropView == null
  ) {
    throw new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'transmissionBackdropView != null for a backdrop-consuming record mode',
      hint: 'the typed Standard backdrop pass must resolve its graph-paired color view',
    });
  }
  const colorViews = options?.colorViews ?? [geometryColorView];
  const colorFormats = options?.colorFormats ?? [
    (c.tonemapActive || c.transparentColorFormat === 'rgba16float'
      ? 'rgba16float'
      : pipelineState.colorAttachmentFormat) as GPUTextureFormat,
  ];
  const targetDepthView = options?.depthView ?? geometryDepthView;
  const clearColor = options?.clearColor ?? clear;
  // feat-20260623-world-space-video-asset M4 / w17 (D-2 / AC-09): high-perf
  // GPUExternalTexture upload availability for video sources, resolved by the
  // explicit RhiCaps-based capability probe. The probe checks
  // backendKind==='webgpu' AND `importExternalTexture` method presence; the
  // latter is absent today (OOS-5), so this is false and the general
  // copyExternalImageToTexture path (w16) is the sole route. The branch exists
  // so the AC-09 two-path reserved hook is code-review-verifiable, not a TODO.
  const videoHighPerfAvailable = probeVideoHighPerfUpload(runtime.device);
  // The prepared Standard topology is the frame authority. Do not infer the
  // shader lane from a resource that may be absent after a failed rebuild: a
  // clustered frame with no unified group must fail closed, never fall back to
  // a direct-lighting shader with an incompatible group(2) contract.
  const clusteredLighting = c.standardLighting?.kind === 'clustered';
  // A clustered topology still needs the unified group for every actual
  // material draw.  A camera-only/clear frame has no group(2) consumer yet;
  // treating that harmless absence as a frame error would make the full
  // clustered ABI incompatible with valid zero-renderable frames.
  const clusteredBindGroupMissing =
    validatedOrdered.length > 0 &&
    !standardTopologyBindGroupReady(c.standardLighting, hdrpClusterBindGroup);
  // Standard clustered lighting swaps the
  // group(2) bindGroup for the unified 7-entry layout (mesh SSBO at binding 0
  // + cluster 4 buffer at bindings 3..6). The dynamic offset
  // (`i * MESH_PER_ENTITY_STRIDE`) stays valid because the unified BGL binds
  // the SAME mesh SSBO at binding 0; the cluster-forward shader reads the
  // cluster bindings off the rest of the layout. Plan D-1 (URP path zero
  // change) is preserved — when clustered lighting is not selected the
  // ordinary mesh bind group path runs verbatim.
  // feat-20260612-hdrp-ssao wiring fix: when the HDRP forward pass resolved a
  // real `ssaoBlurred` view (stashed on ctx by the pass execute closure), build
  // the unified group(2) bind group with that view at binding 7 so fs_main reads
  // the actual occlusion factor instead of the 1x1 white fallback. The default
  // `hdrpClusterBindGroup` (built ahead of graph.execute) always carries the
  // fallback because the transient SSAO texture does not exist that early.
  // Built per frame (the SSAO target is a graph transient, so no cross-frame
  // cache); HDRP-only and SSAO-only, so URP and SSAO-off paths are untouched.
  const hdrpBuffers = clusteredLighting
    ? getOrCreateHdrpBuffers(runtime, frameState.installedPipelineConfig?.clusterGrid)
    : null;
  let hdrpSsaoBindGroup: BindGroup | null = null;
  if (hdrpClusterBindGroup !== null && c.hdrpSsaoBlurredView !== undefined) {
    if (hdrpBuffers !== null) {
      hdrpSsaoBindGroup = createHdrpUnifiedBindGroup(
        runtime,
        hdrpBuffers,
        meshSsboBufferBinding(pipelineState.meshStorageBuffer, 0).buffer,
        { enabled: true, ssaoBlurredView: c.hdrpSsaoBlurredView },
      );
    }
  }
  const meshGroup2: BindGroup | null = clusteredLighting
    ? (hdrpSsaoBindGroup ?? hdrpClusterBindGroup)
    : meshBindGroup;
  if (options?.gpuDriven !== undefined && gpuDrivenStandardPbrFrameResources !== undefined) {
    // The GPU-driven owner prepares before transient graph resources exist;
    // publish the actual Standard group(2) here, at the existing main-pass
    // binding seam, immediately before indirect encoding.
    gpuDrivenStandardPbrFrameResources.clusterBindGroup =
      clusteredLighting && meshGroup2 !== null ? meshGroup2 : undefined;
    if (hdrpBuffers === null) {
      gpuDrivenStandardPbrFrameResources.clusterBindGroupForMesh = undefined;
      gpuDrivenStandardPbrFrameResources.clusterBindGroupForSkin = undefined;
    } else {
      // Device-scoped chain keyed on every bound handle: an unchanged batch
      // re-emits the identical group(2), so its render bundle segment stays
      // reusable instead of mismatching on a per-frame bind group identity.
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
      gpuDrivenStandardPbrFrameResources.clusterBindGroupForMesh = (meshBuffer, bindingBytes) =>
        cachedGroup(
          [meshBuffer, hdrpBuffers.unifiedBindGroupLayout, ...lighting],
          `gpu-driven-hdrp:${bindingBytes}`,
          () => createHdrpUnifiedBindGroup(runtime, hdrpBuffers, meshBuffer, ssao, bindingBytes),
        );
      gpuDrivenStandardPbrFrameResources.clusterBindGroupForSkin = (
        meshBuffer,
        meshBindingBytes,
        paletteBuffer,
        paletteBindingWindowBytes,
      ) => {
        const skinLayout = pipelineState.hdrpSkinMeshBindGroupLayout;
        if (skinLayout === null) return undefined;
        return cachedGroup(
          [meshBuffer, paletteBuffer, skinLayout, ...lighting],
          `gpu-driven-hdrp-skin:${meshBindingBytes}:${paletteBindingWindowBytes}`,
          () =>
            createHdrpSkinUnifiedBindGroup(
              runtime,
              hdrpBuffers,
              skinLayout,
              meshBuffer,
              paletteBuffer,
              paletteBindingWindowBytes,
              ssao,
              meshBindingBytes,
            ),
        );
      };
    }
  }
  // ── Geometry (main colour) pass ──────────────────────────────────
  // D-2: tracks whether the geometry pass was explicitly ended inside
  // the `if (validatedOrdered.length > 0)` block (sprite split path),
  // to avoid a double-end at the unconditional `pass.end()` below.
  let geometryPassEnded = false;
  // feat-20260531-skybox-env-background M2 / w8: condition main colour
  // loadOp on skyboxActive (AC-05). When skybox is active, the skybox
  // pass writes the far plane + cubemap colour to hdrColor before main;
  // main must load (not clear) to composite geometry on top. Depth
  // loadOp stays 'clear' -- skybox does not write depth, so main's
  // depth test naturally covers skybox pixels with foreground geometry.
  const mainColorLoadOp = skyboxActive ? 'load' : 'clear';
  // feat-20260604 M2 / w9-w10: MSAA resolve placement. When MSAA is active the
  // geometry pass writes a count=4 multisample target. The resolve to the
  // single-sample output (LDR swap-chain view / HDR hdrColor) happens at the
  // LAST pass that writes that multisample target: the main pass itself when
  // there is no LDR sprite split, or the sprite sub-pass end when there is
  // (F-1 -- geometry + sprites share one multisample texture; resolving at the
  // main pass would drop the sprites drawn after). The sprite sub-pass is
  // LDR-only, so under HDR the main pass always resolves.
  const mainPassResolves =
    passKind === 'forward' && msaaActive && geometryColorResolveView !== null && !splitLdrSprite;
  // forward main pass: depth32float-stencil8 auto-emits stencil ops via the
  // helper's stencil-op gate (plan-strategy M4 R3/R5 stencil-op SSOT).
  // mainColorLoadOp toggles between 'clear' and 'load' (skyboxActive case).
  const pass: RhiRenderPassEncoder =
    graphPass ??
    encoder.beginRenderPass(
      buildBeginRenderPassDescriptor(
        {
          colorFormats,
          depthFormat: 'depth32float-stencil8',
          sampleCount: msaaActive ? 4 : 1,
        },
        {
          colorViews,
          depthView: targetDepthView,
          ...(mainPassResolves ? { resolveTargets: [geometryColorResolveView] } : {}),
        },
        passKind,
        {
          colorLoadOp: mainColorLoadOp,
          clearColor: {
            r: clearColor[0] ?? 0,
            g: clearColor[1] ?? 0,
            b: clearColor[2] ?? 0,
            a: clearColor[3] ?? 1,
          },
        },
      ) as never,
    );

  // Geometry submission block: setPipeline + 4 bind groups + per-entity
  // material uploads + drawIndexed.

  let matchedMaterials = selectMainPassMaterials(c, selector, recordMode, options?.excludeSelector);
  if (options?.selection !== undefined) {
    const selection = options.selection;
    const entities = new Set(selection.entities);
    const selected = new Map<number, ReadonlySet<number>>();
    for (const entry of validatedOrdered) {
      if (entry.source.worldId !== selection.worldId || !entities.has(entry.source.entityKey))
        continue;
      const handles = matchedMaterials?.get(entry.renderableIndex);
      if (matchedMaterials !== null && handles === undefined) continue;
      selected.set(
        entry.renderableIndex,
        handles ?? new Set(entry.source.materials.map((material) => material.materialHandle ?? 0)),
      );
    }
    matchedMaterials = selected;
  }
  const selectedDispatch =
    dispatch.length === 0
      ? undefined
      : filterDispatchBySelector(
          dispatch,
          selector ?? (passKind === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR),
        );
  const blendedRecordMode =
    recordMode === 'transparent' ||
    recordMode === 'oit-accumulate' ||
    recordMode === 'oit-residual';
  const recordContext =
    recordMode === undefined
      ? c
      : {
          ...c,
          // Blended writers of the display view fog themselves at their own
          // depth; auxiliary captures keep their own unfogged slot.
          translucentFog: blendedRecordMode && viewBindGroupDynamicOffset === 0,
          splitLdrSprite: blendedRecordMode ? false : c.splitLdrSprite,
        };

  if (clusteredBindGroupMissing) {
    runtime.errorRegistry.fire(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'clustered Standard frame has a unified group(2) BindGroup',
        hint: 'repair the clustered buffer/layout admission before retrying the frame; direct URP fallback is unsafe',
      }),
    );
  }

  // A selected empty CPU lane still performs the pass load/store operations,
  // but has no material contract to assemble. GPU batches keep their own
  // projection and cannot be inferred from the CPU selector's empty map.
  if (
    !clusteredBindGroupMissing &&
    ((validatedOrdered.length > 0 &&
      (matchedMaterials === null ||
        matchedMaterials.size > 0 ||
        options?.gpuDriven !== undefined)) ||
      hasMainPassPipelinePreparation(
        c,
        selector ?? (passKind === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR),
        recordMode,
        options?.excludeSelector,
      ))
  ) {
    // feat-20260518-pbr-direct-lighting-mvp M5 / w22.10 (D-4 + D-9 +
    // AC-07 std140): per-entity material slice grew from 32 B (legacy
    // baseColor:vec4 + metallic + roughness + 8B padding) to 48 B
    // mirroring the post-w22.10 `Material` WGSL struct field-for-field
    // (see MATERIAL_UNIFORM_BYTES JSDoc in render-system.ts). The dynamic-
    // offset stride is MATERIAL_PER_ENTITY_STRIDE; the BindGroup entry's
    // `size` remains the derived material payload size.
    const MATERIAL_SLICE = MATERIAL_UNIFORM_BYTES;
    // feat-20260515 M3 / T-M3-05 (research F-6 fix): materialBindGroup now
    // carries 3 entries -- the per-entity material UBO (binding 0,
    // dynamic-offset retained from D-P9), the default sampler (binding 1,
    // pipelineState.defaultSampler from createRenderer; research F-5
    // linear min/mag/mipmap + repeat addressMode), and the texture-view
    // (binding 2, resolved from MaterialSnapshot.baseColorTexture via
    // AssetRegistry.getTextureGpuView when present, falling back to the
    // pipelineState.fallbackTextureView 1x1 white pixel).
    //
    // The first validated renderable's material is sampled to choose the
    // texture-view (M3 milestone simplification; M5 lifts this to
    // per-entity slot writes once UV-driven sampling lands).
    //
    // feat-20260517-merge-mesh-renderer-material-renderer M3 / w10
    // (this commit): the prior structural cast over `firstMaterial`
    // (used to reach `baseColorTexture` before the snapshot carried
    // it as a first-class field) is removed in favour of direct
    // snapshot field access. `MaterialSnapshot` (extract-stage SSOT)
    // already declares `baseColorTexture` (M2 / w6); record reads it
    // directly with no asset registry round-trip and no cast --
    // Pipeline Isolation: extract owns the asset to snapshot
    // translation; record consumes the snapshot POD only (charter
    // proposition 5 consistent abstraction; AC-07 reverse-grep gate
    // `scripts/forgeax/check-render-record-no-material-asset-get.mjs`
    // forbids both the cast pattern and a direct material asset
    // typed-lookup regrowth in this file).
    // bug-20260522-per-entity-material-texture-binding D-1/D-2:
    // the pre-loop `firstMaterial` / `materialTextureView` / `
    // baseMaterialEntries` / single shared `materialBindGroup` are
    // removed. Each entity now creates its own per-entity material BG
    // inside the draw loop, resolving binding=2 from its own
    // `entry.source.material.baseColorTexture` (mirroring sprite path).
    //
    // feat-20260520-skylight-ibl-cubemap M3 round-4 / t48 amend: the
    // 14-entry merged BG (7 material + 7 Skylight) is now assembled per
    // entity inside the draw loop. The Skylight part stays scene-level
    // (single `skylightResources` resolved once below); only the first 7
    // material entries are rebuilt per-entity with the correct
    // per-entity textureView at binding=2.
    const { skylightResources, activeViews } = prepareMaterialSkylight(c);
    if (materialDiagnosticsEnabled()) {
      const activeCache =
        activeViews === undefined ? undefined : getOrCreateIblCache(runtime.deviceScope);
      const prefilterViewMipCount =
        activeCache?.prefilterFaceViewsByMip?.length ?? (activeViews === undefined ? 1 : 0);
      frameState.iblBindingInspection = {
        status: 'binding-chain-consistent',
        frameId: frameState.frameNumber,
        deviceGeneration: runtime.deviceScope.generation,
        active: activeViews === undefined ? 'fallback' : 'active',
        cache: {
          identity: getOpaqueResourceIdentity(
            (activeCache ?? pipelineState.skylightFallback) as object,
          ),
          generation: runtime.deviceScope.generation,
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
          irradiance: {
            viewIdentity: getOpaqueResourceIdentity(skylightResources.irradianceView as object),
            samplerIdentity: getOpaqueResourceIdentity(
              skylightResources.irradianceSampler as object,
            ),
            deviceGeneration: runtime.deviceScope.generation,
          },
          prefilter: {
            viewIdentity: getOpaqueResourceIdentity(skylightResources.prefilterView as object),
            samplerIdentity: getOpaqueResourceIdentity(
              skylightResources.prefilterSampler as object,
            ),
            deviceGeneration: runtime.deviceScope.generation,
          },
          brdfLut: {
            viewIdentity: getOpaqueResourceIdentity(skylightResources.brdfLutView as object),
            samplerIdentity: getOpaqueResourceIdentity(
              skylightResources.irradianceSampler as object,
            ),
            deviceGeneration: runtime.deviceScope.generation,
          },
          intensityBufferIdentity: getOpaqueResourceIdentity(
            skylightResources.intensityBuffer as object,
          ),
        },
        errors: [],
      };
    }
    // Per-entity material uploads (D-P9 retained path).
    // feat-20260613 fix-issue-1 (D-8 channelMap split): the payload mirrors
    // the post-split sidecar paramSchema for default-standard-pbr (14 entries
    // packed std140 across a 96 B schema tail):
    //   [0..3]   baseColor          vec4<f32>     (offset 0)
    //   [4]      metallic           f32           (offset 16)
    //   [5]      roughness          f32           (offset 20)
    //   [6]      metallicChannel    f32           (offset 24)
    //   [7]      roughnessChannel   f32           (offset 28)
    //   [8]      aoChannel          f32           (offset 32)
    //   [9]      extraChannel       f32           (offset 36)
    //   [12..14] emissive           vec3<f32>     (offset 48, vec3 align=16)
    //   [15]     emissiveIntensity  f32           (offset 60)
    //   [16]     occlusionStrength  f32           (offset 64)
    // Channel selectors default to (B,G,R,_) = (2,1,0,0) per glTF 2.0
    // KHR_materials_pbrSpecularGlossiness ARM packing; the fragment casts
    // each f32 to u32 at the pick_channel call site. The full 128 B bind window is
    // overwritten per-entity so unlit entities still produce a deterministic
    // payload (charter P3 explicit failure: zero-init via fresh ArrayBuffer).
    //
    // Material snapshots are interned by extract-owned identity before this
    // pass. Repeated scene instances therefore share one 256-byte UBO slot;
    // materialSlotIndices maps each authored submesh material to that slot.
    // feat-city-glb Bug 5 (per-submesh transparency): shared per-submesh
    // material bind-group assembly, called by BOTH the geometry pass and the
    // LDR blend sub-pass so a transparent PBR submesh binds the identical
    // metallic/roughness/normal/emissive/occlusion + Skylight layout
    // the geometry pass uses (the sub-pass previously bound a sprite-only BG,
    // which cannot render a PBR decal). Captures only frame-stable closure
    // state; the caller passes the per-submesh material snapshot + entityKey
    // (for video texture routing) and sets the dynamic UBO offset itself.
    // Selection keys use the extracted frame index, never RenderResourceScope.identity.
    const hasProbeBindings = (c.reflectionProbes?.table.rows.length ?? 0) > 0;
    const worldIndices = hasProbeBindings
      ? new Map(
          validatedOrdered.map((entry) => [entry.world ?? world, entry.source.worldId] as const),
        )
      : undefined;
    const perSubmeshMaterialBgDeps: PerSubmeshMaterialBgDeps = {
      runtime,
      pipelineState,
      world,
      store,
      materialSlice: MATERIAL_SLICE,
      videoHighPerfAvailable,
      skylightResources,
      resolveRenderTargetTextureSource: runtime.resolveRenderTargetTextureSource,
      resolveReflectionProbeResources: (materialWorld, entityKey) => {
        const reflectionProbes = c.reflectionProbes;
        if (reflectionProbes === undefined || !hasProbeBindings) return undefined;
        const selection = reflectionProbes.selections.get(
          `${worldIndices?.get(materialWorld)}:${entityKey}`,
        );
        if (selection === undefined) return undefined;
        const binding = resolveReflectionProbeBinding(selection, reflectionProbes.table);
        if (binding.useSkylight || binding.probeIndex === undefined) return undefined;
        const row = reflectionProbes.table.rows.find(
          (candidate) => candidate.index === binding.probeIndex,
        );
        if (
          row?.filteredView === undefined ||
          row.sampler === undefined ||
          row.uniformBuffer === undefined
        ) {
          return undefined;
        }
        const probeResources: SkylightBindGroupResources = {
          irradianceView: skylightResources.irradianceView,
          irradianceSampler: skylightResources.irradianceSampler,
          prefilterView: row.filteredView,
          skylightPrefilterView: skylightResources.prefilterView,
          prefilterSampler: row.sampler,
          brdfLutView: skylightResources.brdfLutView,
          intensityBuffer: row.uniformBuffer,
        };
        return { resources: probeResources, probeIndex: row.index };
      },
      ...(c.planarReflectionView === undefined
        ? {}
        : { planarReflectionView: c.planarReflectionView }),
      materialBgShared: frameState.materialBgShared,
      materialBgAssemblyCache: c.materialBgAssemblyCache,
      frameState,
      bindGroupCounts,
      ...(gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer === undefined &&
      gpuDrivenSceneMaterialBuffer === undefined
        ? {}
        : {
            sceneMaterialBuffer:
              gpuDrivenStandardPbrFrameResources?.sceneMaterialBuffer ??
              gpuDrivenSceneMaterialBuffer,
          }),
      ...(transmissionBackdropView === undefined ? {} : { transmissionBackdropView }),
      ...(surfaceRawDepthView === undefined ? {} : { surfaceRawDepthView }),
      ...(surfaceNearestLayerView === undefined ? {} : { surfaceNearestLayerView }),
      ...(surfaceNearestDepthView === undefined ? {} : { surfaceNearestDepthView }),
    };
    const buildPerSubmeshMaterialBg = (
      materialSlot: number,
      submeshMaterial: MaterialSnapshot,
      entityKey: number,
      materialWorld: RenderResourceScope = world,
      materialShaderId: string | undefined = submeshMaterial.materialShaderId,
    ): BindGroup =>
      buildPerSubmeshMaterialBgImpl(
        perSubmeshMaterialBgDeps,
        submeshMaterial,
        entityKey,
        materialWorld,
        materialShaderId,
        materialSlot,
      );
    // Static material resources are a property of the frame-local material
    // slot, not of each submesh draw. Resolve them once here so the geometry
    // loop only selects a prepared binding. Video fields remain entity-bound:
    // their current frame view is keyed by entityKey and must be resolved at
    // the draw site.
    const preparedMaterialBindGroups = new Array<BindGroup | undefined>(materialSlotCount);
    for (let materialSlot = 0; materialSlot < materialSlotCount; materialSlot += 1) {
      const material = materialSlots[materialSlot];
      if (material === undefined || (material.videoTextureFields?.size ?? 0) > 0) continue;
      // A graph scene pass owns only the materials selected by its record
      // mode. In particular, the opaque pass runs before the raw-depth
      // producer and must not assemble medium bindings with resources that do
      // not exist until the later nearest-layer/color passes. Keep holes for
      // the other lanes; the GPU encoder validates the exact slot it consumes.
      if (recordMode !== undefined && !matchesRecordMode(material, recordMode)) continue;
      const owner = materialSlotOwners[materialSlot];
      if (owner === undefined) continue;
      preparedMaterialBindGroups[materialSlot] = buildPerSubmeshMaterialBg(
        materialSlot,
        material,
        owner.source.entityKey,
        owner.world ?? world,
      );
    }
    // Direct Surface draws retain producer resources, but only indirect
    // encoding consumes the pass-local material slot projection.
    if (options?.gpuDriven !== undefined && gpuDrivenStandardPbrFrameResources !== undefined) {
      gpuDrivenStandardPbrFrameResources.materialBindGroups.length = 0;
      gpuDrivenStandardPbrFrameResources.materialBindGroups.push(...preparedMaterialBindGroups);
      gpuDrivenStandardPbrFrameResources.colorFormats = colorFormats;
      if (options?.bundleDescriptor === undefined)
        delete gpuDrivenStandardPbrFrameResources.bundleDescriptor;
      else gpuDrivenStandardPbrFrameResources.bundleDescriptor = options.bundleDescriptor;
      const selectedMaterialSlots = new Set<number>();
      if (matchedMaterials === null)
        delete gpuDrivenStandardPbrFrameResources.selectedMaterialSlots;
      else gpuDrivenStandardPbrFrameResources.selectedMaterialSlots = selectedMaterialSlots;
      gpuDrivenStandardPbrFrameResources.materialSlotIndicesByEntity.clear();
      for (let index = 0; index < validatedOrdered.length; index += 1) {
        const entry = validatedOrdered[index];
        if (entry === undefined) continue;
        const selected = matchedMaterials?.get(entry.renderableIndex);
        const materials =
          entry.source.materials.length > 0 ? entry.source.materials : [entry.source.material];
        for (let slot = 0; slot < materials.length; slot += 1) {
          const handle = materials[slot]?.materialHandle ?? -1;
          const globalSlot = materialSlotIndices[index]?.[slot];
          if (globalSlot !== undefined && selected?.has(handle))
            selectedMaterialSlots.add(globalSlot);
        }
        const entityKey = worldEntityKey(entry.source.worldId, entry.source.entityKey);
        gpuDrivenStandardPbrFrameResources.materialSlotIndicesByEntity.set(
          entityKey,
          c.gpuRasterCull?.camera === c.camera && c.gpuRasterCull.entityKeys.has(entityKey)
            ? CULLED_GPU_MATERIAL_SLOTS
            : (materialSlotIndices[index] ?? []),
        );
      }
    }
    const resolveMaterialBindGroup = (
      materialSlot: number,
      material: MaterialSnapshot,
      entityKey: number,
      materialWorld: RenderResourceScope = world,
      materialShaderId: string | undefined = material.materialShaderId,
    ): BindGroup =>
      !hasProbeBindings &&
      materialShaderId === material.materialShaderId &&
      materialShaderId !== POINTS_LINES_MATERIAL_SHADER_ID
        ? (preparedMaterialBindGroups[materialSlot] ??
          buildPerSubmeshMaterialBg(
            materialSlot,
            material,
            entityKey,
            materialWorld,
            materialShaderId,
          ))
        : buildPerSubmeshMaterialBg(
            materialSlot,
            material,
            entityKey,
            materialWorld,
            materialShaderId,
          );

    // GPU-driven batches carry only opaque queues, so they encode before the
    // CPU list: a later-queue CPU draw (e.g. depthCompare 'always' x-ray) must
    // land after the opaque geometry it is meant to overdraw.
    if (options?.gpuDriven !== undefined) {
      if (viewBindGroup === null) {
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'main-pass Standard PBR view bind group for GPU-driven encode',
          hint: 'publish the current frame view/light/shadow bind group before GPU raster',
        });
      }
      if (
        gpuDrivenStandardPbrFrameResources === undefined ||
        gpuDrivenStandardPbrFrameResources.materialBindGroups.length === 0
      ) {
        throw new RhiError({
          code: 'rhi-not-available',
          expected: 'complete main-pass Standard PBR material bind-group receipt',
          hint: 'finish frame material producer assembly before GPU-driven encode',
        });
      }
      options.gpuDriven.projection.encode(
        viewBindGroup,
        pass,
        options.gpuDriven.resources,
        gpuDrivenStandardPbrFrameResources,
        options.gpuDrivenFilter,
        // Indirect draws bind the base View slot (offset 0) and carry only
        // opaque queues, so outside atmosphere captures their forward entry
        // skips the translucent fog chain exactly like direct draws.
        selectForwardFragmentEntry({
          passKind,
          fragmentEntry: options?.fragmentEntryPoint,
          oitAccumulate: recordMode === 'oit-accumulate',
          viewOffset: 0,
          atmosphereCapture: c.capturedAtmosphere !== undefined,
        }),
        options?.coverageOnly ?? false,
        options.gpuDriven.phase ?? 'all',
      );
    }

    pass.setBindGroup(0, viewBindGroup as BindGroup, [viewBindGroupDynamicOffset, 0]);

    // Track which (mesh-vertex-buffer, mesh-index-buffer, pipeline) combo
    // was last bound so consecutive entities sharing the same combo skip
    // the redundant rebinds (cheap GPU cost; net wins on workloads where
    // most entities share BUILTIN_CUBE + unlit). Initial nulls force the
    // first iteration to bind unconditionally.
    // M-3 / w12: vertexBuffer/indexBuffer state locals migrate to GpuBuffer.
    const recordGeometry = (): void => {
      recordGeometryDraws(
        recordContext,
        pass,
        matchedMaterials,
        materialSlotIndices,
        sampleCount,
        meshGroup2,
        meshBindGroup,
        resolveMaterialBindGroup,
        passKind,
        selectedDispatch,
        colorFormats,
        options?.coverageOnly ?? false,
        options?.fragmentEntryPoint,
        recordMode === 'single-layer-medium-nearest-layer'
          ? 'nearest-layer'
          : recordMode === 'single-layer-medium-color'
            ? 'color'
            : undefined,
        options?.transparentDepthWrite ?? false,
        recordMode === 'oit-accumulate'
          ? 'accumulate'
          : recordMode === 'oit-residual'
            ? 'residual'
            : undefined,
        (preparedPass, material) =>
          matchPass(
            preparedPass.tags,
            selector ?? (passKind === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR),
          ) &&
          (recordMode === undefined || matchesRecordMode(material, recordMode)),
        (entry, index) => preparationSubmeshExcluded(entry, index, options?.excludeSelector),
      );
    };
    // The late occlusion pass only adds GPU items the HZB revealed; the CPU
    // lane already drew its complete set in the early pass.
    const cpuGeometry = options?.gpuDriven?.phase !== 'late';
    if (cpuGeometry && c.profilePhase === undefined) {
      recordGeometry();
    } else if (cpuGeometry && c.profilePhase !== undefined) {
      const passName = passKind === 'deferred' ? 'g-buffer' : 'forward';
      c.profilePhase(
        `record/graph-execute/${passName}/geometry-loop` as RenderRecordPhase,
        recordGeometry,
      );
    }

    // D-2: LDR sprite pass. Runs after the geometry pass when there are
    // sprite entities in the draw list and the LDR path is active.
    // The geometry pass used the bgra8unorm-srgb sRGB view (hardware sRGB
    // encoding for unlit/standard/pbr output). The sprite pass uses the
    // bgra8unorm storage view (loadOp=load) so the sprite LDR pipeline
    // (target=bgra8unorm, blend=premultiplied-alpha) can write over the
    // already-encoded geometry pixels. Depth is loaded from the geometry
    // pass so sprite-vs-mesh occlusion (depthCompare=less-equal) is
    // preserved (plan-strategy §2 D-2 + §4 R-4).
    if (passKind === 'forward' && recordMode === undefined) {
      // Only legacy sprite recording consumes entity-level membership. Reuse
      // this invocation's selected dispatch; material/exclusion lanes have
      // their own pair-level membership and never need this extra set.
      let matchedIndices: Set<number> | null = null;
      if (options?.selection !== undefined) {
        matchedIndices = new Set(matchedMaterials?.keys());
      } else if (selector !== undefined && selectedDispatch !== undefined) {
        matchedIndices = new Set<number>();
        for (const entry of selectedDispatch) matchedIndices.add(entry.renderableIndex);
      }
      geometryPassEnded = recordSpritePass(
        c,
        pass,
        matchedIndices,
        materialSlotIndices,
        sampleCount,
        resolveMaterialBindGroup,
        graphPass,
        selectedDispatch,
      );
    }
  } // end if (validatedOrdered.length > 0) -- Case E falls through to pass.end()

  if (!geometryPassEnded && graphPass === undefined) {
    pass.end();
  }
  return gpuDrivenStandardPbrFrameResources;
}

/** One CPU material selection for graph admission and geometry recording. */
export function selectMainPassMaterials(
  c: MaterialSelectionContext,
  selector: PassSelector | undefined,
  recordMode: MainPassOptions['recordMode'],
  excludeSelector?: PassSelector,
): ReadonlyMap<number, ReadonlySet<number>> | null {
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
  c: MaterialSelectionContext,
  renderPath: 'forward' | 'deferred',
): boolean {
  if (renderPath === 'forward') {
    return (
      c.validatedOrdered.length > 0 &&
      c.validatedOrdered.every(
        (entry) => entry.source.material.materialShaderId === 'forgeax::default-standard-pbr',
      )
    );
  }
  const selected = selectMainPassMaterials(c, DEFERRED_PASS_SELECTOR, 'opaque');
  if (selected === null) return false;
  let receiverCount = 0;
  for (const entry of c.validatedOrdered) {
    const handles = selected.get(entry.renderableIndex);
    if (handles === undefined) continue;
    for (const handle of handles) {
      const material =
        entry.source.materials.find((candidate) => (candidate.materialHandle ?? 0) === handle) ??
        ((entry.source.material.materialHandle ?? 0) === handle
          ? entry.source.material
          : undefined);
      if (
        material === undefined ||
        material.deferredPass !== true ||
        material.surfaceModel === 'single-layer-medium' ||
        material.transparent === true
      )
        return false;
      receiverCount += 1;
    }
  }
  return receiverCount > 0;
}

export function encodeMainPass(
  c: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  selector?: PassSelector,
  options?: MainPassOptions,
): GpuDrivenStandardPbrFrameResources | undefined {
  return recordMainPass(c, selector, options, pass);
}
