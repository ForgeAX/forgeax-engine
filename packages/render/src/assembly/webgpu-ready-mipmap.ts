import type { RhiDevice } from '@forgeax/engine-rhi';
import type { GpuResidencyCache } from '../device/gpu-residency';
import { MIPMAP_PREWARM_FORMATS } from './webgpu-ready-contract';

/**
 * Prewarm the mipmap pipeline while the renderer is still on its async ready
 * path. A manifest-free camera-only renderer must not create the shader.
 */
export async function prewarmMipmapPipeline(
  rhiDevice: RhiDevice,
  gpuStore: GpuResidencyCache,
  hasMaterialManifest: boolean,
): Promise<void> {
  if (!hasMaterialManifest) return;
  const formats = rhiDevice.caps.float32Filterable
    ? [...MIPMAP_PREWARM_FORMATS, 'rgba32float' as const]
    : MIPMAP_PREWARM_FORMATS;
  const result = await gpuStore.prewarmMipmapPipeline(rhiDevice, formats);
  if (!result.ok) throw result.error;
}
