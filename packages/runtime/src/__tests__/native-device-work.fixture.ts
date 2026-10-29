import { expect } from 'vitest';

/** Count actual device requests without replacing their work or lifetime. */
export function observeNativeDeviceRequests() {
  const gpu = navigator.gpu;
  const descriptor = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter');
  const original = gpu.requestAdapter;
  const adapters = new Map<GPUAdapter, PropertyDescriptor | undefined>();
  let requests = 0;
  const measured = async function (this: GPU, ...args: Parameters<GPU['requestAdapter']>) {
    const adapter = await Reflect.apply(original, this, args);
    if (adapter !== null && !adapters.has(adapter)) {
      adapters.set(adapter, Object.getOwnPropertyDescriptor(adapter, 'requestDevice'));
      const requestDevice = adapter.requestDevice;
      adapter.requestDevice = function (this: GPUAdapter, ...args) {
        requests++;
        return Reflect.apply(requestDevice, this, args);
      };
    }
    return adapter;
  };
  gpu.requestAdapter = measured;
  return {
    assertMaximum(maximum: number) {
      expect(requests, 'real native device requests').toBeGreaterThan(0);
      expect(requests, 'real native device requests').toBeLessThanOrEqual(maximum);
    },
    restore() {
      if (gpu.requestAdapter === measured) {
        if (descriptor === undefined) Reflect.deleteProperty(gpu, 'requestAdapter');
        else Object.defineProperty(gpu, 'requestAdapter', descriptor);
      }
      for (const [adapter, descriptor] of adapters) {
        if (descriptor === undefined) Reflect.deleteProperty(adapter, 'requestDevice');
        else Object.defineProperty(adapter, 'requestDevice', descriptor);
      }
    },
  };
}
