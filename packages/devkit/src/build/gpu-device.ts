import { nodeGpu } from '../node-gpu.js';

/** Node build tools may opt into a transient, hardware-backed device. */
export async function withBuildGpuDevice<T>(
  use: (device: GPUDevice | undefined) => T | Promise<T>,
): Promise<T> {
  let device: GPUDevice | undefined;
  const gpu = await nodeGpu();
  if (gpu.ok) {
    try {
      const adapter = await gpu.value.requestAdapter();
      if (adapter && !adapter.info.isFallbackAdapter) device = await adapter.requestDevice();
    } catch {
      // The build tool still owns its CPU path if the optional device fails admission.
    }
  }
  try {
    return await use(device);
  } finally {
    device?.destroy();
  }
}
