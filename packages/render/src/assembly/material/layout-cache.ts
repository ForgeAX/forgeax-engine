import type { BindGroupLayout, PipelineLayout, RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { type ShaderCatalog, standardPhysicalTextureFields } from '@forgeax/engine-shader';
import type { MaterialProgramBindingContract, ParamSchemaEntry } from '@forgeax/engine-types';
import { materialUsesDirectDfgLut } from '../../device/direct-dfg-lut';
import { MaterialSampledTextureBudgetExceededError } from '../../errors/render';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../../gpu-stage';
import {
  createHdrpBindGroupLayoutDescriptor,
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrMaterialShader,
} from '../../pbr-pipeline';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from '../../pipeline-spec';
import { FirstEntryMap } from '../../record/first-entry-map';
import type { PipelineState } from '../../record/render-context';
import { transmissionBackdropAvailable } from '../device-feature-admission';
import { isSharedMaterialUserRegionCompatible, type LayoutKind } from '../material-shader-policy';
import type {
  PerShaderMaterialLayoutCacheEntry,
  PreparedMaterialPipelineLayoutCacheEntry,
  RendererPipelineCacheState,
} from '../recovery/renderer-recover';
import { isEngineOwnedMaterialShader, resolveMaterialPipelineBindGroups } from './pipeline-helpers';
import { MaterialPipelineRequestCache } from './pipeline-request-cache';

/** Material layouts use the active or candidate generation's existing cache. */
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
  const preparedRequests = new WeakMap<
    RendererPipelineCacheState,
    MaterialPipelineRequestCache<PipelineLayout>
  >();
  const getOrBuildPreparedMaterialPipelineLayout = (
    materialShaderId: string,
    clustered = false,
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
    const facts = [
      materialShaderId,
      lookup.ok ? lookup.value : undefined,
      clustered,
      currentState,
      currentBuildDevice(),
    ];
    const prepared = requests.get(facts);
    if (prepared !== undefined) return prepared;
    const source = lookup.ok ? lookup.value.source : '';
    const bindings = (lookup.ok ? lookup.value.receipt?.bindings : undefined) ?? 'render-material';
    let shaderLayouts = cacheState.preparedMaterialPipelineLayoutCache.get(materialShaderId);
    if (
      shaderLayouts === undefined ||
      shaderLayouts.source !== source ||
      shaderLayouts.bindings !== bindings ||
      typeof source !== 'string'
    ) {
      shaderLayouts = preparedMaterialLayoutFacts(source, bindings);
      cacheState.preparedMaterialPipelineLayoutCache.set(materialShaderId, shaderLayouts);
    }
    const { sceneInputKind } = shaderLayouts;
    const cached = clustered ? shaderLayouts.clusterLayout : shaderLayouts.meshLayout;
    if (cached !== undefined) {
      if (lookup.ok) requests.set(facts, cached);
      return cached;
    }
    const materialBgl =
      getOrBuildPerShaderMaterialLayout(materialShaderId)?.materialBgl ??
      currentState.materialBindGroupLayout;
    let sceneInputLayout: BindGroupLayout = currentState.viewBindGroupLayout;
    if (sceneInputKind !== 'view') {
      const sceneInputLayoutResult = currentBuildDevice().createBindGroupLayout({
        label: `prepared-material-${sceneInputKind}-${materialShaderId}`,
        entries:
          sceneInputKind === 'view-depth'
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
              ],
      });
      if (!sceneInputLayoutResult.ok) {
        reportError(sceneInputLayoutResult.error);
        return null;
      }
      sceneInputLayout = sceneInputLayoutResult.value;
    }
    const usesMaterialGroup = clustered || shaderLayouts.usesMaterialGroup;
    const lightingLayout = clustered
      ? currentBuildDevice().createBindGroupLayout({
          label: `prepared-material-lighting-${materialShaderId}`,
          entries: createHdrpBindGroupLayoutDescriptor().entries.filter(
            (entry) => entry.binding >= 3,
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
    if (clustered) shaderLayouts.clusterLayout = result.value;
    else shaderLayouts.meshLayout = result.value;
    if (lookup.ok) requests.set(facts, result.value);
    return result.value;
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
    const source = lookup.ok ? lookup.value.source : '';
    const paramSchema = lookup.ok ? lookup.value.paramSchema : explicitParamSchema;
    if (
      isEngineOwnedMaterialShader(materialShaderId) &&
      !clustered &&
      !materialUsesDirectDfgLut(paramSchema)
    )
      return null;
    const singleLayerMedium =
      materialShaderId === 'forgeax::single-layer-medium' ||
      (lookup.ok && lookup.value.receipt?.surface?.model === 'single-layer-medium');
    if (paramSchema === undefined) return null;
    const cacheKey = materialLayoutSlot(layoutKind, clustered);
    const cached = cacheState.perShaderMaterialLayoutCache.get(materialShaderId)?.get(cacheKey);
    if (cached?.source === source && cached.paramSchema === paramSchema) {
      return cached.layout;
    }
    // A custom schema may reuse the shared PBR layout only when every derived
    // binding is an identical canonical prefix. Otherwise build its own layout
    // so texture dimensions and sampler/storage shapes cannot drift.
    const requiresStandardMapLayout =
      isCanonicalStandardPbrMaterialShader(materialShaderId) ||
      isStandardPbrMaterialShader(materialShaderId) ||
      standardPhysicalTextureFields(paramSchema).length > 0;
    const isStandardMapLayout = requiresStandardMapLayout;
    if (
      !clustered &&
      !singleLayerMedium &&
      !isStandardMapLayout &&
      !materialUsesDirectDfgLut(paramSchema) &&
      isSharedMaterialUserRegionCompatible(paramSchema)
    ) {
      retainMaterialLayout(cacheState, materialShaderId, layoutKind, clustered, {
        source,
        paramSchema,
        layout: null,
      });
      return null;
    }
    const spec: PipelineSpec = {
      shader: {
        id: singleLayerMedium ? 'forgeax::single-layer-medium' : materialShaderId,
        passKind: 'forward',
        variantSet: undefined,
      },
      attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
      geometry: { topology: 'triangle-list', vertexLayout: {} },
      renderState: undefined,
    };
    const desc = buildBindGroupLayoutDescriptor(spec, {
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
    if (materialUsesDirectDfgLut(paramSchema)) {
      const fragmentTextures = (entries: Iterable<GPUBindGroupLayoutEntry>) =>
        Array.from(entries).filter(
          (entry) =>
            (entry.visibility & GPU_SHADER_STAGE_FRAGMENT) !== 0 &&
            (entry.texture !== undefined || entry.externalTexture !== undefined),
        ).length;
      const required =
        fragmentTextures(desc.entries) +
        fragmentTextures(viewAndSceneDepthLayoutEntries()) +
        (clustered
          ? fragmentTextures(
              createHdrpBindGroupLayoutDescriptor(currentBuildDevice().caps.storageBuffer).entries,
            )
          : 0);
      const limit = currentBuildDevice().limits.maxSampledTexturesPerShaderStage;
      if (limit !== undefined && required > limit)
        throw new MaterialSampledTextureBudgetExceededError({
          materialHandle: -1,
          limit,
          required,
          conflicts: ['directMultiscatteringLut'],
        });
    }
    const bglRes = currentBuildDevice().createBindGroupLayout(desc);
    if (!bglRes.ok) {
      reportError(bglRes.error);
      return null;
    }
    const bindGroups = resolveMaterialPipelineBindGroups(
      layoutKind,
      currentState,
      clustered,
      getShader().materialProgram(source).probeBlendRecordRequired,
    );
    if (bindGroups === null) return null;
    const plRes = currentBuildDevice().createPipelineLayout({
      label: `pbr-pl-${materialShaderId}`,
      bindGroupLayouts: [
        currentState.viewBindGroupLayout,
        bglRes.value,
        bindGroups.meshLayout,
        bindGroups.instancesLayout,
      ],
    });
    if (!plRes.ok) {
      reportError(plRes.error);
      return null;
    }
    const built = { materialBgl: bglRes.value, pipelineLayout: plRes.value };
    retainMaterialLayout(cacheState, materialShaderId, layoutKind, clustered, {
      source,
      paramSchema,
      layout: built,
    });
    return built;
  };
  return { getOrBuildPreparedMaterialPipelineLayout, getOrBuildPerShaderMaterialLayout };
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
};

function materialLayoutSlot(kind: LayoutKind, clustered: boolean): number | string {
  const code = typeof kind === 'string' ? MATERIAL_LAYOUT_CODES[kind] : undefined;
  return typeof code === 'number' && typeof clustered === 'boolean'
    ? code * 2 + (clustered ? 1 : 0)
    : `${kind}:${clustered}`;
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
): PreparedMaterialPipelineLayoutCacheEntry {
  return {
    source,
    bindings,
    sceneInputKind:
      bindings === 'render-material-and-scene-depth'
        ? 'view-depth'
        : bindings === 'render-material-with-scene-depth'
          ? 'depth'
          : 'view',
    usesMaterialGroup:
      bindings === 'render-material' ||
      bindings === 'render-material-with-scene-depth' ||
      bindings === 'render-material-and-scene-depth',
    meshLayout: undefined,
    clusterLayout: undefined,
  };
}
