import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type { BindGroupLayout, RenderPipeline } from '@forgeax/engine-rhi';
import {
  findMaterialShaderEntry,
  type MaterialShaderArtifact,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
  materialShaderPreparedSourceRows,
  materialShaderSourceEquals,
  type PipelineGroup2Contract,
  type RegisteredMaterialShaderEntry,
  type ShaderCatalog,
  type ShaderRegistry,
  STANDARD_ORM_REUSE_BIT,
  STANDARD_ORM_REUSE_OVERRIDE,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '@forgeax/engine-shader';
import type {
  MaterialRenderState,
  PassKind,
  PrimitiveTopology,
  ShaderEntryPointReads,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import {
  CLUSTER_LIGHT_VIEW_SLOT,
  CLUSTER_PARAMS_VIEW_SLOT,
  hasStandardViewReads,
  POINTS_LINES_VIEW_SLOT,
  projectViewLayout,
  viewEntryReads,
} from '../environment/bindings';
import type { RenderFeatureShaderModuleMode } from '../features/types';
import { projectRasterWindowLayout } from '../gpu-driven/raster-window-layout';
import { materialProgramInputs, requireStandardGBufferReceipt } from '../material-program-inputs';
import {
  applySurfaceDiscardAxis,
  COLORLESS_COVERAGE_FRAGMENT_ENTRY,
  materialProgramRasterConstants,
  projectStandardCoverageConstants,
  variantSetForSurfaceDiscards,
} from '../material-stage-constants';
import {
  buildOpaqueStandardPipelineLayout,
  canProjectOpaqueStandardMaterial,
  createHdrpBindGroupLayoutDescriptor,
  gpuDrivenPrimitiveLayoutEntries,
  isCanonicalStandardPbrMaterialShader,
  isStandardGBufferEntry,
  SHADOW_CASTER_SHADER_ID,
  SKIN_MATERIAL_SHADER_ID,
  skinMeshArrayLayoutDescriptor,
} from '../pbr-pipeline';
import { isForwardShadowColorEntry } from '../pipeline/forward-shadow-admission';
import { pipelineVertexEntry } from '../pipeline-builder';
import { cacheKeyOf, type PipelineSpec } from '../pipeline-spec';
import { POINTS_LINES_MATERIAL_SHADER_ID } from '../points-lines/record';
import type {
  MaterialShaderPipelineEntry,
  PipelinePreparationCompletion,
} from '../record/render-context';
import { materialProgramSource } from '../record/standard-opaque-entry';
import {
  primitiveReflectionReads,
  projectPrimitiveReflectionLayout,
} from '../reflection/primitive-bindings';
import type { RasterPassRequestInspection } from '../render-contract';
import { shaderBindingVisibility } from '../shader-binding-visibility';
import type { createMaterialLayoutCache } from './material/layout-cache';
import { preparedPipelineViews } from './material/layout-cache';
import {
  findStandardPbrEntry,
  isSharedLayoutMaterialShader,
  materialPipelineArtifactRequest,
  materialPipelineKeyVertexEntry,
  resolveMaterialPipelineBindGroups,
  resolveMaterialPipelineShaderId,
} from './material/pipeline-helpers';
import {
  MaterialPipelineRequestCache,
  materialPipelineRequestFacts,
  requestMaterialPipeline,
} from './material/pipeline-request-cache';
import { declaredOrVertexOnlyFragmentEntry } from './material-fragment-entry';
import {
  allowsUnlitPreparedFallback,
  type LayoutKind,
  manifestVariantShaderEntry,
  materialPipelineAttachments,
  materialPipelineCacheKey,
  materialPipelineGeometry,
  materialPipelineShaderSpec,
  prepareLowLimitMaterialShaderEntry,
  requiresPreparedMaterialShader,
  resolveMaterialPipelineVariantSet,
  resolveMaterialShaderBackendArtifactKey,
  resolveMaterialShaderVertexInputContract,
  selectPipelineLayoutForVariant,
} from './material-shader-policy';
import type { MaterialPipelineSource } from './webgpu-renderer-contract';
import {
  isPreparedMaterialVertexLayout,
  materialPipelineVertexAttributes,
  particleMaterialInputVertexBuffers,
  resolveWebGPUVertexBufferLayouts,
} from './webgpu-vertex-layouts';

export interface MaterialLayoutProjections {
  readonly opaqueStandard?: boolean;
  readonly material: ReadonlySet<number> | undefined;
  readonly view: ReturnType<typeof viewEntryReads>;
  readonly probeBlend?: boolean;
  readonly primitiveReflection?: number;
  readonly rasterWindow?: ReadonlyMap<number, number> | undefined;
}

// ShaderRegistry publishes deep-frozen reflection arrays. Keep derived reads
// with that publication, shared across its attachment and vertex-layout PSOs.
const reflectedMaterialLayouts = new WeakMap<
  readonly ShaderEntryPointReads[],
  Map<string, MaterialLayoutProjections>
>();

/** A missing stage declaration cannot establish that a draw is independent of group 1. */
export function shadowStagesIgnoreMaterial(
  entries: readonly ShaderEntryPointReads[] | undefined,
  vertex: string,
  fragment: string | null,
): boolean {
  const vs = findMaterialShaderEntry(entries, vertex, 'vertex');
  if (vs === undefined || vs.bindings.some((read) => read.group === 1)) return false;
  if (fragment === null) return true;
  const fs = findMaterialShaderEntry(entries, fragment, 'fragment');
  return fs !== undefined && !fs.bindings.some((read) => read.group === 1);
}

export function materialLayoutProjections(
  entryPoints: readonly ShaderEntryPointReads[] | undefined,
  vertex: string | undefined,
  fragment: string | null | undefined,
  projectSurface: boolean,
): MaterialLayoutProjections {
  if (entryPoints === undefined) return unreflectedMaterialLayout;
  let layouts = reflectedMaterialLayouts.get(entryPoints);
  if (layouts === undefined) {
    layouts = new Map();
    reflectedMaterialLayouts.set(entryPoints, layouts);
  }
  // Entry points are WGSL identifiers. Distinguish omitted and vertex-only fragments.
  const key = `${vertex ?? 'vs_main'}:${fragment === null ? '-' : (fragment ?? '')}:${projectSurface ? 1 : 0}`;
  const existing = layouts.get(key);
  if (existing !== undefined) return existing;
  const projected = reflectMaterialLayout(entryPoints, vertex, fragment, projectSurface);
  layouts.set(key, projected);
  return projected;
}

const unreflectedMaterialLayout: MaterialLayoutProjections = {
  material: undefined,
  view: undefined,
};

function selectMaterialEntryBindings(
  entries: readonly ShaderEntryPointReads[] | undefined,
  vertex: string | undefined,
  fragment: string | null | undefined,
): ReadonlySet<number> | undefined {
  const vs = findMaterialShaderEntry(entries, vertex ?? 'vs_main', 'vertex');
  const fs = findMaterialShaderEntry(entries, fragment, 'fragment');
  if (vs === undefined || (fragment !== null && fs === undefined)) return undefined;
  const reads = new Set<number>();
  for (const binding of vs.bindings) if (binding.group === 1) reads.add(binding.binding);
  for (const binding of fs?.bindings ?? []) if (binding.group === 1) reads.add(binding.binding);
  return reads;
}

function reflectMaterialLayout(
  entryPoints: readonly ShaderEntryPointReads[],
  vertex: string | undefined,
  fragment: string | null | undefined,
  projectSurface: boolean,
): MaterialLayoutProjections {
  const material = projectSurface
    ? selectMaterialEntryBindings(entryPoints, vertex, fragment)
    : undefined;
  return {
    opaqueStandard:
      (fragment === null && material !== undefined) ||
      canProjectOpaqueStandardMaterial(entryPoints, vertex, fragment),
    material,
    view: viewEntryReads(entryPoints, vertex, fragment),
    rasterWindow:
      fragment != null &&
      (fragment === 'fs_main' ||
        isStockForwardSurfaceEntry(fragment) ||
        isStandardGBufferEntry(fragment)) &&
      vertex?.startsWith('vs_scene_index')
        ? shaderBindingVisibility(entryPoints, 3, { vertex, fragment })
        : undefined,
    primitiveReflection: primitiveReflectionReads(entryPoints, fragment),
    probeBlend:
      entryPoints.some(
        (entry) =>
          entry.stage === 'fragment' &&
          entry.name === fragment &&
          entry.bindings.some(({ group, binding }) => group === 3 && binding === 1),
      ) === true,
  };
}

function isStockForwardSurfaceEntry(fragment: string | null | undefined): boolean {
  return (
    fragment === 'fs_opaque' ||
    fragment === 'fs_forward_screen' ||
    isForwardShadowColorEntry(fragment)
  );
}

const pointsLinesViewReads = new Map([
  [0, 3],
  [POINTS_LINES_VIEW_SLOT, 1],
]);

function hasProjectedViewResources(view: MaterialLayoutProjections['view']): boolean {
  return (
    view?.has(POINTS_LINES_VIEW_SLOT) === true ||
    view?.has(CLUSTER_LIGHT_VIEW_SLOT) === true ||
    view?.has(CLUSTER_PARAMS_VIEW_SLOT) === true ||
    hasStandardViewReads(view)
  );
}

function projectsProbeBlend(
  projections: MaterialLayoutProjections | undefined,
  variantSet: string | undefined,
): boolean {
  return (
    projections?.probeBlend === true || variantSet?.includes('PROBE_BLEND_AVAILABLE=true') === true
  );
}

function selectedPrimitiveReflection(
  device: import('@forgeax/engine-rhi').RhiDevice,
  layoutKind: LayoutKind,
  contract: PipelineGroup2Contract,
  base: import('@forgeax/engine-rhi').BindGroupLayout,
  reads: number,
) {
  if (reads === 0) return undefined;
  const { storageBuffer } = device.caps;
  const entries = layoutKind.startsWith('gpu-driven-')
    ? gpuDrivenPrimitiveLayoutEntries(layoutKind.endsWith('skin'))
    : (contract === 'skin' || contract === 'skin-cluster'
        ? skinMeshArrayLayoutDescriptor({ storageBuffer })
        : createHdrpBindGroupLayoutDescriptor(storageBuffer)
      ).entries;
  return projectPrimitiveReflectionLayout(device, base, entries, reads);
}

export function runBuildPipelineContext(
  getShader: () => import('@forgeax/engine-shader').ShaderRegistry,
  currentPipelineState: () => import('../record/render-context').PipelineState | null,
  waterWavesPipelineLayout: (
    state: import('../record/render-context').PipelineState | null,
    layoutKind: import('./material-shader-policy').LayoutKind,
    probeBlend: boolean,
    waterInfoFormat: 'rgba16float' | 'rgba32float' | undefined,
    materialBgl: import('@forgeax/engine-rhi').BindGroupLayout | undefined,
    shaderIdentity: string,
    entryPoints?: readonly import('@forgeax/engine-types').ShaderEntryPointReads[] | undefined,
    reads?: MaterialLayoutProjections['view'],
  ) => {
    readonly pipelineLayout: import('@forgeax/engine-rhi').PipelineLayout;
    readonly group2Layout: import('@forgeax/engine-rhi').BindGroupLayout;
    readonly view: import('@forgeax/engine-rhi').BindGroupLayout;
  } | null,
  currentMaterialShaderUvSetCounts: () => Map<string, number>,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  getShaderModuleAdapter: (
    mode?: 'validated' | 'immediate',
  ) => import('./material-shader-policy').ShaderDeviceAdapterInternal,
  getOrBuildPerShaderMaterialLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildPerShaderMaterialLayout'],
  getMaterialShaderBindingContract: ReturnType<
    typeof createMaterialLayoutCache
  >['getMaterialShaderBindingContract'],
  getOrBuildGroup0MaterialLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildGroup0MaterialLayout'],
  getOrBuildGroup0ResourceLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildGroup0ResourceLayout'],
  getOrBuildViewOnlyMaterialPipelineLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildViewOnlyMaterialPipelineLayout'],
  getOrBuildViewAndSceneDepthMaterialPipelineLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildViewAndSceneDepthMaterialPipelineLayout'],
  getOrBuildPreparedMaterialPipelineLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildPreparedMaterialPipelineLayout'],
  getOrBuildPreparedStoragePipelineLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildPreparedStoragePipelineLayout'],
  variantSet?: string,
  materialShaderId?: string,
  group2Contract: PipelineGroup2Contract = 'mesh',
  meshAttributes?: VertexAttributeMap,
  vertexLayout?: string,
  vertexLayoutProjection?: VertexLayoutProjection,
  shaderModuleMode?: RenderFeatureShaderModuleMode,
  layoutKindOverride?: LayoutKind,
  particleInputLanes?: number,
  waterInfoFormat?: 'rgba16float' | 'rgba32float',
  programIdentity?: string,
  entryPoints?: readonly ShaderEntryPointReads[],
  waterSystemInputs = false,
  preparedStorageBindings = false,
  projectOpaqueLayout = false,
  projections?: MaterialLayoutProjections,
  selectPositionOnly?: (
    vertexBuffers: readonly GPUVertexBufferLayout[],
  ) => MaterialLayoutProjections | undefined,
) {
  const selectMaterialContractLayout = () => {
    const contractLayoutKind: LayoutKind =
      group2Contract === 'cluster'
        ? 'hdrp-pbr'
        : group2Contract === 'skin-cluster'
          ? 'hdrp-skin'
          : group2Contract === 'skin'
            ? 'pbr-skin'
            : 'pbr';
    return contractLayoutKind;
  };
  const contractLayoutKind = selectMaterialContractLayout();
  const layoutKind = layoutKindOverride ?? contractLayoutKind;
  const selectSharedBootMaterialLayout = () => {
    const gpuClustered =
      (layoutKind === 'gpu-driven-pbr' || layoutKind === 'gpu-driven-skin') &&
      (group2Contract === 'cluster' || group2Contract === 'skin-cluster');
    const usesSharedBootMaterialLayout =
      !gpuClustered &&
      materialShaderId !== undefined &&
      isSharedLayoutMaterialShader(materialShaderId);
    return { gpuClustered, usesSharedBootMaterialLayout };
  };
  const { gpuClustered, usesSharedBootMaterialLayout } = selectSharedBootMaterialLayout();
  // Built-in layouts are assembled at boot; authored layouts must not bypass
  // the HDRP group(2) selector or bind the URP mesh BGL to a cluster PSO.
  const perShaderLayout =
    !usesSharedBootMaterialLayout && materialShaderId !== undefined
      ? getOrBuildPerShaderMaterialLayout(materialShaderId, undefined, layoutKind, gpuClustered)
      : null;
  // Authored shaders retain their own material schema and selected mesh
  // layout, including skin. Built-in IDs keep their boot-time layout.
  const bindingContract =
    materialShaderId === undefined
      ? 'render-material'
      : getMaterialShaderBindingContract(materialShaderId).bindings;
  const prepareMaterialContractLayouts = () => {
    const group0Layout = bindingContract === 'group-0' ? getOrBuildGroup0MaterialLayout() : null;
    const group0ResourceLayout =
      bindingContract === 'group-0-resource' && materialShaderId !== undefined
        ? getOrBuildGroup0ResourceLayout(materialShaderId)
        : null;
    const viewOnlyLayout =
      bindingContract === 'view-only' ? getOrBuildViewOnlyMaterialPipelineLayout() : null;
    const viewAndSceneDepthLayout =
      bindingContract === 'view-and-scene-depth'
        ? getOrBuildViewAndSceneDepthMaterialPipelineLayout()
        : null;
    const preparedMaterialLayout =
      (bindingContract === 'render-material' ||
        bindingContract === 'post-process' ||
        bindingContract === 'render-material-with-scene-depth' ||
        bindingContract === 'render-material-and-scene-depth' ||
        bindingContract === 'render-lit-material-and-scene-depth' ||
        bindingContract === 'render-standard-material-and-scene-depth') &&
      materialShaderId !== undefined &&
      (bindingContract === 'post-process' || isPreparedMaterialVertexLayout(vertexLayout))
        ? getOrBuildPreparedMaterialPipelineLayout(
            materialShaderId,
            group2Contract === 'cluster',
            waterInfoFormat,
            projections?.view,
          )
        : null;
    return {
      group0Layout,
      group0ResourceLayout,
      viewOnlyLayout,
      viewAndSceneDepthLayout,
      preparedMaterialLayout,
    };
  };
  const {
    group0Layout,
    group0ResourceLayout,
    viewOnlyLayout,
    viewAndSceneDepthLayout,
    preparedMaterialLayout,
  } = prepareMaterialContractLayouts();
  const materialShaderEntry =
    materialShaderId === undefined ? undefined : getShader().findMaterialArtifact(materialShaderId);
  const vertexInputContract = materialShaderEntry?.ok
    ? resolveMaterialShaderVertexInputContract(materialShaderEntry.value.program)
    : 'render-material';
  const currentState = currentPipelineState();
  const waterWavesLayout =
    waterSystemInputs && bindingContract !== 'post-process'
      ? waterWavesPipelineLayout(
          currentState,
          layoutKind,
          variantSet?.includes('PROBE_BLEND_AVAILABLE=true') === true,
          waterInfoFormat,
          perShaderLayout?.materialBgl,
          programIdentity ?? materialShaderId ?? '',
          entryPoints,
          projections?.view,
        )
      : null;
  if (waterSystemInputs && bindingContract !== 'post-process' && waterWavesLayout === null)
    return null;
  const storageLayout =
    preparedStorageBindings && materialShaderId !== undefined
      ? getOrBuildPreparedStoragePipelineLayout(materialShaderId, variantSet)
      : null;
  if (preparedStorageBindings && storageLayout === null) return null;
  const selectMaterialPipelineLayout = () => {
    const pipelineLayout =
      storageLayout?.pipelineLayout ??
      (group0Layout !== null
        ? group0Layout.pipelineLayout
        : group0ResourceLayout !== null
          ? group0ResourceLayout.pipelineLayout
          : viewOnlyLayout !== null
            ? viewOnlyLayout
            : viewAndSceneDepthLayout !== null
              ? viewAndSceneDepthLayout
              : waterWavesLayout !== null
                ? waterWavesLayout.pipelineLayout
                : preparedMaterialLayout !== null
                  ? preparedMaterialLayout
                  : perShaderLayout !== null
                    ? perShaderLayout.pipelineLayout
                    : selectPipelineLayoutForVariant(currentState, variantSet, layoutKind));
    return pipelineLayout;
  };
  const fullPipelineLayout = selectMaterialPipelineLayout();
  if (fullPipelineLayout === null) return null;
  const explicitResourceLayout = () =>
    waterWavesLayout !== null ||
    group0Layout !== null ||
    group0ResourceLayout !== null ||
    viewOnlyLayout !== null ||
    viewAndSceneDepthLayout !== null ||
    preparedMaterialLayout !== null ||
    storageLayout !== null;
  const stockStandard = isCanonicalStandardPbrMaterialShader(materialShaderId);
  const makeSelectedLayout = (
    view: BindGroupLayout,
    bindGroups: NonNullable<ReturnType<typeof resolveMaterialPipelineBindGroups>>,
    material: BindGroupLayout,
  ) => {
    if (!projectOpaqueLayout || !stockStandard) {
      return {
        layout: viewOnlyProjection(
          currentBuildDevice(),
          fullPipelineLayout,
          view,
          material,
          bindGroups,
        ),
        index: 0,
        material,
      };
    }
    return buildOpaqueStandardPipelineLayout(
      currentBuildDevice(),
      fullPipelineLayout,
      view,
      material,
      bindGroups.meshLayout,
      bindGroups.instancesLayout,
      projections?.material,
    );
  };
  const shouldProjectMaterial = (
    viewReads: MaterialLayoutProjections['view'],
    windowReads: MaterialLayoutProjections['rasterWindow'],
    primitiveReads: number,
  ) => {
    const projectedReads =
      primitiveReads !== 0 || windowReads !== undefined || hasProjectedViewResources(viewReads);
    return (
      (projectOpaqueLayout || viewReads !== undefined || windowReads !== undefined) &&
      (projectedReads || stockStandard) &&
      !explicitResourceLayout() &&
      (perShaderLayout === null || projectedReads)
    );
  };
  const projectMaterial = () => {
    const primitiveReads = projections?.primitiveReflection ?? 0;
    const viewReads =
      projections?.view ??
      (materialShaderId === POINTS_LINES_MATERIAL_SHADER_ID ? pointsLinesViewReads : undefined);
    const windowReads = projections?.rasterWindow;
    if (currentState === null || !shouldProjectMaterial(viewReads, windowReads, primitiveReads))
      return undefined;
    const probe = projectsProbeBlend(projections, variantSet);
    const bindGroups = resolveMaterialPipelineBindGroups(layoutKind, currentState, probe);
    if (bindGroups === null) return undefined;
    const view =
      viewReads === undefined
        ? currentState.viewBindGroupLayout
        : projectViewLayout(currentBuildDevice(), currentState.viewBindGroupLayout, viewReads);
    const primitive = selectedPrimitiveReflection(
      currentBuildDevice(),
      layoutKind,
      group2Contract,
      bindGroups.meshLayout,
      primitiveReads,
    );
    const meshLayout = primitive?.layout ?? bindGroups.meshLayout;
    const window = projectRasterWindowLayout(
      currentBuildDevice(),
      bindGroups.instancesLayout,
      windowReads,
    );
    const instancesLayout = window?.layout ?? bindGroups.instancesLayout;
    const material = perShaderLayout?.materialBgl ?? currentState.materialBindGroupLayout;
    if (
      !(projectOpaqueLayout && stockStandard) &&
      view === currentState.viewBindGroupLayout &&
      primitive === undefined &&
      window === undefined
    )
      return undefined;
    const selected = makeSelectedLayout(
      view,
      { ...bindGroups, meshLayout, instancesLayout },
      material,
    );
    return selected === undefined ? undefined : { ...selected, view, primitive, window };
  };
  const resolvePipelineUvSetCount = () => {
    const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
    const resolvedUvSetCount =
      materialShaderId === undefined
        ? undefined
        : (currentMaterialUvSetCounts.get(materialShaderId) ??
          (materialShaderEntry?.ok ? materialShaderEntry.value.program.uvSetCount : undefined));
    return resolvedUvSetCount;
  };
  const resolvedUvSetCount = resolvePipelineUvSetCount();
  const vertexBuffers = resolveWebGPUVertexBufferLayouts({
    vertexInputContract,
    vertexLayout,
    vertexLayoutProjection,
    resolvedUvSetCount,
    layoutKind,
    meshAttributes,
    particleInputLanes,
  });
  const positionOnly = selectPositionOnly?.(vertexBuffers);
  if (positionOnly !== undefined) {
    projections = positionOnly;
    projectOpaqueLayout = positionOnly.opaqueStandard === true;
  }
  const opaquePipelineLayout = projectMaterial();
  const createMaterialPipelineContext = () => {
    return {
      device: currentBuildDevice(),
      shaderModuleFactory:
        shaderModuleMode === 'immediate' ||
        (internals.pack.createShaderModuleImmediate !== undefined &&
          isCanonicalStandardPbrMaterialShader(materialShaderId))
          ? getShaderModuleAdapter('immediate')
          : getShaderModuleAdapter(),
      pipelineLayout: opaquePipelineLayout?.layout ?? fullPipelineLayout,
      standardMaterialLayoutIndex: opaquePipelineLayout?.index ?? 0,
      reflectedPositionOnly: positionOnly !== undefined,
      rasterMaterialLayout:
        currentState !== null &&
        materialShaderId !== undefined &&
        materialShaderEntry?.ok &&
        (bindingContract === 'render-material' ||
          bindingContract === 'render-lit-material-and-scene-depth' ||
          bindingContract === 'render-material-and-scene-depth' ||
          bindingContract === 'render-material-with-scene-depth') &&
        !explicitResourceLayout() &&
        !waterSystemInputs &&
        materialShaderEntry.value.receipt?.systemInputs?.water === undefined &&
        materialShaderEntry.value.receipt?.surface?.model !== 'single-layer-medium' &&
        materialShaderEntry.value.receipt?.surface?.model !== 'single-layer-water' &&
        materialShaderId !== 'forgeax::single-layer-medium' &&
        materialShaderId !== 'forgeax::single-layer-water'
          ? {
              shader: materialShaderId,
              schema: materialShaderEntry.value.paramSchema,
              layout:
                opaquePipelineLayout?.material ??
                perShaderLayout?.materialBgl ??
                currentState.materialBindGroupLayout,
              index: opaquePipelineLayout?.index ?? 0,
              perShaderLayout: perShaderLayout?.materialBgl,
              lit: bindingContract === 'render-lit-material-and-scene-depth',
            }
          : undefined,
      shadowPassMaterialLayout:
        materialShaderId === SHADOW_CASTER_SHADER_ID &&
        (layoutKind === 'pbr' || layoutKind === 'pbr-skin') &&
        currentState !== null &&
        perShaderLayout === null &&
        !explicitResourceLayout() &&
        (opaquePipelineLayout?.index ?? 0) === 0
          ? currentState.materialBindGroupLayout
          : undefined,
      primitiveReflectionLayout: opaquePipelineLayout?.primitive,
      rasterWindowLayout: opaquePipelineLayout?.window,
      standardViewLayout:
        opaquePipelineLayout?.view ??
        waterWavesLayout?.view ??
        preparedPipelineViews.get(fullPipelineLayout),
      ...(waterWavesLayout === null ? {} : { waterGroup2Layout: waterWavesLayout.group2Layout }),
      vertexBuffers,
      ...(layoutKind === 'pbr-skin' ||
      layoutKind === 'gpu-driven-skin' ||
      layoutKind === 'gpu-driven-cluster-skin'
        ? { layoutKind }
        : {}),
    };
  };
  return createMaterialPipelineContext();
}

const viewOnlyProjections = new WeakMap<
  import('@forgeax/engine-rhi').PipelineLayout,
  WeakMap<
    import('@forgeax/engine-rhi').BindGroupLayout,
    WeakMap<BindGroupLayout, WeakMap<BindGroupLayout, import('@forgeax/engine-rhi').PipelineLayout>>
  >
>();

function viewOnlyProjection(
  device: Pick<import('@forgeax/engine-rhi').RhiDevice, 'createPipelineLayout'>,
  full: import('@forgeax/engine-rhi').PipelineLayout,
  view: import('@forgeax/engine-rhi').BindGroupLayout,
  material: import('@forgeax/engine-rhi').BindGroupLayout,
  groups: NonNullable<ReturnType<typeof resolveMaterialPipelineBindGroups>>,
) {
  let layouts = viewOnlyProjections.get(full);
  if (layouts === undefined) {
    layouts = new WeakMap();
    viewOnlyProjections.set(full, layouts);
  }
  let byPrimitive = layouts.get(view);
  if (byPrimitive === undefined) {
    byPrimitive = new WeakMap();
    layouts.set(view, byPrimitive);
  }
  let byInstances = byPrimitive.get(groups.meshLayout);
  if (byInstances === undefined) {
    byInstances = new WeakMap();
    byPrimitive.set(groups.meshLayout, byInstances);
  }
  const cached = byInstances.get(groups.instancesLayout);
  if (cached !== undefined) return cached;
  const layout = device
    .createPipelineLayout({
      label: 'standard-projected-view-pipeline-layout',
      bindGroupLayouts: [view, material, groups.meshLayout, groups.instancesLayout],
    })
    .unwrap();
  byInstances.set(groups.instancesLayout, layout);
  return layout;
}

function selectedMaterialPipelineVariant(
  shaderId: string,
  shader: import('@forgeax/engine-shader').ShaderRegistry,
  variantSet: string | undefined,
  hasVertexLayout: boolean,
  requestedVariant: Parameters<typeof runBuildMaterialShaderPipeline>[5],
): string | undefined {
  const manifest = shader.materialShaderManifestEntry(shaderId);
  return resolveMaterialPipelineVariantSet(
    requestedVariant(variantSet, shaderId, manifest),
    manifest,
    shaderId,
    hasVertexLayout,
  );
}

function resolveMaterialPipelineStages(
  standardCoverage: boolean,
  stockStandard: boolean,
  shadowCaster: boolean,
  materialShaderEntry: ReturnType<ShaderCatalog['findMaterialArtifact']>,
  constants: Readonly<Record<string, number>> | undefined,
  vertexEntry: string | undefined,
  vertexEntryPoint: string | undefined,
  fragmentEntry: string | null | undefined,
) {
  const program = materialProgramSource(materialShaderEntry);
  // A custom ShadowCaster can share a Standard material's texture snapshot
  // without declaring its specialization ABI. Normalize before the PSO key
  // so undeclared Engine values neither invalidate nor duplicate that PSO.
  constants = materialProgramRasterConstants(constants, program);
  // Programs that predate fs_opaque keep their default forward entry.
  // `null` (vertex-only depth) needs no declared entry.
  if (standardCoverage) {
    vertexEntry = 'vs_coverage';
    vertexEntryPoint = 'vs_coverage';
    fragmentEntry = 'fs_coverage';
  }
  // Stock Standard binds the screen receiver through a specialized surface
  // program selected later. Its unprojected artifact need not declare the entry.
  if (!stockStandard || !isForwardShadowColorEntry(fragmentEntry)) {
    fragmentEntry = declaredOrVertexOnlyFragmentEntry(fragmentEntry, materialShaderEntry);
  }
  if (standardCoverage) constants = projectStandardCoverageConstants(constants, 'coverage');
  else if (
    shadowCaster ||
    (stockStandard &&
      (fragmentEntry === null || fragmentEntry === COLORLESS_COVERAGE_FRAGMENT_ENTRY))
  )
    constants = projectStandardCoverageConstants(
      constants,
      fragmentEntry === null ? 'vertex' : 'projected-coverage',
    );
  return { constants, vertexEntry, vertexEntryPoint, fragmentEntry };
}

function selectStockSurfaceResources(
  shader: ShaderRegistry,
  identifier: string,
  variant: string | undefined,
  pass: PassKind,
  fragment: string | null | undefined,
  constants: Readonly<Record<string, number>> | undefined,
  onPending: ((completion: PipelinePreparationCompletion) => void) | undefined,
) {
  const forward = pass === 'forward' && isStockForwardSurfaceEntry(fragment);
  const deferred =
    pass === 'deferred' && (fragment === undefined || isStandardGBufferEntry(fragment));
  if (
    !isCanonicalStandardPbrMaterialShader(identifier) ||
    (!forward && !deferred) ||
    variant === undefined ||
    variant.includes('TRANSMISSION_AVAILABLE=true') ||
    variant.includes('WATER_WAVES_AVAILABLE=true')
  )
    return undefined;
  const mask = constants?.[STANDARD_TEXTURE_MASK_OVERRIDE];
  const screenShadow = fragment === 'fs_forward_sun_shadow' ? true : undefined;
  if (mask === undefined && screenShadow === undefined) return undefined;
  return shader
    .selectStandardSurfaceProgram(
      identifier,
      variant,
      mask === undefined
        ? undefined
        : mask + (constants?.[STANDARD_ORM_REUSE_OVERRIDE] === 1 ? STANDARD_ORM_REUSE_BIT : 0),
      screenShadow,
      onPending,
    )
    .unwrap();
}

export function runBuildMaterialShaderPipeline(
  currentPipelineState: () => import('../record/render-context').PipelineState | null,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  getShader: () => import('@forgeax/engine-shader').ShaderRegistry,
  rememberMaterialUvSetCount: (
    pipelineShaderId: string,
    materialShaderEntry: import('@forgeax/engine-types').Result<
      import('@forgeax/engine-shader').RegisteredMaterialShaderEntry,
      import('@forgeax/engine-shader').ShaderError
    >,
  ) => number | undefined,
  requestedMaterialVariantSet: (
    variantSet: string | undefined,
    pipelineShaderId: string,
    manifestEntry: import('@forgeax/engine-shader').MaterialShaderManifestEntry | undefined,
  ) => string | undefined,
  pipelineRequests: WeakMap<
    import('./recovery/renderer-recover').RendererPipelineCacheState,
    import('./material/pipeline-request-cache').MaterialPipelineRequestCache<
      | import('@forgeax/engine-rhi').RenderPipeline
      | import('./material/pipeline-request-cache').PendingMaterialPipelineRequest
    >
  >,
  currentPipelineCacheState: () => import('./recovery/renderer-recover').RendererPipelineCacheState,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  preparedPipelineOwners: WeakMap<
    import('./recovery/renderer-recover').RendererPipelineCacheState,
    import('./material/prepared-pipeline-owner').PreparedRenderPipelineOwner
  >,
  materialPipelineBuildable: (cacheKey: string) => boolean,
  prepareMaterialProgram: (id: string) => boolean,
  onPending: ((completion: PipelinePreparationCompletion) => void) | undefined,
  selectMaterialPipelineSource: (
    pipelineShaderId: string,
    effectiveVariantSet: string | undefined,
    isHdr: boolean,
    passKind: string,
    renderState: import('@forgeax/engine-types').MaterialRenderState | undefined,
    depthFormatOverride: GPUTextureFormat | null | undefined,
    vertexLayout: string | undefined,
    surfaceProgram?: Pick<RegisteredMaterialShaderEntry, 'program' | 'receipt'>,
  ) => import('./webgpu-renderer-contract').MaterialPipelineSource | null,
  buildAndCachePipeline: (
    cacheKey: string,
    entry: import('@forgeax/engine-shader').MaterialShaderEntry,
    label: string,
    moduleLabel: string,
    isHdr: boolean,
    attachments: {
      readonly colorFormats: readonly GPUTextureFormat[];
      readonly depthFormat: GPUTextureFormat | undefined;
      readonly sampleCount: 1 | 4;
    },
    renderState: import('@forgeax/engine-types').MaterialRenderState | undefined,
    topology: GPUPrimitiveTopology | undefined,
    stripIndexFormat: 'uint16' | 'uint32' | undefined,
    variantSet?: string | undefined,
    passKind?: string,
    materialShaderId?: string | undefined,
    meshAttributes?: import('@forgeax/engine-types').VertexAttributeMap | undefined,
    vertexLayout?: string | undefined,
    vertexLayoutProjection?: import('@forgeax/engine-geometry').VertexLayoutProjection | undefined,
    shaderModuleMode?: import('../features/types').RenderFeatureShaderModuleMode | undefined,
    layoutKindOverride?: import('./material-shader-policy').LayoutKind | undefined,
    vertexEntryPoint?: string | undefined,
    vertexEntry?: string | undefined,
    authoredFragmentEntry?: string | null | undefined,
    particleInputLanes?: number | undefined,
    coverageOnly?: boolean,
    constants?: Readonly<Record<string, number>> | undefined,
    pipelinePreparation?: boolean,
    waterInfoFormat?: 'rgba16float' | 'rgba32float' | undefined,
    preparedStorageBindings?: boolean,
    projectSurfaceResources?: boolean,
  ) => import('@forgeax/engine-rhi').RenderPipeline | null,
  getOrBuildPreparedStoragePipelineLayout: ReturnType<
    typeof createMaterialLayoutCache
  >['getOrBuildPreparedStoragePipelineLayout'],
  inspectRequest:
    | ((request: RasterPassRequestInspection, pipeline: RenderPipeline | null) => void)
    | undefined,
  materialShaderId: string,
  isHdr: boolean,
  renderState?: MaterialRenderState,
  topology?: PrimitiveTopology,
  indexFormat?: 'uint16' | 'uint32',
  variantSet?: string,
  passKind: PassKind = 'forward',
  meshAttributes?: VertexAttributeMap,
  sampleCount: number = 1,
  colorFormatOverride?: GPUTextureFormat | null,
  shaderUvSetCount?: number,
  depthFormatOverride?: GPUTextureFormat | null,
  vertexLayout?: string,
  vertexLayoutProjection?: VertexLayoutProjection,
  shaderModuleMode: RenderFeatureShaderModuleMode = 'validated',
  layoutKindOverride?: LayoutKind,
  vertexEntryPoint?: string,
  additionalColorFormats?: readonly GPUTextureFormat[],
  vertexEntry?: string,
  fragmentEntry?: string | null,
  particleInputLanes?: number,
  constants?: Readonly<Record<string, number>>,
  waterInfoFormat?: 'rgba16float' | 'rgba32float',
  preparedStorageBindings = false,
  pipelinePreparation = false,
): RenderPipeline | null {
  const requestedVariant = variantSet;
  // The raster class requests LOD-fade / view-clipping discards as a mask;
  // they are a compile-time source axis, so resolve them before any key.
  ({ variantSet, constants } = applySurfaceDiscardAxis(variantSet, constants));
  const requestedCoverage = variantSet?.includes('COVERAGE_ONLY=true') === true;
  const stockStandard = isCanonicalStandardPbrMaterialShader(materialShaderId);
  const standardCoverage = requestedCoverage && stockStandard;
  const coverageOnly = requestedCoverage && (passKind === 'temporal' || standardCoverage);
  // WebGL2 is a downlevel backend even when the record stage asks for the
  // native-capability variant string. Resolve the variant axes at this
  // shared PSO seam so the shader source, BGL layout, and cache key agree on
  // the actual device capabilities. Without this, WebGL2 can build a
  // storage-buffer PSO around a uniform-buffer shader and only reject it at
  // queue submit as an invalid RenderPipeline.
  const currentState = currentPipelineState();
  const ldrColorFormat: GPUTextureFormat =
    colorFormatOverride ??
    (currentState !== null ? currentState.colorAttachmentFormat : 'bgra8unorm-srgb');
  const materialShaderIdForPass = resolveMaterialPipelineShaderId(materialShaderId, passKind);
  const pipelineShaderId = resolveMaterialShaderBackendArtifactKey(
    materialShaderIdForPass,
    internals.device.caps.backendKind,
    assets.getMaterialArtifact(materialShaderIdForPass),
  );
  const shader = getShader();
  // Select the same source, layout and cache key before starting any source work.
  const selectedVariantSet = selectedMaterialPipelineVariant(
    pipelineShaderId,
    shader,
    variantSet,
    vertexLayoutProjection !== undefined,
    requestedMaterialVariantSet,
  );
  // The opaque GBuffer only sees inactive transmission. A numeric zero may
  // still have reserved the stock Forward transmission variant upstream.
  const effectiveVariantSet =
    passKind === 'deferred' &&
    stockStandard &&
    selectedVariantSet?.includes('WATER_WAVES_AVAILABLE=true') !== true
      ? selectedVariantSet?.replace('TRANSMISSION_AVAILABLE=true', 'TRANSMISSION_AVAILABLE=false')
      : selectedVariantSet;
  const selectedArtifactId = shader.materialVariantArtifactIdentifier(
    pipelineShaderId,
    effectiveVariantSet,
  );
  if (!prepareMaterialProgram(selectedArtifactId)) return null;
  const materialShaderEntry = shader.findMaterialArtifact(selectedArtifactId);
  ({ constants, vertexEntry, vertexEntryPoint, fragmentEntry } = resolveMaterialPipelineStages(
    standardCoverage,
    stockStandard,
    pipelineShaderId === SHADOW_CASTER_SHADER_ID,
    materialShaderEntry,
    constants,
    vertexEntry,
    vertexEntryPoint,
    fragmentEntry,
  ));
  const createMaterialPipelineSpec = () => {
    const resolvedUvSetCount =
      shaderUvSetCount ?? rememberMaterialUvSetCount(pipelineShaderId, materialShaderEntry);
    const colorFormat: GPUTextureFormat | null =
      colorFormatOverride === null
        ? null
        : (renderState?.outputs?.[0]?.format ?? (isHdr ? 'rgba16float' : ldrColorFormat));
    additionalColorFormats ??= renderState?.outputs?.slice(1).map((output) => output.format);
    const resolvedVertexEntry = materialPipelineKeyVertexEntry(
      layoutKindOverride,
      vertexEntryPoint,
      vertexEntry,
      vertexLayoutProjection,
    );
    const spec: PipelineSpec = {
      shader: materialPipelineShaderSpec(
        pipelineShaderId,
        passKind,
        effectiveVariantSet,
        resolvedVertexEntry,
        fragmentEntry ?? undefined,
        constants,
      ),
      attachments: materialPipelineAttachments(
        passKind,
        colorFormat,
        additionalColorFormats,
        depthFormatOverride,
        sampleCount,
        colorFormatOverride === null,
      ),
      geometry: materialPipelineGeometry(
        topology,
        indexFormat,
        materialPipelineVertexAttributes(meshAttributes, vertexLayout),
        resolvedUvSetCount,
        vertexLayoutProjection,
        particleMaterialInputVertexBuffers(vertexLayout, particleInputLanes),
      ),
      renderState,
    };
    return { spec, resolvedVertexEntry };
  };
  const { spec, resolvedVertexEntry } = createMaterialPipelineSpec();
  const storageLayout = preparedStorageBindings
    ? getOrBuildPreparedStoragePipelineLayout(pipelineShaderId, effectiveVariantSet)
    : undefined;
  if (preparedStorageBindings && !storageLayout) return null;
  const cacheKey = `${materialPipelineCacheKey(cacheKeyOf(spec), resolvedVertexEntry, fragmentEntry)}|layout:${layoutKindOverride ?? ''}|water-info:${waterInfoFormat ?? ''}|storage:${storageLayout?.identity ?? ''}`;
  const requestCounter = pipelineRequests.get(currentPipelineCacheState());
  if (requestCounter !== undefined) requestCounter.keyCharacters += cacheKey.length;
  const cached = currentPipelineCacheState().materialShaderPipelineCache.get(cacheKey);
  const selectMaterialPipelinePreparation = () => {
    const prepare =
      currentBuildDevice().createRenderPipelineAsync !== undefined &&
      (pipelinePreparation ||
        preparedPipelineOwners.get(currentPipelineCacheState())?.has(cacheKey) === true);
    return prepare;
  };
  const prepare = selectMaterialPipelinePreparation();
  if (cached !== undefined && !prepare) return cached;
  if (!materialPipelineBuildable(cacheKey)) return null;
  const buildSelectedPipeline = () => {
    // The request key already includes the texture availability mask and packed ORM flag.
    // Resolve the projected program only when building its PSO for the first time.
    const surfaceProgram = selectStockSurfaceResources(
      shader,
      pipelineShaderId,
      effectiveVariantSet,
      passKind,
      fragmentEntry,
      constants,
      onPending,
    );
    if (surfaceProgram === 'pending') return null;
    const selectedConstants = materialProgramRasterConstants(constants, surfaceProgram?.program);
    const source = selectMaterialPipelineSource(
      pipelineShaderId,
      effectiveVariantSet,
      isHdr,
      passKind,
      renderState,
      depthFormatOverride,
      vertexLayout,
      surfaceProgram,
    );
    if (source !== null && passKind === 'deferred')
      requireStandardGBufferReceipt(source.entry.receipt, fragmentEntry === 'fs_gbuffer_compact');
    // Fallback sources compile a different program, so caller-selected
    // entry points and particle lanes belong only to the registered shader.
    const ownEntries = source?.ownEntries === true;
    const pipeline =
      source === null
        ? null
        : buildAndCachePipeline(
            cacheKey,
            source.entry,
            source.label,
            source.moduleLabel,
            isHdr,
            spec.attachments,
            renderState,
            topology,
            indexFormat,
            // M4.5 / w37 (D-10): every path threads variantSet so HDRP-variant PSOs
            // build against `hdrpPbrPipelineLayout` (7-slot group(2) BGL) and URP
            // builds against `pbrPipelineLayout` (1-slot group(2) BGL).
            effectiveVariantSet,
            // feat-20260609 / T-002: passKind selects createRenderPipeline
            // attachment shape (forward color+DS vs shadow-caster depth32float
            // no-color). Orthogonal to variantSet (which selects the BGL chain).
            passKind,
            // The layout shader id lets buildPipelineContext resolve the BGL chain
            // (for example LayoutKind='pbr-skin') that matches the compiled module.
            source.layoutShaderId,
            // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w16 (D-4):
            // forward meshAttributes so the pbr-skin path's vertex buffer layout
            // is derived via the SSOT (deriveVertexBufferLayout). For URP/HDRP
            // callers (and for a caller passing undefined) the synthetic 6-key
            // sentinel inside buildPipelineContext keeps the layout deterministic.
            meshAttributes,
            vertexLayout,
            vertexLayoutProjection,
            shaderModuleMode,
            layoutKindOverride,
            vertexEntryPoint,
            ownEntries ? vertexEntry : undefined,
            ownEntries ? fragmentEntry : undefined,
            ownEntries ? particleInputLanes : undefined,
            coverageOnly,
            selectedConstants,
            prepare,
            waterInfoFormat,
            preparedStorageBindings,
            surfaceProgram !== undefined,
          );
    inspectRequest?.(
      {
        material: materialShaderId,
        requestedVariant,
        shader: spec.shader,
        attachments: spec.attachments,
        layout: layoutKindOverride,
        waterInfoFormat,
        preparing: prepare,
        selection: source === null ? 'unavailable' : ownEntries ? 'registered' : 'fallback',
        pipelineLabel: source?.label,
      },
      pipeline,
    );
    return pipeline;
  };
  return buildSelectedPipeline();
}

export function runRememberMaterialUvSetCount(
  currentMaterialShaderUvSetCounts: () => Map<string, number>,
  pipelineShaderId: string,
  materialShaderEntry: ReturnType<ShaderCatalog['findMaterialArtifact']>,
): number | undefined {
  const currentMaterialUvSetCounts = currentMaterialShaderUvSetCounts();
  const materialUvSetCount =
    currentMaterialUvSetCounts.get(pipelineShaderId) ??
    (materialShaderEntry.ok ? materialShaderEntry.value.program.uvSetCount : undefined);
  if (materialUvSetCount !== undefined) {
    currentMaterialUvSetCounts.set(pipelineShaderId, materialUvSetCount);
  }
  return materialUvSetCount;
}

export function runRequestedMaterialVariantSet(
  resolveCachedMaterialShaderVariantSet: (
    requestedVariantSet: string | undefined,
    manifestEntry: import('@forgeax/engine-shader').MaterialShaderManifestEntry | undefined,
  ) => string | undefined,
  variantSet: string | undefined,
  pipelineShaderId: string,
  manifestEntry: MaterialShaderManifestEntry | undefined,
): string | undefined {
  return variantSet === undefined &&
    (pipelineShaderId === 'forgeax::sprite' || pipelineShaderId === 'forgeax::sprite-lit')
    ? undefined
    : resolveCachedMaterialShaderVariantSet(variantSet, manifestEntry);
}

export function runSelectMaterialPipelineSource(
  getShader: () => import('@forgeax/engine-shader').ShaderRegistry,
  selectUnlitPreparedFallback: (
    pipelineShaderId: string,
    depthFormatOverride: GPUTextureFormat | null | undefined,
    vertexLayout: string | undefined,
  ) => {
    entry: import('@forgeax/engine-shader').RegisteredMaterialShaderEntry;
    label: string;
    moduleLabel: string;
    layoutShaderId: string;
    ownEntries: boolean;
  } | null,
  selectStandardPbrFallback: (
    pipelineShaderId: string,
    effectiveVariantSet: string | undefined,
    isHdr: boolean,
  ) => {
    entry: { source: string; paramSchema: never[] };
    label: string;
    moduleLabel: string;
    layoutShaderId: string;
    ownEntries: boolean;
  } | null,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  pipelineShaderId: string,
  effectiveVariantSet: string | undefined,
  isHdr: boolean,
  passKind: PassKind,
  renderState: MaterialRenderState | undefined,
  depthFormatOverride: GPUTextureFormat | null | undefined,
  vertexLayout: string | undefined,
  surfaceProgram?: Pick<RegisteredMaterialShaderEntry, 'program' | 'receipt'>,
): MaterialPipelineSource | null {
  const shader = getShader();
  const selectedArtifactId = shader.materialVariantArtifactIdentifier(
    pipelineShaderId,
    effectiveVariantSet,
  );
  const lookup = shader.findMaterialArtifact(selectedArtifactId);
  if (!lookup.ok) {
    if (requiresPreparedMaterialShader(vertexLayout)) {
      // Only a registered shader can be warming up. Preserve a permanent
      // lookup failure instead of turning it into an endless pending PSO.
      throw lookup.error;
    }
    return renderState === undefined
      ? selectUnlitPreparedFallback(pipelineShaderId, depthFormatOverride, vertexLayout)
      : selectStandardPbrFallback(pipelineShaderId, effectiveVariantSet, isHdr);
  }
  // feat-20260609 M4 / w31: a non-empty variantSet substitutes the manifest
  // variant's composedWgsl; the pipeline layout itself is built by
  // buildPbrPipelineLayouts (M3 / w12). `''` is canonical all-true (HDRP)
  // and also enters the lookup; `undefined` keeps the boot-time entry.
  const artifactEntry =
    selectedArtifactId === pipelineShaderId
      ? manifestVariantShaderEntry(shader, pipelineShaderId, effectiveVariantSet, lookup.value)
      : lookup.value;
  const selectedEntry =
    surfaceProgram === undefined
      ? artifactEntry
      : {
          ...artifactEntry,
          source: surfaceProgram.program.source,
          sourceReference: surfaceProgram.program.sourceReference,
          program: surfaceProgram.program,
          receipt: surfaceProgram.receipt ?? artifactEntry.receipt,
        };
  const loweredEntry = prepareLowLimitMaterialShaderEntry(
    selectedEntry,
    currentBuildDevice().limits.maxSampledTexturesPerShaderStage,
  );
  const previousProgram = (loweredEntry as Partial<RegisteredMaterialShaderEntry>).program;
  const program =
    previousProgram ??
    getShader().materialProgram(
      (loweredEntry as MaterialShaderEntry).sourceReference ?? loweredEntry.source,
    );
  const shaderEntry = Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(loweredEntry),
      program: { value: program, enumerable: true },
      sourceReference: { value: program.sourceReference, enumerable: true },
      source: { get: () => program.source, enumerable: true },
    },
  ) as RegisteredMaterialShaderEntry;
  // feat-20260609 M4 / R3-fixup: append `-${passKind}` to the PSO label so
  // GPU debug captures make the cache variant visible.
  const passKindLabelSegment = passKind === 'forward' ? '' : `-${passKind}`;
  const variantModuleLabel =
    effectiveVariantSet === undefined
      ? `module-${pipelineShaderId}`
      : `module-${pipelineShaderId}#${effectiveVariantSet}`;
  return {
    entry: shaderEntry,
    label: `pbr-pipeline-${pipelineShaderId}${isHdr ? '-hdr' : ''}${passKindLabelSegment}`,
    // Depth and projected color may request different WGSL for the same variant
    // in one frame. Each projected source must keep its own async module request.
    moduleLabel:
      surfaceProgram === undefined
        ? variantModuleLabel
        : `${variantModuleLabel}|surface:${program.sourceReference.identity}`,
    layoutShaderId: pipelineShaderId,
    ownEntries: true,
  };
}

export function runSelectUnlitPreparedFallback(
  getShader: () => import('@forgeax/engine-shader').ShaderRegistry,
  pipelineShaderId: string,
  depthFormatOverride: GPUTextureFormat | null | undefined,
  vertexLayout: string | undefined,
) {
  // A prepared feature declares the vertex layout it owns. Falling back
  // to default-unlit here would pair that data with the unlit shader's
  // position/normal/uv/tangent inputs and let WebGPU reject the
  // pipeline at validation time. Keep the missing shader retryable and
  // preserve the declared input contract instead.
  if (!allowsUnlitPreparedFallback(depthFormatOverride, vertexLayout, pipelineShaderId))
    return null;
  const unlitLookup = getShader().findMaterialArtifact('forgeax::default-unlit');
  if (!unlitLookup.ok) return null;
  return {
    entry: unlitLookup.value,
    label: `pbr-pipeline-prepared-${pipelineShaderId}`,
    // Reuse the eagerly compiled engine unlit module. The adapter cache
    // is seeded under this label during renderer readiness; a new label
    // would keep color-only prepared passes in perpetual warm-up.
    moduleLabel: 'unlit',
    layoutShaderId: 'forgeax::default-unlit',
    ownEntries: false,
  };
}

export function runSelectStandardPbrFallback(
  getShader: () => import('@forgeax/engine-shader').ShaderRegistry,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  pipelineShaderId: string,
  effectiveVariantSet: string | undefined,
  isHdr: boolean,
) {
  const pbrEntry = findStandardPbrEntry(getShader(), currentBuildDevice(), effectiveVariantSet);
  if (pbrEntry === undefined) return null;
  // Reuse readiness only for byte-identical WGSL. A fallback can select a
  // different capability variant, so one shared fallback label is unsafe.
  const family = getShader().materialShaderManifestEntry('forgeax::default-standard-pbr');
  const preparedVariant =
    family === undefined
      ? undefined
      : materialShaderPreparedSourceRows(family).find(
          (variant): variant is MaterialShaderManifestVariant =>
            'definesKey' in variant && materialShaderSourceEquals(variant, pbrEntry.wgsl),
        );
  return {
    entry: { source: pbrEntry.wgsl, paramSchema: [] },
    label: `pbr-pipeline-fallback-${pipelineShaderId}${isHdr ? '-hdr' : ''}`,
    moduleLabel:
      preparedVariant === undefined
        ? `module-fallback-pbr#${getShader().materialProgram(pbrEntry.wgsl, pbrEntry.entryPoints).identity}`
        : `module-forgeax::default-standard-pbr#${preparedVariant.definesKey}`,
    // bug-20260611-skin-pipeline-layout: a missing skin registration keeps
    // its own id so the pbr-skin fail-fast (null layout) is preserved. Every
    // other id resolves the layout of the built-in PBR module compiled here,
    // whose vertex stage declares all eight UV inputs (MaterialAsset
    // per-slot texCoord): a sprite id would otherwise resolve a 4-attribute
    // layout the PBR module rejects.
    layoutShaderId:
      pipelineShaderId === SKIN_MATERIAL_SHADER_ID
        ? pipelineShaderId
        : 'forgeax::default-standard-pbr',
    ownEntries: false,
  };
}

export function runGetMaterialShaderPipelineFor(
  buildMaterialShaderPipeline: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: import('@forgeax/engine-types').MaterialRenderState | undefined,
    topology?: GPUPrimitiveTopology | undefined,
    indexFormat?: 'uint16' | 'uint32' | undefined,
    variantSet?: string | undefined,
    passKind?: string,
    meshAttributes?: import('@forgeax/engine-types').VertexAttributeMap | undefined,
    sampleCount?: number,
    colorFormatOverride?: GPUTextureFormat | null | undefined,
    shaderUvSetCount?: number | undefined,
    depthFormatOverride?: GPUTextureFormat | null | undefined,
    vertexLayout?: string | undefined,
    vertexLayoutProjection?: import('@forgeax/engine-geometry').VertexLayoutProjection | undefined,
    shaderModuleMode?: import('../features/types').RenderFeatureShaderModuleMode,
    layoutKindOverride?: import('./material-shader-policy').LayoutKind | undefined,
    vertexEntryPoint?: string | undefined,
    additionalColorFormats?: readonly GPUTextureFormat[] | undefined,
    vertexEntry?: string | undefined,
    fragmentEntry?: string | null | undefined,
    particleInputLanes?: number | undefined,
    constants?: Readonly<Record<string, number>> | undefined,
    waterInfoFormat?: 'rgba16float' | 'rgba32float' | undefined,
    preparedStorageBindings?: boolean,
    pipelinePreparation?: boolean,
  ) => import('@forgeax/engine-rhi').RenderPipeline | null,
  getShader: () => import('@forgeax/engine-shader').ShaderRegistry,
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  internals: import('./webgpu-renderer-contract').WebGPURendererInternals,
  currentPipelineCacheState: () => import('./recovery/renderer-recover').RendererPipelineCacheState,
  pipelineRequests: WeakMap<
    import('./recovery/renderer-recover').RendererPipelineCacheState,
    import('./material/pipeline-request-cache').MaterialPipelineRequestCache<
      | import('@forgeax/engine-rhi').RenderPipeline
      | import('./material/pipeline-request-cache').PendingMaterialPipelineRequest
    >
  >,
  pipelineRequestScratch: Parameters<typeof materialPipelineRequestFacts>[1],
  currentMaterialShaderUvSetCounts: () => Map<string, number>,
  currentPipelineState: () => import('../record/render-context').PipelineState | null,
  currentBuildDevice: () => import('@forgeax/engine-rhi').RhiDevice,
  preparedPipelineOwners: WeakMap<
    import('./recovery/renderer-recover').RendererPipelineCacheState,
    import('./material/prepared-pipeline-owner').PreparedRenderPipelineOwner
  >,
  args: Parameters<typeof buildMaterialShaderPipeline>,
  lookupOnly = false,
  requestedVariant: Parameters<typeof runBuildMaterialShaderPipeline>[5],
  observePending = false,
): RenderPipeline | null {
  const registry = getShader();
  const shaderId = resolveMaterialPipelineShaderId(args[0], args[6] ?? 'forward');
  const asset = assets.getMaterialArtifact(shaderId);
  const artifactId = resolveMaterialShaderBackendArtifactKey(
    shaderId,
    internals.device.caps.backendKind,
    asset,
  );
  let selectedArtifact = artifactId;
  if (registry.isSourceBackedMaterialArtifact(artifactId)) {
    // Artifact selection needs the discard axes. The PSO builder owns the stage constants.
    const constants = args[21];
    const variantSet =
      constants !== undefined && Object.hasOwn(constants, STANDARD_SURFACE_DISCARDS_OVERRIDE)
        ? variantSetForSurfaceDiscards(args[5], constants[STANDARD_SURFACE_DISCARDS_OVERRIDE] ?? 0)
        : args[5];
    const key = selectedMaterialPipelineVariant(
      artifactId,
      registry,
      variantSet,
      args[13] !== undefined,
      requestedVariant,
    );
    selectedArtifact = registry.materialVariantArtifactIdentifier(artifactId, key);
  }
  const artifact = registry.findMaterialArtifact(selectedArtifact);
  // Missing artifacts and pending pipelines remain retryable.
  if (!artifact.ok) return lookupOnly ? null : buildMaterialShaderPipeline(...args);
  const owner = currentPipelineCacheState();
  let requests = pipelineRequests.get(owner);
  if (requests === undefined) {
    if (lookupOnly) return null;
    requests = new MaterialPipelineRequestCache();
    pipelineRequests.set(owner, requests);
  }
  // Lookups reuse one scratch fact list; a miss stores its own copy before
  // building, since a build may request another pipeline.
  const facts = materialPipelineRequestFacts(args, pipelineRequestScratch);
  facts.push(args[24] ?? false);
  facts.push(
    currentMaterialShaderUvSetCounts().get(artifactId),
    registry,
    artifact.value,
    registry.materialShaderManifestEntry(artifactId),
    asset,
    currentPipelineState(),
    currentBuildDevice(),
  );
  return requestMaterialPipeline(
    requests,
    facts,
    lookupOnly,
    () => buildMaterialShaderPipeline(...args),
    () => preparedPipelineOwners.get(owner),
    observePending,
  );
}

export interface MaterialPipelineSelection {
  readonly rasterMaterialLayout?: MaterialShaderPipelineEntry['rasterMaterialLayout'];
  readonly shadowPassMaterialLayout?: BindGroupLayout;
  readonly contract: PipelineGroup2Contract;
  readonly waterLayout?: BindGroupLayout;
  readonly selected?: Pick<
    MaterialShaderArtifact,
    'material' | 'specializationKey' | 'program' | 'receipt'
  >;
}

/** Record what a built pipeline was selected with; shadow layouts count only for stages that ignore the material. */
export function materialPipelineSelection(
  group2Contract: PipelineGroup2Contract,
  ctx: Pick<
    NonNullable<ReturnType<typeof runBuildPipelineContext>>,
    'rasterMaterialLayout' | 'shadowPassMaterialLayout' | 'waterGroup2Layout' | 'vertexBuffers'
  >,
  passKind: PassKind,
  stages: {
    readonly entryPoints: readonly ShaderEntryPointReads[] | undefined;
    readonly vertex: string | undefined;
    readonly fragment: string | null;
  },
  selected: MaterialPipelineSelection['selected'],
): MaterialPipelineSelection {
  return {
    contract: group2Contract,
    ...(ctx.rasterMaterialLayout === undefined
      ? {}
      : { rasterMaterialLayout: ctx.rasterMaterialLayout }),
    ...(passKind === 'shadow-caster' &&
    ctx.shadowPassMaterialLayout !== undefined &&
    shadowStagesIgnoreMaterial(
      stages.entryPoints,
      pipelineVertexEntry(stages.vertex, passKind, ctx.vertexBuffers),
      stages.fragment,
    )
      ? { shadowPassMaterialLayout: ctx.shadowPassMaterialLayout }
      : {}),
    ...(ctx.waterGroup2Layout === undefined ? {} : { waterLayout: ctx.waterGroup2Layout }),
    ...(selected === undefined ? {} : { selected }),
  };
}

function createMaterialPipelineEntry(
  pipeline: RenderPipeline,
  group2Contract: PipelineGroup2Contract,
  artifact: MaterialPipelineSelection['selected'],
  selectedGroup2: MaterialPipelineSelection | undefined,
): MaterialShaderPipelineEntry {
  const receipt = artifact?.receipt;
  const materialProgramKey = artifact?.specializationKey ?? artifact?.material;
  const inputs = artifact === undefined ? undefined : materialProgramInputs(artifact);
  return {
    pipeline,
    group2Contract,
    ...(selectedGroup2?.rasterMaterialLayout === undefined
      ? {}
      : { rasterMaterialLayout: selectedGroup2.rasterMaterialLayout }),
    ...(selectedGroup2?.shadowPassMaterialLayout === undefined
      ? {}
      : { shadowPassMaterialLayout: selectedGroup2.shadowPassMaterialLayout }),
    ...(materialProgramKey === undefined ? {} : { materialProgramKey }),
    ...(artifact?.program === undefined ? {} : { program: artifact.program }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(selectedGroup2?.waterLayout === undefined
      ? {}
      : { waterGroup2Layout: selectedGroup2.waterLayout }),
    ...(receipt === undefined
      ? {}
      : { receipt: { identity: receipt.receiptIdentity, generation: receipt.generation } }),
  };
}

export function runGetMaterialShaderPipelineEntryFor(
  buildMaterialShaderPipeline: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: import('@forgeax/engine-types').MaterialRenderState | undefined,
    topology?: GPUPrimitiveTopology | undefined,
    indexFormat?: 'uint16' | 'uint32' | undefined,
    variantSet?: string | undefined,
    passKind?: string,
    meshAttributes?: import('@forgeax/engine-types').VertexAttributeMap | undefined,
    sampleCount?: number,
    colorFormatOverride?: GPUTextureFormat | null | undefined,
    shaderUvSetCount?: number | undefined,
    depthFormatOverride?: GPUTextureFormat | null | undefined,
    vertexLayout?: string | undefined,
    vertexLayoutProjection?: import('@forgeax/engine-geometry').VertexLayoutProjection | undefined,
    shaderModuleMode?: import('../features/types').RenderFeatureShaderModuleMode,
    layoutKindOverride?: import('./material-shader-policy').LayoutKind | undefined,
    vertexEntryPoint?: string | undefined,
    additionalColorFormats?: readonly GPUTextureFormat[] | undefined,
    vertexEntry?: string | undefined,
    fragmentEntry?: string | null | undefined,
    particleInputLanes?: number | undefined,
    constants?: Readonly<Record<string, number>> | undefined,
    waterInfoFormat?: 'rgba16float' | 'rgba32float' | undefined,
    preparedStorageBindings?: boolean,
    pipelinePreparation?: boolean,
  ) => import('@forgeax/engine-rhi').RenderPipeline | null,
  getMaterialShaderPipelineFor: (
    args: [
      materialShaderId: string,
      isHdr: boolean,
      renderState?: import('@forgeax/engine-types').MaterialRenderState | undefined,
      topology?: GPUPrimitiveTopology | undefined,
      indexFormat?: 'uint16' | 'uint32' | undefined,
      variantSet?: string | undefined,
      passKind?: string | undefined,
      meshAttributes?: import('@forgeax/engine-types').VertexAttributeMap | undefined,
      sampleCount?: number | undefined,
      colorFormatOverride?: GPUTextureFormat | null | undefined,
      shaderUvSetCount?: number | undefined,
      depthFormatOverride?: GPUTextureFormat | null | undefined,
      vertexLayout?: string | undefined,
      vertexLayoutProjection?:
        | import('@forgeax/engine-geometry').VertexLayoutProjection
        | undefined,
      shaderModuleMode?: import('../features/types').RenderFeatureShaderModuleMode | undefined,
      layoutKindOverride?: import('./material-shader-policy').LayoutKind | undefined,
      vertexEntryPoint?: string | undefined,
      additionalColorFormats?: readonly GPUTextureFormat[] | undefined,
      vertexEntry?: string | undefined,
      fragmentEntry?: string | null | undefined,
      particleInputLanes?: number | undefined,
      constants?: Readonly<Record<string, number>> | undefined,
      waterInfoFormat?: 'rgba16float' | 'rgba32float' | undefined,
      preparedStorageBindings?: boolean | undefined,
      pipelinePreparation?: boolean | undefined,
    ],
    lookupOnly?: boolean,
  ) => import('@forgeax/engine-rhi').RenderPipeline | null,
  getMaterialShaderArtifact: (
    materialShaderId: string,
    request?: import('./material/assembly').MaterialShaderArtifactRequest | boolean,
  ) => import('@forgeax/engine-shader').MaterialShaderArtifact | undefined,
  materialShaderPipelineSelections: WeakMap<object, MaterialPipelineSelection>,
  pipelineEntries: WeakMap<
    object,
    import('../record/render-context').MaterialShaderPipelineEntry[]
  >,
  args: Parameters<typeof buildMaterialShaderPipeline>,
  lookupOnly = false,
) {
  const pipeline = getMaterialShaderPipelineFor(args, lookupOnly);
  if (pipeline === null) return null;
  const materialShaderId = args[0];
  const variantSet = args[5];
  const passKind = args[6] ?? 'forward';
  const vertexLayoutProjection = args[13];
  const layoutKind = args[15];
  const surfaceDiscards = args[21]?.[STANDARD_SURFACE_DISCARDS_OVERRIDE];
  const selectedGroup2 = materialShaderPipelineSelections.get(pipeline as object);
  const selectedProgram = selectedGroup2?.selected;
  // Material pipelines retain the exact program and producer receipt they
  // used at creation. Shared native handles can have another material owner.
  const artifact =
    selectedProgram?.material === materialShaderId
      ? selectedProgram
      : getMaterialShaderArtifact(
          materialShaderId,
          materialPipelineArtifactRequest(
            surfaceDiscards === undefined
              ? variantSet
              : variantSetForSurfaceDiscards(variantSet, surfaceDiscards),
            passKind,
            vertexLayoutProjection,
            layoutKind,
          ),
        );
  const group2Contract = selectedGroup2?.contract ?? ('mesh' as const);
  // One entry per pipeline, contract and receipt version; draws re-read it.
  const receipt = artifact?.receipt;
  const materialProgramKey = artifact?.specializationKey ?? artifact?.material;
  let entries = pipelineEntries.get(pipeline as object);
  for (const cached of entries ?? [])
    if (
      cached.group2Contract === group2Contract &&
      cached.rasterMaterialLayout === selectedGroup2?.rasterMaterialLayout &&
      cached.shadowPassMaterialLayout === selectedGroup2?.shadowPassMaterialLayout &&
      cached.program === artifact?.program &&
      cached.materialProgramKey === materialProgramKey &&
      cached.receipt?.identity === receipt?.receiptIdentity &&
      cached.receipt?.generation === receipt?.generation
    )
      return cached;
  const entry = createMaterialPipelineEntry(pipeline, group2Contract, artifact, selectedGroup2);
  if (entries === undefined) {
    entries = [];
    pipelineEntries.set(pipeline as object, entries);
  }
  if (entries.length >= 8) entries.shift();
  entries.push(entry);
  return entry;
}
