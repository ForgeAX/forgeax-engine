import {
  type BindGroupLayout,
  type BindGroupLayoutEntry,
  type PipelineLayout,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import {
  findVariantByKey,
  PARTICLE_MESH_SURFACE_PARAM_SCHEMA,
  type ShaderCatalog,
  standardPhysicalTextureFields,
} from '@forgeax/engine-shader';
import {
  derive,
  MATERIAL_POST_PROCESS_SCENE_LAYOUT,
  type MaterialProgramBindingContract,
  type ParamSchemaEntry,
  type ShaderReflection,
  sha256,
} from '@forgeax/engine-types';
import { materialUsesPlanarReflection } from '../../capture/planar-material';
import { materialUsesDirectDfgLut } from '../../device/direct-dfg-lut';
import {
  clusterViewLayoutEntries,
  projectViewLayout,
  retainViewLayout,
  viewEntryReads,
} from '../../environment/bindings';
import { MaterialSampledTextureBudgetExceededError } from '../../errors/render';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../../gpu-stage';
import {
  buildPbrViewBglEntries,
  isStandardPbrMaterialShader,
  materialUsesLitSceneInputs,
  materialUsesSurfaceSceneInputs,
  projectSurfaceMaterialBindings,
  retainProjectedMaterialSlots,
} from '../../pbr-pipeline';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from '../../pipeline-spec';
import { FirstEntryMap } from '../../record/first-entry-map';
import type { PipelineState } from '../../record/render-context';
import { waterMaterialFrameBindGroupLayoutEntries } from '../../water/wave-material';
import { transmissionBackdropAvailable } from '../device-feature-admission';
import {
  isSharedMaterialUserRegionCompatible,
  type LayoutKind,
  type MaterialShaderBindingContract,
  resolveMaterialShaderBindingContract,
} from '../material-shader-policy';
import type {
  PerShaderMaterialLayoutCacheEntry,
  PreparedMaterialPipelineLayoutCacheEntry,
  RendererPipelineCacheState,
} from '../recovery/renderer-recover';
import {
  isSharedLayoutMaterialShader,
  resolveMaterialPipelineBindGroups,
} from './pipeline-helpers';
import { MaterialPipelineRequestCache } from './pipeline-request-cache';

/** Material layouts use the active or candidate generation's existing cache. */
export const preparedPipelineViews = new WeakMap<PipelineLayout, BindGroupLayout>();

export function createMaterialLayoutCache({
  currentPipelineCacheState,
  currentPipelineState,
  currentBuildDevice,
  getShader,
  viewAndSceneDepthLayoutEntries,
  reportError,
}: {
  readonly currentPipelineCacheState: () => RendererPipelineCacheState;
  readonly currentPipelineState: () => PipelineState | null;
  readonly currentBuildDevice: () => RhiDevice;
  readonly getShader: () => ShaderCatalog;
  readonly viewAndSceneDepthLayoutEntries: () => GPUBindGroupLayoutEntry[];
  readonly reportError: (error: RhiError) => void;
}) {
  const getMaterialShaderBindingContract = (
    materialShaderId: string,
  ): MaterialShaderBindingContract => {
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (!lookup.ok) return resolveMaterialShaderBindingContract(undefined);
    return resolveMaterialShaderBindingContract({
      ...lookup.value.receipt,
      ...(lookup.value.program.forwardFog === undefined
        ? {}
        : { forwardFog: lookup.value.program.forwardFog }),
    });
  };
  type StorageLayout = { readonly pipelineLayout: PipelineLayout; readonly identity: string };
  const storageLayouts = new WeakMap<
    RendererPipelineCacheState,
    WeakMap<ShaderReflection, StorageLayout>
  >();
  const getOrBuildPreparedStoragePipelineLayout = (
    materialShaderId: string,
    variantSet?: string,
  ): StorageLayout | null => {
    const manifest = getShader().materialShaderManifestEntry(materialShaderId);
    const reflection =
      variantSet !== undefined && manifest !== undefined && manifest.variants.length > 0
        ? findVariantByKey(manifest, variantSet)?.reflection
        : manifest?.reflection;
    const reject = () => {
      reportError(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'compiled group(0) storage and depth reflection for prepared graphics',
          hint: `republish the exact shader reflection for ${materialShaderId}`,
        }),
      );
      return null;
    };
    if (reflection === undefined) return reject();
    const state = currentPipelineCacheState();
    let layouts = storageLayouts.get(state);
    const cached = layouts?.get(reflection);
    if (cached !== undefined) return cached;
    const captureStorageLayoutEntries = (
      reflection: ShaderReflection,
    ): BindGroupLayoutEntry[] | null => {
      const entries: BindGroupLayoutEntry[] = [];
      for (const global of reflection.boundGlobals) {
        const visibility =
          global.visibility & (GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT);
        if (visibility === 0) continue;
        if (global.group !== 0) return reject();
        const common = { binding: global.binding, visibility };
        if (
          global.resourceKind === 'storage-buffer' &&
          (global.resourceAccess === 'read-only' || global.resourceAccess === 'read-write')
        ) {
          entries.push({
            ...common,
            buffer: {
              type: global.resourceAccess === 'read-only' ? 'read-only-storage' : 'storage',
            },
          });
        } else if (
          global.resourceKind === 'texture' &&
          global.textureClass === 'sampled' &&
          global.sampleType === 'depth' &&
          global.viewDimension === '2d' &&
          typeof global.multisampled === 'boolean'
        ) {
          entries.push({
            ...common,
            texture: {
              sampleType: 'depth',
              viewDimension: '2d',
              multisampled: global.multisampled,
            },
          });
        } else return reject();
      }

      return entries;
    };
    const entries = captureStorageLayoutEntries(reflection);
    if (entries === null) return null;
    const group = currentBuildDevice().createBindGroupLayout({
      label: `prepared-storage-${materialShaderId}`,
      entries,
    });
    if (!group.ok) {
      reportError(group.error);
      return null;
    }
    const layout = currentBuildDevice().createPipelineLayout({
      label: `prepared-storage-${materialShaderId}`,
      bindGroupLayouts: [group.value],
    });
    if (!layout.ok) {
      reportError(layout.error);
      return null;
    }
    if (layouts === undefined) {
      layouts = new WeakMap();
      storageLayouts.set(state, layouts);
    }
    const result = {
      pipelineLayout: layout.value,
      identity: sha256(JSON.stringify(reflection.boundGlobals)),
    };
    layouts.set(reflection, result);
    return result;
  };
  const getOrBuildGroup0MaterialLayout = (): {
    materialBgl: BindGroupLayout;
    pipelineLayout: PipelineLayout;
  } | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.group0MaterialLayout !== null) return cacheState.group0MaterialLayout;
    if (currentPipelineState() === null) return null;
    const bglRes = currentBuildDevice().createBindGroupLayout({ entries: [] });
    if (!bglRes.ok) {
      reportError(bglRes.error);
      return null;
    }
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-group-0-pipeline-layout',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) {
      reportError(plRes.error);
      return null;
    }
    cacheState.group0MaterialLayout = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    return cacheState.group0MaterialLayout;
  };
  const getOrBuildViewOnlyMaterialPipelineLayout = (): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.viewOnlyMaterialPipelineLayout !== null) {
      return cacheState.viewOnlyMaterialPipelineLayout;
    }
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-view-only-pipeline-layout',
      bindGroupLayouts: [currentState.viewBindGroupLayout],
    });
    if (!plRes.ok) {
      reportError(plRes.error);
      return null;
    }
    cacheState.viewOnlyMaterialPipelineLayout = plRes.value;
    return cacheState.viewOnlyMaterialPipelineLayout;
  };
  const getOrBuildViewAndSceneDepthMaterialPipelineLayout = (): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    if (cacheState.viewAndSceneDepthMaterialPipelineLayout !== null) {
      return cacheState.viewAndSceneDepthMaterialPipelineLayout;
    }
    const bglRes = currentBuildDevice().createBindGroupLayout({
      label: 'material-view-scene-depth-bgl',
      entries: viewAndSceneDepthLayoutEntries(),
    });
    if (!bglRes.ok) {
      reportError(bglRes.error);
      return null;
    }
    const plRes = currentBuildDevice().createPipelineLayout({
      label: 'material-view-scene-depth-pipeline-layout',
      bindGroupLayouts: [bglRes.value],
    });
    if (!plRes.ok) {
      reportError(plRes.error);
      return null;
    }
    cacheState.viewAndSceneDepthMaterialPipelineLayout = plRes.value;
    return cacheState.viewAndSceneDepthMaterialPipelineLayout;
  };
  const getOrBuildGroup0ResourceLayout = (
    materialShaderId: string,
  ): { materialBgl: BindGroupLayout; pipelineLayout: PipelineLayout } | null => {
    const cacheState = currentPipelineCacheState();
    const cached = cacheState.group0ResourceLayouts.get(materialShaderId);
    if (cached !== undefined) return cached;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (!lookup.ok || lookup.value.receipt?.bindings !== 'group-0-resource') {
      return null;
    }
    const bgl = currentBuildDevice().createBindGroupLayout({
      label: `material-group-0-resource-${materialShaderId}`,
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
        },
      ],
    });
    if (!bgl.ok) return null;
    const pipelineLayout = currentBuildDevice().createPipelineLayout({
      label: `material-group-0-resource-pl-${materialShaderId}`,
      bindGroupLayouts: [bgl.value],
    });
    if (!pipelineLayout.ok) return null;
    const built = { materialBgl: bgl.value, pipelineLayout: pipelineLayout.value };
    cacheState.group0ResourceLayouts.set(materialShaderId, built);
    return built;
  };
  const preparedRequests = new WeakMap<
    RendererPipelineCacheState,
    MaterialPipelineRequestCache<PipelineLayout>
  >();
  const getOrBuildPreparedMaterialPipelineLayout = (
    materialShaderId: string,
    clustered = false,
    waterInfoFormat?: 'rgba16float' | 'rgba32float',
    selectedViewReads?: ReturnType<typeof viewEntryReads>,
  ): PipelineLayout | null => {
    const cacheState = currentPipelineCacheState();
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    let requests = preparedRequests.get(cacheState);
    if (requests === undefined) {
      requests = new MaterialPipelineRequestCache();
      preparedRequests.set(cacheState, requests);
    }
    const program = lookup.ok ? lookup.value.program : undefined;
    const source = program?.identity ?? '';
    const bindings = (lookup.ok ? lookup.value.receipt?.bindings : undefined) ?? 'render-material';
    let shaderLayouts = cacheState.preparedMaterialPipelineLayoutCache.get(materialShaderId);
    if (
      shaderLayouts === undefined ||
      shaderLayouts.source !== source ||
      shaderLayouts.bindings !== bindings ||
      shaderLayouts.waterInfoFormat !== waterInfoFormat
    ) {
      shaderLayouts = preparedMaterialLayoutFacts(source, bindings, waterInfoFormat);
      cacheState.preparedMaterialPipelineLayoutCache.set(materialShaderId, shaderLayouts);
    }
    const projectedView = selectPreparedViewLayout(
      currentBuildDevice(),
      currentState.viewBindGroupLayout,
      clustered && shaderLayouts.sceneInputKind === 'view',
      selectedViewReads,
      program?.entryPoints,
    );
    const facts = [
      materialShaderId,
      lookup.ok ? lookup.value : undefined,
      clustered,
      waterInfoFormat,
      currentState,
      currentBuildDevice(),
      projectedView,
    ];
    const prepared = requests.get(facts);
    if (prepared !== undefined) return prepared;
    const { sceneInputKind } = shaderLayouts;
    const cached = clustered ? shaderLayouts.clusterLayout : shaderLayouts.meshLayout;
    if (cached !== undefined && projectedView === undefined) {
      if (lookup.ok) requests.set(facts, cached);
      return cached;
    }
    const materialBgl =
      getOrBuildPerShaderMaterialLayout(materialShaderId)?.materialBgl ??
      currentState.materialBindGroupLayout;
    const buildSceneInputLayout = () => {
      if (projectedView !== undefined) return projectedView;
      let sceneInputLayout = currentState.viewBindGroupLayout;
      if (sceneInputKind !== 'view') {
        const standardDepth =
          sceneInputKind === 'view-depth' &&
          (bindings === 'render-lit-material-and-scene-depth' ||
            bindings === 'render-standard-material-and-scene-depth');
        const entries =
          sceneInputKind === 'post-process'
            ? MATERIAL_POST_PROCESS_SCENE_LAYOUT.entries
            : standardDepth
              ? [
                  ...preparedStandardViewDepthLayoutEntries(currentState, currentBuildDevice()),
                  ...(clustered
                    ? clusterViewLayoutEntries(currentBuildDevice().caps.storageBuffer)
                    : []),
                ]
              : sceneInputKind === 'view-depth'
                ? viewAndSceneDepthLayoutEntries()
                : [
                    {
                      binding: 0,
                      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
                      texture: {
                        sampleType: 'depth' as const,
                        viewDimension: '2d' as const,
                        multisampled: false,
                      },
                    },
                  ];
        const sceneInputLayoutResult = currentBuildDevice().createBindGroupLayout({
          label: `prepared-material-${sceneInputKind}-${materialShaderId}`,
          entries,
        });
        if (!sceneInputLayoutResult.ok) {
          reportError(sceneInputLayoutResult.error);
          return null;
        }
        sceneInputLayout = sceneInputLayoutResult.value;
        if (standardDepth) retainViewLayout(sceneInputLayout, entries);
      }
      return sceneInputLayout;
    };
    const buildPreparedPipelineLayout = () => {
      const sceneInputLayout = buildSceneInputLayout();
      if (sceneInputLayout === null) return null;
      const waterSystemInputs =
        lookup.ok && lookup.value.receipt?.systemInputs?.water === 'water-frame/3';
      const usesMaterialGroup = clustered || waterSystemInputs || shaderLayouts.usesMaterialGroup;
      const lightingLayout = waterSystemInputs
        ? currentBuildDevice().createBindGroupLayout({
            label: `prepared-water-frame-${materialShaderId}`,
            entries: waterMaterialFrameBindGroupLayoutEntries(
              waterInfoFormat,
              16,
              lookup.ok ? lookup.value.receipt?.entryPoints : undefined,
            ),
          })
        : undefined;
      if (lightingLayout !== undefined && !lightingLayout.ok) {
        reportError(lightingLayout.error);
        return null;
      }
      const result = currentBuildDevice().createPipelineLayout({
        label: `prepared-material-pl-${materialShaderId}`,
        bindGroupLayouts: [
          sceneInputLayout,
          ...(usesMaterialGroup ? [materialBgl] : []),
          ...(lightingLayout?.ok ? [lightingLayout.value] : []),
        ],
      });
      if (!result.ok) {
        reportError(result.error);
        return null;
      }
      if (clustered) {
        preparedPipelineViews.set(result.value, sceneInputLayout);
        if (projectedView === undefined) shaderLayouts.clusterLayout = result.value;
      } else shaderLayouts.meshLayout = result.value;
      if (lookup.ok) requests.set(facts, result.value);
      return result.value;
    };
    return buildPreparedPipelineLayout();
  };
  const getOrBuildPerShaderMaterialLayout = (
    materialShaderId: string,
    explicitParamSchema?: readonly ParamSchemaEntry[],
    layoutKind: LayoutKind = 'pbr',
    clustered = false,
  ): PerShaderMaterialLayoutCacheEntry['layout'] => {
    const cacheState = currentPipelineCacheState();
    const currentState = currentPipelineState();
    if (currentState === null) return null;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const artifact = lookup.ok ? lookup.value : undefined;
    const program = artifact?.program;
    const source = program?.identity ?? '';
    const standardMaterialContract =
      lookup.ok && lookup.value.receipt?.bindings === 'render-standard-material-and-scene-depth';
    const paramSchema = standardMaterialContract
      ? PARTICLE_MESH_SURFACE_PARAM_SCHEMA
      : lookup.ok
        ? lookup.value.paramSchema
        : explicitParamSchema;
    // An entry is retained only after the derivations below accepted this exact
    // (source, schema) pair, so a hit is the answer they would reproduce.
    const cacheKey = materialLayoutSlot(layoutKind, clustered);
    const cached = cacheState.perShaderMaterialLayoutCache.get(materialShaderId)?.get(cacheKey);
    if (sameMaterialLayoutPublication(cached, source, paramSchema)) return cached.layout;
    // Optional engine-owned resources extend the Standard layout and its texture budget.
    const inspectOptionalMaterialResources = () => {
      const customLit = materialUsesLitSceneInputs(getShader(), materialShaderId);
      const directMultiscatteringLut = !customLit && materialUsesDirectDfgLut(paramSchema);
      const planarReflection = !customLit && materialUsesPlanarReflection(paramSchema);
      const fluidSimulation =
        artifact?.receipt?.systemInputs?.water === 'water-frame/3' &&
        program?.materialBindings?.includes(derive(paramSchema ?? []).userRegionBindingEnd + 19) ===
          true;
      const hasOptionalResources = directMultiscatteringLut || planarReflection || fluidSimulation;
      return { directMultiscatteringLut, planarReflection, fluidSimulation, hasOptionalResources };
    };
    const { directMultiscatteringLut, planarReflection, fluidSimulation, hasOptionalResources } =
      inspectOptionalMaterialResources();
    if (isSharedLayoutMaterialShader(materialShaderId) && !clustered && !hasOptionalResources)
      return null;
    const singleLayerMedium = materialUsesSurfaceSceneInputs(getShader(), materialShaderId);
    if (paramSchema === undefined) return null;
    // A custom schema may reuse the shared PBR layout only when every derived
    // binding is an identical canonical prefix. Otherwise build its own layout
    // so texture dimensions and sampler/storage shapes cannot drift.
    const requiresStandardMapLayout =
      isStandardPbrMaterialShader(materialShaderId) ||
      standardPhysicalTextureFields(paramSchema).length > 0;
    const isStandardMapLayout = requiresStandardMapLayout;
    if (
      !materialUsesLitSceneInputs(getShader(), materialShaderId) &&
      !clustered &&
      !singleLayerMedium &&
      artifact?.receipt?.surface === undefined &&
      !isStandardMapLayout &&
      !hasOptionalResources &&
      isSharedMaterialUserRegionCompatible(paramSchema)
    ) {
      retainMaterialLayout(cacheState, materialShaderId, layoutKind, clustered, {
        source,
        paramSchema,
        layout: null,
      });
      return null;
    }
    const buildPerShaderMaterialLayout = () => {
      const spec: PipelineSpec = {
        shader: {
          id: materialShaderId,
          passKind: 'forward',
          variantSet: undefined,
        },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      };
      const baseDesc = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-material-merged',
        registry: getShader(),
        materialParamSchema: paramSchema,
        caps: {
          storageBuffer: currentBuildDevice().caps.storageBuffer,
          transmissionBackdrop: transmissionBackdropAvailable(
            currentBuildDevice().limits.maxSampledTexturesPerShaderStage,
          ),
        },
      });
      const surfaceStart = derive(paramSchema).userRegionBindingEnd;
      const desc: typeof baseDesc = {
        ...baseDesc,
        entries: [
          ...baseDesc.entries,
          ...(singleLayerMedium && program?.materialBindings?.includes(surfaceStart + 17) === true
            ? ([
                {
                  binding: surfaceStart + 16,
                  visibility: GPU_SHADER_STAGE_FRAGMENT,
                  sampler: { type: 'filtering' },
                },
                {
                  binding: surfaceStart + 17,
                  visibility: GPU_SHADER_STAGE_FRAGMENT,
                  texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                  binding: surfaceStart + 18,
                  visibility: GPU_SHADER_STAGE_FRAGMENT,
                  sampler: { type: 'filtering' },
                },
              ] satisfies GPUBindGroupLayoutEntry[])
            : []),
          ...(fluidSimulation
            ? ([
                {
                  binding: surfaceStart + 19,
                  visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
                  texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
                },
                {
                  binding: surfaceStart + 20,
                  visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
                  buffer: { type: 'read-only-storage' },
                },
              ] satisfies GPUBindGroupLayoutEntry[])
            : []),
        ],
      };
      const entries = projectSurfaceMaterialBindings(desc.entries, getShader(), materialShaderId);
      if (hasOptionalResources) {
        const fragmentTextures = (entries: Iterable<GPUBindGroupLayoutEntry>) =>
          Array.from(entries).filter(
            (entry) =>
              (entry.visibility & GPU_SHADER_STAGE_FRAGMENT) !== 0 &&
              (entry.texture !== undefined || entry.externalTexture !== undefined),
          ).length;
        const required =
          fragmentTextures(entries) +
          fragmentTextures(viewAndSceneDepthLayoutEntries()) +
          (clustered
            ? fragmentTextures(clusterViewLayoutEntries(currentBuildDevice().caps.storageBuffer))
            : 0);
        const limit = currentBuildDevice().limits.maxSampledTexturesPerShaderStage;
        if (limit !== undefined && required > limit)
          throw new MaterialSampledTextureBudgetExceededError({
            materialHandle: -1,
            limit,
            required,
            conflicts: optionalMaterialResourceConflicts(
              directMultiscatteringLut,
              planarReflection,
            ),
          });
      }
      const bglRes = currentBuildDevice().createBindGroupLayout({
        ...desc,
        entries,
      });
      if (!bglRes.ok) {
        reportError(bglRes.error);
        return null;
      }
      const bindGroups = resolveMaterialPipelineBindGroups(
        layoutKind,
        currentState,
        program?.probeBlendRecordRequired ?? false,
      );
      if (bindGroups === null) return null;
      let litView = currentState.viewBindGroupLayout;
      if (materialUsesLitSceneInputs(getShader(), materialShaderId)) {
        const entries = [
          ...preparedStandardViewDepthLayoutEntries(currentState, currentBuildDevice()),
          ...(clustered ? clusterViewLayoutEntries(currentBuildDevice().caps.storageBuffer) : []),
        ];
        litView = currentBuildDevice()
          .createBindGroupLayout({ label: `lit-view-depth-${materialShaderId}`, entries })
          .unwrap();
        retainViewLayout(litView, entries);
      }
      const plRes = currentBuildDevice().createPipelineLayout({
        label: `pbr-pl-${materialShaderId}`,
        bindGroupLayouts: [
          litView,
          bglRes.value,
          bindGroups.meshLayout,
          bindGroups.instancesLayout,
        ],
      });
      if (!plRes.ok) {
        reportError(plRes.error);
        return null;
      }
      if (entries.length !== desc.entries.length)
        retainProjectedMaterialSlots(bglRes.value, entries);
      const built = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
      retainMaterialLayout(cacheState, materialShaderId, layoutKind, clustered, {
        source,
        paramSchema,
        layout: built,
      });
      return built;
    };
    return buildPerShaderMaterialLayout();
  };
  const getParamSchema = (materialShaderId: string) => {
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    if (lookup.ok && lookup.value.receipt?.bindings === 'render-standard-material-and-scene-depth')
      return PARTICLE_MESH_SURFACE_PARAM_SCHEMA;
    return lookup.ok ? lookup.value.paramSchema : undefined;
  };
  // feat-20260621-learn-render-5-5-parallax M2 / w6 (D-1): expose the per-shader
  // material BGL so the record stage creates the material bind group against
  // the matching paramSchema-derived layout. Returns undefined only for
  // group-0 / view-only contracts or an unavailable shader layout; built-in
  // material IDs continue to resolve through the shared layout path.
  const getMaterialBindGroupLayout = (
    materialShaderId: string,
    materialParamSchema?: readonly ParamSchemaEntry[],
  ): BindGroupLayout | undefined => {
    if (isSharedLayoutMaterialShader(materialShaderId)) return undefined;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const contract = lookup.ok
      ? (lookup.value.receipt?.bindings ?? 'render-material')
      : 'render-material';
    if (contract === 'group-0') {
      return getOrBuildGroup0MaterialLayout()?.materialBgl;
    }
    if (contract === 'group-0-resource') {
      return getOrBuildGroup0ResourceLayout(materialShaderId)?.materialBgl;
    }
    if (contract === 'view-and-scene-depth') return undefined;
    return (
      getOrBuildPerShaderMaterialLayout(materialShaderId, materialParamSchema)?.materialBgl ??
      undefined
    );
  };
  const lookupMaterialBindGroupLayout = (
    materialShaderId: string,
    explicitParamSchema?: readonly ParamSchemaEntry[],
  ): BindGroupLayout | undefined => {
    if (isSharedLayoutMaterialShader(materialShaderId)) return undefined;
    const lookup = getShader().findMaterialArtifact(materialShaderId);
    const artifact = lookup.ok ? lookup.value : undefined;
    const state = currentPipelineCacheState();
    switch (artifact?.receipt?.bindings) {
      case 'group-0':
        return state.group0MaterialLayout?.materialBgl;
      case 'group-0-resource':
        return state.group0ResourceLayouts.get(materialShaderId)?.materialBgl;
      case 'view-and-scene-depth':
        return undefined;
      default: {
        const cached = state.perShaderMaterialLayoutCache
          .get(materialShaderId)
          ?.get(materialLayoutSlot('pbr', false));
        return sameMaterialLayoutPublication(
          cached,
          artifact?.program?.identity ?? '',
          artifact?.paramSchema ?? explicitParamSchema,
        )
          ? (cached.layout?.materialBgl ?? undefined)
          : undefined;
      }
    }
  };
  return {
    getMaterialShaderBindingContract,
    getOrBuildPreparedStoragePipelineLayout,
    getOrBuildGroup0MaterialLayout,
    getOrBuildViewOnlyMaterialPipelineLayout,
    getOrBuildViewAndSceneDepthMaterialPipelineLayout,
    getOrBuildGroup0ResourceLayout,
    getOrBuildPreparedMaterialPipelineLayout,
    getOrBuildPerShaderMaterialLayout,
    getParamSchema,
    getMaterialBindGroupLayout,
    lookupMaterialBindGroupLayout,
  };
}

function sameMaterialLayoutPublication(
  cached: PerShaderMaterialLayoutCacheEntry | undefined,
  source: string,
  paramSchema: readonly ParamSchemaEntry[] | undefined,
): cached is PerShaderMaterialLayoutCacheEntry {
  return (
    paramSchema !== undefined && cached?.source === source && cached.paramSchema === paramSchema
  );
}

// Exhaustive codes encode the closed layout union; these are cache keys only.
const MATERIAL_LAYOUT_CODES: Readonly<Record<LayoutKind, number>> = {
  pbr: 0,
  'pbr-skin': 1,
  'gpu-driven-pbr': 2,
  'gpu-driven-skin': 3,
  'gpu-driven-cluster-pbr': 4,
  'gpu-driven-cluster-skin': 5,
  'surface-direct-pbr': 6,
  'surface-direct-cluster-pbr': 7,
  'hdrp-pbr': 8,
  'hdrp-skin': 9,
  'sprite-urp': 10,
  'unlit-urp': 11,
  'scene-direct-unlit': 12,
  'scene-direct-cluster-unlit': 13,
};

function materialLayoutSlot(kind: LayoutKind, clustered: boolean): number | string {
  const code = typeof kind === 'string' ? MATERIAL_LAYOUT_CODES[kind] : undefined;
  return typeof code === 'number' && typeof clustered === 'boolean'
    ? code * 2 + (clustered ? 1 : 0)
    : `${kind}:${clustered}`;
}

/** Only a rejected texture budget needs a list of the optional resource names. */
function optionalMaterialResourceConflicts(directDfg: boolean, planar: boolean): string[] {
  const resources: string[] = [];
  if (directDfg) resources.push('directMultiscatteringLut');
  if (planar) resources.push('planarReflection');
  return resources;
}

/** Inline the common single contract; allocate a hash table only for actual fanout. */
function retainMaterialLayout(
  state: RendererPipelineCacheState,
  shaderId: string,
  kind: LayoutKind,
  clustered: boolean,
  entry: PerShaderMaterialLayoutCacheEntry,
): void {
  let shaderLayouts = state.perShaderMaterialLayoutCache.get(shaderId);
  if (shaderLayouts === undefined) {
    shaderLayouts = new FirstEntryMap();
    state.perShaderMaterialLayoutCache.set(shaderId, shaderLayouts);
  }
  shaderLayouts.set(materialLayoutSlot(kind, clustered), entry);
}

function preparedMaterialLayoutFacts(
  source: string,
  bindings: MaterialProgramBindingContract,
  waterInfoFormat?: 'rgba16float' | 'rgba32float',
): PreparedMaterialPipelineLayoutCacheEntry {
  return {
    source,
    bindings,
    ...(waterInfoFormat === undefined ? {} : { waterInfoFormat }),
    sceneInputKind:
      bindings === 'post-process'
        ? 'post-process'
        : bindings === 'render-material-and-scene-depth' ||
            bindings === 'render-lit-material-and-scene-depth' ||
            bindings === 'render-standard-material-and-scene-depth'
          ? 'view-depth'
          : bindings === 'render-material-with-scene-depth'
            ? 'depth'
            : 'view',
    usesMaterialGroup:
      bindings === 'render-material' ||
      bindings === 'post-process' ||
      bindings === 'render-material-with-scene-depth' ||
      bindings === 'render-material-and-scene-depth' ||
      bindings === 'render-lit-material-and-scene-depth' ||
      bindings === 'render-standard-material-and-scene-depth',
    meshLayout: undefined,
    clusterLayout: undefined,
  };
}

/** Prepared features use the exact program requested by the raster pipeline. */
function selectPreparedViewLayout(
  device: RhiDevice,
  base: BindGroupLayout,
  projectsLighting: boolean,
  selectedReads: ReturnType<typeof viewEntryReads>,
  sourceEntries: Parameters<typeof viewEntryReads>[0],
): BindGroupLayout | undefined {
  if (!projectsLighting) return undefined;
  const reads = selectedReads ?? viewEntryReads(sourceEntries, undefined, 'fs_main');
  return reads === undefined ? undefined : projectViewLayout(device, base, reads);
}

/** A prepared Standard material draw needs the complete shared View ABI plus scene depth. */
function preparedStandardViewDepthLayoutEntries(
  state: PipelineState,
  device: RhiDevice,
): GPUBindGroupLayoutEntry[] {
  return [
    ...buildPbrViewBglEntries({
      storageBuffer: device.caps.storageBuffer,
      extendedLighting: state.extendedLightingAvailable ?? true,
      atmosphere: state.atmosphereAvailable === true,
      projectorAvailable: state.projectorAvailable !== false,
      transmissionBackdrop: transmissionBackdropAvailable(
        device.limits.maxSampledTexturesPerShaderStage,
      ),
    }),
    {
      binding: 1,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
    },
  ];
}
