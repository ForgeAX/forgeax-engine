import type { RequestDeviceOptions } from '@forgeax/engine-rhi';
import { requestAdapterFrom } from '@forgeax/engine-rhi-webgpu';

/** Keep native validation at the provider seam, including recorded devices. */
export async function nativeAdapterFixture() {
  let native: GPUDevice | undefined;
  const adapter = (
    await requestAdapterFrom({
      async requestAdapter(adapterOptions) {
        const provider = await navigator.gpu.requestAdapter(adapterOptions);
        if (provider === null) return null;
        return {
          features: provider.features,
          limits: provider.limits,
          async requestDevice(descriptor?: GPUDeviceDescriptor) {
            const device = await provider.requestDevice(descriptor);
            native = device;
            return device;
          },
        };
      },
    })
  ).unwrap();
  return {
    adapter,
    get native() {
      if (native === undefined) throw Error('Native provider did not create a device');
      return native;
    },
  };
}

/** Keep the caller-owned native device at the public provider seam. */
export async function nativeDeviceFixture(options?: RequestDeviceOptions) {
  const fixture = await nativeAdapterFixture();
  const device = (await fixture.adapter.requestDevice(options)).unwrap();
  return { device, native: fixture.native };
}
