import type { BindGroupLayout, RhiDevice } from '@forgeax/engine-rhi';
import type {
  MaterialShaderArtifact,
  PipelineGroup2Contract,
  ShaderCatalog,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { type GpuDrivenPbrProgram, resolveStandardPbrProgram } from '../../gpu-driven/pbr-program';
import { isCanonicalStandardPbrMaterialShader, SHADOW_CASTER_SHADER_ID } from '../../pbr-pipeline';
import { deriveExtendedLightingCapability } from '../../prepare/extended-lighting/resources';
import { type LayoutKind, selectNoColorPbrVariant } from '../material-shader-policy';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from '../shader-prewarm-policy';
import { type MaterialShaderArtifactRequest, resolveMaterialShaderArtifact } from './assembly';

type MaterialArtifactRegistry = Pick<
  ShaderRegistry,
  'findMaterialArtifact' | 'materialProgram' | 'materialShaderManifestEntry'
>;

export function resolveRendererMaterialShaderArtifact(
  materialShaderId: string,
  shader: MaterialArtifactRegistry,
  programs: ReadonlyMap<string, GpuDrivenPbrProgram> | undefined,
  options: MaterialShaderArtifactRequest | boolean = {},
): MaterialShaderArtifact | undefined {
  if (typeof options === 'boolean') {
    return resolveStandardPbrProgram(programs, materialShaderId, options)?.artifact;
  }
  const resolved = resolveMaterialShaderArtifact(materialShaderId, shader, options);
  if (resolved !== undefined) return resolved;
  // Legacy callers without geometry facts may reuse a prewarmed Standard
  // program; geometry-specific requests remain fail-closed.
  return Object.keys(options).length === 0
    ? resolveStandardPbrProgram(programs, materialShaderId, false)?.artifact
    : undefined;
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
): string | undefined {
  const sceneIndex =
    layoutKind === 'gpu-driven-pbr' ||
    layoutKind === 'gpu-driven-skin' ||
    layoutKind === 'gpu-driven-cluster-pbr' ||
    layoutKind === 'gpu-driven-cluster-skin';
  // Scene-index is a renderer submission ABI. An authored/direct entry may
  // accompany the artifact for diagnostics, but it must not replace the
  // receipt entry when the GPU-driven layout is selected.
  return sceneIndex
    ? (vertexEntryPoint ?? authoredVertexEntry)
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
      return 'mesh';
    case undefined:
      return declared;
  }
}

interface MaterialPipelineBindGroupState {
  readonly meshBindGroupLayout: BindGroupLayout;
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly hdrpSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly hdrpMeshBindGroupLayout?: BindGroupLayout | null;
  readonly instancesBindGroupLayout: BindGroupLayout;
  readonly probeInstancesBindGroupLayout?: BindGroupLayout;
  readonly gpuDrivenInstancesBindGroupLayout?: BindGroupLayout | null;
  readonly surfaceDirectInstancesBindGroupLayout?: BindGroupLayout | null;
  readonly gpuDrivenClusterMeshBindGroupLayout?: BindGroupLayout | null;
}

export function resolveMaterialPipelineBindGroups(
  layoutKind: LayoutKind,
  state: MaterialPipelineBindGroupState,
  clustered = false,
  probeBlend = false,
): { readonly meshLayout: BindGroupLayout; readonly instancesLayout: BindGroupLayout } | null {
  const meshLayout =
    layoutKind === 'gpu-driven-cluster-pbr' || layoutKind === 'surface-direct-cluster-pbr'
      ? state.gpuDrivenClusterMeshBindGroupLayout
      : layoutKind === 'hdrp-pbr' || (clustered && layoutKind === 'gpu-driven-pbr')
        ? state.hdrpMeshBindGroupLayout
        : clustered && layoutKind === 'gpu-driven-skin'
          ? state.hdrpSkinMeshBindGroupLayout
          : layoutKind === 'gpu-driven-cluster-skin' || layoutKind === 'hdrp-skin'
            ? state.hdrpSkinMeshBindGroupLayout
            : layoutKind === 'pbr-skin' || layoutKind === 'gpu-driven-skin'
              ? state.pbrSkinMeshBindGroupLayout
              : state.meshBindGroupLayout;
  if (meshLayout == null) return null;
  const instancesLayout =
    layoutKind === 'surface-direct-pbr' || layoutKind === 'surface-direct-cluster-pbr'
      ? state.surfaceDirectInstancesBindGroupLayout
      : layoutKind === 'gpu-driven-pbr' ||
          layoutKind === 'gpu-driven-skin' ||
          layoutKind === 'gpu-driven-cluster-pbr' ||
          layoutKind === 'gpu-driven-cluster-skin'
        ? state.gpuDrivenInstancesBindGroupLayout
        : probeBlend
          ? state.probeInstancesBindGroupLayout
          : state.instancesBindGroupLayout;
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
    device.caps.backendKind === 'webgpu' || device.caps.backendKind === 'wgpu-native',
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
