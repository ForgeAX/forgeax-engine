import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import { vertexLayoutHasColor } from '@forgeax/engine-geometry';
import type { BindGroupLayout, RhiDevice } from '@forgeax/engine-rhi';
import type {
  MaterialShaderArtifact,
  PipelineGroup2Contract,
  ShaderCatalog,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import type { PassKind } from '@forgeax/engine-types';
import { directionalPcssCapable } from '../../environment/capability';
import { type GpuDrivenPbrPrograms, resolveStandardPbrProgram } from '../../gpu-driven/pbr-program';
import { isCanonicalStandardPbrMaterialShader, SHADOW_CASTER_SHADER_ID } from '../../pbr-pipeline';
import { deriveExtendedLightingCapability } from '../../prepare/extended-lighting/resources';
import { type LayoutKind, selectNoColorPbrVariant } from '../material-shader-policy';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from '../shader-prewarm-policy';
import { type MaterialShaderArtifactRequest, resolveMaterialShaderArtifact } from './assembly';

type MaterialArtifactRegistry = Pick<
  ShaderRegistry,
  'findMaterialArtifact' | 'materialProgram' | 'materialShaderManifestEntry'
> &
  Partial<
    Pick<ShaderRegistry, 'isSourceBackedMaterialArtifact' | 'materialVariantArtifactIdentifier'>
  >;

export function resolveRendererMaterialShaderArtifact(
  materialShaderId: string,
  shader: MaterialArtifactRegistry,
  programs: GpuDrivenPbrPrograms | undefined,
  options: MaterialShaderArtifactRequest | boolean = {},
  prepare?: (identifier: string) => boolean,
): MaterialShaderArtifact | undefined {
  if (typeof options === 'boolean') {
    return resolveStandardPbrProgram(programs, materialShaderId, options)?.artifact;
  }
  const resolved = resolveMaterialShaderArtifact(materialShaderId, shader, options, prepare);
  if (resolved !== undefined) return resolved;
  // Legacy callers without geometry facts may reuse a prewarmed Standard
  // program; geometry-specific requests remain fail-closed.
  return Object.keys(options).length === 0
    ? resolveStandardPbrProgram(programs, materialShaderId, false)?.artifact
    : undefined;
}

/** One cooked-program selection for pipeline receipts and stage constants. */
export function materialPipelineArtifactRequest(
  variantSet: string | undefined,
  passKind: PassKind,
  vertexLayoutProjection: VertexLayoutProjection | undefined,
  layoutKind: LayoutKind | undefined,
): MaterialShaderArtifactRequest {
  const sceneIndexAddress =
    layoutKind === 'gpu-driven-pbr' ||
    layoutKind === 'gpu-driven-skin' ||
    layoutKind === 'gpu-driven-cluster-pbr' ||
    layoutKind === 'gpu-driven-cluster-skin';
  const options: {
    -readonly [K in keyof MaterialShaderArtifactRequest]: MaterialShaderArtifactRequest[K];
  } = {
    address: sceneIndexAddress ? 'scene-index' : 'direct',
    pass: passKind === 'shadow-caster' ? 'shadow' : 'forward',
  };
  if (vertexLayoutProjection !== undefined)
    options.vertexColorAvailable = vertexLayoutHasColor(vertexLayoutProjection);
  if (
    layoutKind === 'pbr-skin' ||
    layoutKind === 'gpu-driven-skin' ||
    layoutKind === 'gpu-driven-cluster-skin'
  )
    options.deformation = 'skin';
  if (variantSet !== undefined) options.variantSet = variantSet;
  return options;
}

export function resolveMaterialPipelineShaderId(
  materialShaderId: string,
  passKind: string,
): string {
  return passKind === 'shadow-caster' && isCanonicalStandardPbrMaterialShader(materialShaderId)
    ? SHADOW_CASTER_SHADER_ID
    : materialShaderId;
}

export function resolveMaterialPipelineVertexEntry(
  layoutKind: LayoutKind | undefined,
  vertexEntryPoint: string | undefined,
  authoredVertexEntry: string | undefined,
  tangentFrame32 = false,
): string | undefined {
  const sceneIndex =
    layoutKind === 'gpu-driven-pbr' ||
    layoutKind === 'gpu-driven-skin' ||
    layoutKind === 'gpu-driven-cluster-pbr' ||
    layoutKind === 'gpu-driven-cluster-skin';
  // Scene-index is a renderer submission ABI. An authored/direct entry may
  // accompany the artifact for diagnostics, but it must not replace the
  // receipt entry when the GPU-driven layout is selected.
  const entry = sceneIndex
    ? (vertexEntryPoint ?? authoredVertexEntry)
    : (authoredVertexEntry ?? vertexEntryPoint);
  // An omitted entry belongs to the pipeline builder's pass-specific default
  // (for example vs_temporal), including its packed-layout adaptation.
  return tangentFrame32 && entry !== undefined && !entry.endsWith('_packed')
    ? `${entry}_packed`
    : entry;
}

export function hasPackedTangentFrame(projection: VertexLayoutProjection | undefined): boolean {
  return ((projection?.mask ?? 0) & (1 << 14)) !== 0;
}

/** The cache key preserves authored priority for ordinary layouts. */
export function materialPipelineKeyVertexEntry(
  layoutKind: LayoutKind | undefined,
  vertexEntryPoint: string | undefined,
  authoredVertexEntry: string | undefined,
  projection: VertexLayoutProjection | undefined,
): string | undefined {
  return hasPackedTangentFrame(projection)
    ? resolveMaterialPipelineVertexEntry(layoutKind, vertexEntryPoint, authoredVertexEntry, true)
    : (authoredVertexEntry ?? vertexEntryPoint);
}

/** Keep the recorded group(2) receipt identical to the selected pipeline layout. */
export function resolveMaterialPipelineGroup2Contract(
  declared: PipelineGroup2Contract,
  layoutKind: LayoutKind | undefined,
): PipelineGroup2Contract {
  switch (layoutKind) {
    case 'hdrp-pbr':
    case 'gpu-driven-cluster-pbr':
    case 'surface-direct-cluster-pbr':
    case 'scene-direct-cluster-unlit':
      return 'cluster';
    case 'hdrp-skin':
    case 'gpu-driven-cluster-skin':
      return 'skin-cluster';
    case 'pbr-skin':
    case 'gpu-driven-skin':
      return 'skin';
    case 'pbr':
    case 'gpu-driven-pbr':
    case 'surface-direct-pbr':
    case 'sprite-urp':
    case 'unlit-urp':
    case 'scene-direct-unlit':
      return 'mesh';
    case undefined:
      return declared;
  }
}

export function resolveCompiledMaterialGroup2Contract(
  declared: PipelineGroup2Contract,
  layoutKind: LayoutKind | undefined,
  materialShaderId: string | undefined,
  variantSet: string | undefined,
): PipelineGroup2Contract {
  const contract = resolveMaterialPipelineGroup2Contract(declared, layoutKind);
  return contract === 'mesh' &&
    (materialShaderId === 'forgeax::vfx-render.particles.mesh' ||
      materialShaderId === 'forgeax::vfx-render.particles.mesh-inputs') &&
    (variantSet === '' || variantSet?.includes('CLUSTER_FORWARD_AVAILABLE=true') === true)
    ? 'cluster'
    : contract;
}

interface MaterialPipelineBindGroupState {
  readonly meshBindGroupLayout: BindGroupLayout;
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly hdrpSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly hdrpMeshBindGroupLayout?: BindGroupLayout | null;
  readonly instancesBindGroupLayout: BindGroupLayout;
  readonly probeInstancesBindGroupLayout?: BindGroupLayout;
  readonly gpuDrivenPrimitiveBindGroupLayout?: BindGroupLayout | null;
  readonly gpuDrivenSkinPrimitiveBindGroupLayout?: BindGroupLayout | null;
  readonly gpuDrivenInstancesBindGroupLayout?: BindGroupLayout | null;
  readonly surfaceDirectInstancesBindGroupLayout?: BindGroupLayout | null;
  readonly sceneDirectInstancesBindGroupLayout?: BindGroupLayout | null;
}

/** Slot-3 layout: direct Surface rows, GPU Scene rows, scene-index tables or packed instances. */
function materialPipelineInstancesLayout(
  layoutKind: LayoutKind,
  state: MaterialPipelineBindGroupState,
  probeBlend: boolean,
): BindGroupLayout | null | undefined {
  if (layoutKind === 'surface-direct-pbr' || layoutKind === 'surface-direct-cluster-pbr')
    return state.surfaceDirectInstancesBindGroupLayout;
  if (layoutKind === 'scene-direct-unlit' || layoutKind === 'scene-direct-cluster-unlit')
    return state.sceneDirectInstancesBindGroupLayout;
  if (
    layoutKind === 'gpu-driven-pbr' ||
    layoutKind === 'gpu-driven-skin' ||
    layoutKind === 'gpu-driven-cluster-pbr' ||
    layoutKind === 'gpu-driven-cluster-skin'
  )
    return state.gpuDrivenInstancesBindGroupLayout;
  return probeBlend ? state.probeInstancesBindGroupLayout : state.instancesBindGroupLayout;
}

export function resolveMaterialPipelineBindGroups(
  layoutKind: LayoutKind,
  state: MaterialPipelineBindGroupState,
  probeBlend = false,
): { readonly meshLayout: BindGroupLayout; readonly instancesLayout: BindGroupLayout } | null {
  const meshLayout =
    layoutKind === 'gpu-driven-pbr' || layoutKind === 'gpu-driven-cluster-pbr'
      ? state.gpuDrivenPrimitiveBindGroupLayout
      : layoutKind === 'gpu-driven-skin' || layoutKind === 'gpu-driven-cluster-skin'
        ? state.gpuDrivenSkinPrimitiveBindGroupLayout
        : layoutKind === 'surface-direct-cluster-pbr' || layoutKind === 'scene-direct-cluster-unlit'
          ? state.hdrpMeshBindGroupLayout
          : layoutKind === 'hdrp-pbr'
            ? state.hdrpMeshBindGroupLayout
            : layoutKind === 'hdrp-skin'
              ? state.hdrpSkinMeshBindGroupLayout
              : layoutKind === 'pbr-skin'
                ? state.pbrSkinMeshBindGroupLayout
                : state.meshBindGroupLayout;
  if (meshLayout == null) return null;
  const instancesLayout = materialPipelineInstancesLayout(layoutKind, state, probeBlend);
  return instancesLayout === null || instancesLayout === undefined
    ? null
    : { meshLayout, instancesLayout };
}

export function isEngineOwnedMaterialShader(materialShaderId: string): boolean {
  return (
    materialShaderId === 'forgeax::default-unlit' ||
    materialShaderId === SHADOW_CASTER_SHADER_ID ||
    materialShaderId === 'forgeax::sprite' ||
    materialShaderId === 'forgeax::sprite-lit' ||
    materialShaderId === 'forgeax::default-sprite' ||
    materialShaderId === 'forgeax::msdf-text' ||
    isCanonicalStandardPbrMaterialShader(materialShaderId)
  );
}

/** Unlit's independent alpha map uses its schema's compact resource layout. */
export function isSharedLayoutMaterialShader(materialShaderId: string): boolean {
  return (
    isEngineOwnedMaterialShader(materialShaderId) && materialShaderId !== 'forgeax::default-unlit'
  );
}

/**
 * bug-20260527-renderstate-pipeline-dispatch-gap D-3:
 * finds the engine-shipped PBR manifest entry from the shader registry
 * by content marker (f_schlick BRDF helper call, same marker
 * buildReadyWebGPU uses). Returns undefined when the manifest is
 * empty (Camera-only path) or the pbr entry is not found.
 */
export function findStandardPbrEntry(
  shader: ShaderCatalog,
  device: RhiDevice,
  variantSet?: string,
): import('@forgeax/engine-types').ManifestEntry | undefined {
  let standardEntry: import('@forgeax/engine-types').ManifestEntry | undefined;
  for (const entry of shader.entries()) {
    if (entry.wgsl.includes('f_schlick')) {
      standardEntry = entry;
      break;
    }
  }
  if (standardEntry === undefined) return undefined;
  const pbrManifestEntry = [...shader.materialShaderManifestEntries()].find(
    (entry) => entry.identifier === 'forgeax::default-standard-pbr',
  );
  const noColorVariant = selectNoColorPbrVariant(
    pbrManifestEntry,
    device.caps.storageBuffer,
    variantSet,
    deriveExtendedLightingCapability(device).admitted,
    directionalPcssCapable(device.caps.backendKind),
    (device.limits.maxSampledTexturesPerShaderStage ?? 0) >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  );
  if (noColorVariant !== undefined && noColorVariant.composedWgsl !== standardEntry.wgsl) {
    return { ...standardEntry, wgsl: noColorVariant.composedWgsl };
  }
  const runtimePbr = shader.findMaterialArtifact('forgeax::default-standard-pbr');
  if (runtimePbr.ok && runtimePbr.value.source !== standardEntry.wgsl) {
    return { ...standardEntry, wgsl: runtimePbr.value.source };
  }
  return standardEntry;
}
