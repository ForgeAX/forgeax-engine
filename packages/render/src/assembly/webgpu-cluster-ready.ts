import type {
  BindGroupLayout,
  ComputePipeline,
  Result,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import {
  findVariantByKey,
  isShaderTemplateManifestRow,
  type ShaderCatalog,
} from '@forgeax/engine-shader';
import { isShaderCompilerProfile, type ManifestEntry } from '@forgeax/engine-types';
import { createHdrpClusterMembershipBindGroupLayoutDescriptor } from '../hdrp-buffers';
import {
  deriveStandardClusterReflectedAbi,
  type StandardClusterReflectedAbi,
} from '../light-buffer-layout';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import { STANDARD_CLUSTER_MEMBERSHIP_WGSL } from '../pipeline/standard-pipeline';
import {
  invokeDeviceCreateShaderModule,
  resolveMaterialShaderVariantSet,
} from './material-shader-policy';

interface ClusterReflectionPublication {
  readonly hash?: string | undefined;
  readonly sourceDigest?: string | undefined;
  readonly compilerProfile?: ManifestEntry['compilerProfile'];
  readonly reflection?: ManifestEntry['reflection'];
}

function publishedClusterReflection(entry: ClusterReflectionPublication) {
  if (
    typeof entry.hash !== 'string' ||
    !/^[a-f0-9]{8}$/.test(entry.hash) ||
    typeof entry.sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sourceDigest) ||
    !isShaderCompilerProfile(entry.compilerProfile)
  )
    return undefined;
  return entry.reflection;
}

/** Reflect the shared inputs even if no lit material is drawn by this renderer. */
export function resolveStandardClusterAbi(
  device: RhiDevice,
  registry: ShaderCatalog,
  manifestEntries: readonly ManifestEntry[],
): StandardClusterReflectedAbi | undefined {
  const probe = manifestEntries.find(
    (entry) => entry.identifier === 'forgeax_standard::cluster_layout_probe',
  );
  if (probe !== undefined)
    return deriveStandardClusterReflectedAbi([publishedClusterReflection(probe)]);

  // Prior publications carry the same ABI in the raster material reflections.
  const reflections: ManifestEntry['reflection'][] = [];
  const backend = device.caps.backendKind;
  for (const entry of registry.materialShaderManifestEntries()) {
    if (!isCanonicalStandardPbrMaterialShader(entry.identifier)) continue;
    if (isShaderTemplateManifestRow(entry)) {
      const key = resolveMaterialShaderVariantSet(
        'CLUSTER_FORWARD_AVAILABLE=true',
        entry,
        backend === 'wgpu-webgl2' ? 'webgpu' : backend,
        true,
        device.limits.maxSampledTexturesPerShaderStage,
      );
      const selected = key === undefined ? undefined : findVariantByKey(entry, key);
      if (selected !== undefined) reflections.push(publishedClusterReflection(selected));
      continue;
    }
    for (const variant of entry.variants)
      if (
        variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true
      )
        reflections.push(publishedClusterReflection(variant));
  }
  return deriveStandardClusterReflectedAbi(reflections);
}

/** Optional cluster membership producer; allocation failure retains the CPU binner. */
export async function buildClusterMembershipProducer(
  rhiDevice: RhiDevice,
  enabled: boolean,
  asyncCreateShaderModule:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Promise<Result<ShaderModule, RhiError>>)
    | undefined,
) {
  let hdrpClusterMembershipPipeline: ComputePipeline | null = null;
  let hdrpClusterMembershipBindGroupLayout: BindGroupLayout | null = null;
  if (enabled && rhiDevice.caps.compute) {
    const producerBgl = rhiDevice.createBindGroupLayout(
      createHdrpClusterMembershipBindGroupLayoutDescriptor(),
    );
    if (producerBgl.ok) {
      hdrpClusterMembershipBindGroupLayout = producerBgl.value;
    }
    const membershipModule = asyncCreateShaderModule
      ? await asyncCreateShaderModule(rhiDevice, {
          code: STANDARD_CLUSTER_MEMBERSHIP_WGSL,
          label: 'hdrp-cluster-membership',
        })
      : await invokeDeviceCreateShaderModule(rhiDevice, {
          code: STANDARD_CLUSTER_MEMBERSHIP_WGSL,
          label: 'hdrp-cluster-membership',
        });
    if (membershipModule.ok && hdrpClusterMembershipBindGroupLayout !== null) {
      const producerLayout = rhiDevice.createPipelineLayout({
        label: 'hdrp-cluster-membership-pl',
        bindGroupLayouts: [hdrpClusterMembershipBindGroupLayout],
      });
      if (producerLayout.ok) {
        const membershipPipeline = rhiDevice.createComputePipeline({
          label: 'hdrp-cluster-membership',
          layout: producerLayout.value,
          compute: {
            module: membershipModule.value,
            entryPoint: 'cs_cluster_membership',
          },
        });
        if (membershipPipeline.ok) {
          hdrpClusterMembershipPipeline = membershipPipeline.value;
        }
      } else {
        hdrpClusterMembershipBindGroupLayout = null;
      }
    }
  }

  return { hdrpClusterMembershipPipeline, hdrpClusterMembershipBindGroupLayout };
}
