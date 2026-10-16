import { onTestFinished, vi } from 'vitest';

export function collectWebGpuValidationErrors(): string[] {
  const errors: string[] = [];
  const requestDevice = GPUAdapter.prototype.requestDevice;
  const spy = vi.spyOn(GPUAdapter.prototype, 'requestDevice').mockImplementation(async function (
    this: GPUAdapter,
    descriptor,
  ) {
    const device = await requestDevice.call(this, descriptor);
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    return device;
  });
  onTestFinished(() => spy.mockRestore());
  return errors;
}
