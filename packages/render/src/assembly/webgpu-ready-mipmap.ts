import {
  configureNativeMipmapCompiler,
  type NativeMipmapShaderCompiler,
} from '@forgeax/engine-assets-runtime';
import type { RhiDevice } from '@forgeax/engine-rhi';
import type { GpuResidencyCache } from '../device/gpu-residency';
import { MIPMAP_PREWARM_FORMATS } from './webgpu-ready-contract';

/** Native mip recording can resolve the exact format; other backends prewarm. */
export async function prepareRendererMipmaps(
  rhiDevice: RhiDevice,
  gpuStore: GpuResidencyCache,
  hasMaterialManifest: boolean,
  nativeCompiler: NativeMipmapShaderCompiler | undefined,
): Promise<void> {
  if (rhiDevice.caps.backendKind === 'webgpu' && nativeCompiler !== undefined) {
    configureNativeMipmapCompiler(rhiDevice, nativeCompiler);
    return;
  }
  if (!hasMaterialManifest) return;
  const formats = rhiDevice.caps.float32Filterable
    ? [...MIPMAP_PREWARM_FORMATS, 'rgba32float' as const]
    : MIPMAP_PREWARM_FORMATS;
  const result = await gpuStore.prewarmMipmapPipeline(rhiDevice, formats);
  if (!result.ok) throw result.error;
}
