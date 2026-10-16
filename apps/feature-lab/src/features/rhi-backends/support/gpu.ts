import type { Buffer, RhiDevice, ShaderModule } from '@forgeax/engine/rhi';
import { createShaderModule, rhi } from '@forgeax/engine/rhi-webgpu';
import type { CheckList } from '../../../lab/feature';

export interface WebGpuDevice {
  readonly device: RhiDevice;
  readonly adapterFeatures: ReadonlySet<string>;
}

/** Strict two-step discovery on the browser WebGPU backend; failures land in `checks`. */
export async function webgpuDevice(
  checks: CheckList,
  requiredFeatures: readonly GPUFeatureName[] = [],
): Promise<WebGpuDevice | undefined> {
  const adapter = await rhi.requestAdapter();
  checks.ok('rhi.requestAdapter() ok', adapter.ok, adapter.ok ? undefined : adapter.error.code);
  if (!adapter.ok) return undefined;
  const wanted = requiredFeatures.filter((name) => adapter.value.features.has(name));
  const device = await adapter.value.requestDevice({ requiredFeatures: wanted });
  checks.ok('adapter.requestDevice() ok', device.ok, device.ok ? undefined : device.error.code);
  if (!device.ok) return undefined;
  return { device: device.value, adapterFeatures: adapter.value.features };
}

export async function shader(
  checks: CheckList,
  device: RhiDevice,
  code: string,
): Promise<ShaderModule | undefined> {
  const module = await createShaderModule(device, { code });
  checks.ok('createShaderModule ok', module.ok, module.ok ? undefined : module.error.code);
  return module.ok ? module.value : undefined;
}

/** Maps a MAP_READ buffer after queue completion and copies its bytes out. */
export async function readBack(
  device: RhiDevice,
  buffer: Buffer,
  size: number,
): Promise<ArrayBuffer | string> {
  await device.queue.onSubmittedWorkDone();
  const mapped = await buffer.mapAsync(GPUMapMode.READ);
  if (!mapped.ok) return `mapAsync failed: ${mapped.error.code}`;
  const range = mapped.value.getMappedRange(0, size);
  if (!range.ok) {
    mapped.value.unmap();
    return `getMappedRange failed: ${range.error.code}`;
  }
  const copy = range.value.slice(0);
  mapped.value.unmap();
  return copy;
}
