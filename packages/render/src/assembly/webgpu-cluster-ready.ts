import type {
  BindGroupLayout,
  ComputePipeline,
  Result,
  RhiDevice,
  RhiError,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { createHdrpClusterMembershipBindGroupLayoutDescriptor } from '../hdrp-buffers';
import { STANDARD_CLUSTER_MEMBERSHIP_WGSL } from '../pipeline/standard-pipeline';
import { invokeDeviceCreateShaderModule } from './material-shader-policy';

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
