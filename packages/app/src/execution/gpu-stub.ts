import { installWebGpuStub, type WebGpuStubProfile } from '@forgeax/engine-rhi-webgpu';

/** App options or realm init messages that may carry the WebGPU stub profile. */
interface GpuStubCarrier {
  readonly gpuStub?: WebGpuStubProfile | undefined;
}

/** Install the carried stub in the calling realm, before any WebGPU reader. */
export function installCarriedGpuStub(carrier: GpuStubCarrier | undefined): void {
  if (carrier?.gpuStub !== undefined) installWebGpuStub(carrier.gpuStub);
}

/** Forward the carried stub profile into the next realm's init message. */
export function forwardGpuStub(carrier: GpuStubCarrier): {
  readonly gpuStub?: WebGpuStubProfile;
} {
  return carrier.gpuStub === undefined ? {} : { gpuStub: carrier.gpuStub };
}
