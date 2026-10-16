import type { BindGroupLayout } from '@forgeax/engine-rhi';
import type {
  MaterialShaderArtifact,
  PipelineGroup2Contract,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { type GpuDrivenPbrProgram, resolveStandardPbrProgram } from '../../gpu-driven/pbr-program';
import type { LayoutKind } from '../material-shader-policy';
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
  return passKind === 'shadow-caster' &&
    (materialShaderId === 'forgeax::default-standard-pbr' ||
      materialShaderId === 'forgeax::default-standard-pbr-skin' ||
      materialShaderId === 'forgeax::pbr-skin')
    ? 'forgeax::default-shadow-caster'
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

export interface MaterialPipelineBindGroupState {
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
    materialShaderId === 'forgeax::default-shadow-caster' ||
    materialShaderId === 'forgeax::sprite' ||
    materialShaderId === 'forgeax::sprite-lit' ||
    materialShaderId === 'forgeax::default-sprite' ||
    materialShaderId === 'forgeax::msdf-text' ||
    materialShaderId === 'forgeax::default-standard-pbr' ||
    materialShaderId === 'forgeax::pbr-skin' ||
    materialShaderId === 'forgeax::default-standard-pbr-skin'
  );
}
