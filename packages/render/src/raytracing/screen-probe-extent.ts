import type { Buffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { ResidencyLifetime } from '../device/residency-lifetime';
import type { FieldReceiverGpuSource } from './field-receiver-texture';
import type { ScreenProbeExtent } from './renderer-screen-probe';
import { type ScreenProbeLayout, screenProbeAllocationSizes } from './screen-probe-plan';
import { screenProbeReceiverDescriptor } from './screen-probe-receiver-source';

/** Allocate one complete replacement before retiring its predecessor. Failed
 * buffer/texture/view creation releases every partial success immediately. */
export function createScreenProbeExtent(
  device: RhiDevice,
  layout: ScreenProbeLayout,
  paidRoot: boolean,
  source: FieldReceiverGpuSource | undefined,
  screenDepthHistory = false,
): ScreenProbeExtent {
  const sizes = screenProbeAllocationSizes(
    layout,
    device.limits.maxStorageBufferBindingSize,
    paidRoot,
    source?.bytes,
    screenDepthHistory,
  );
  const created: Buffer[] = [];
  let texture: Texture | undefined;
  const destroy = () => {
    for (const buffer of created) device.destroyBuffer(buffer);
    if (texture !== undefined) device.destroyTexture(texture);
  };
  try {
    const buffers = Object.fromEntries(
      Object.entries(sizes)
        .filter(([slot]) => slot !== 'receiverSource')
        .map(([slot, size]) => {
          const buffer = device
            .createBuffer({ label: `screen-probe.${slot}`, size, usage: 128 | 12 })
            .unwrap();
          created.push(buffer);
          return [slot, { buffer, size }];
        }),
    ) as ScreenProbeExtent['buffers'] &
      Pick<ScreenProbeExtent, 'rootRequests' | 'previousScreenDepth'>;
    const receiverSource =
      source === undefined
        ? undefined
        : (() => {
            const descriptor = screenProbeReceiverDescriptor(source);
            texture = device.createTexture(descriptor).unwrap();
            return {
              texture,
              view: device.createTextureView(texture, { dimension: '2d' }).unwrap(),
              descriptor,
              bytes: source.bytes,
            };
          })();
    return {
      layout,
      buffers,
      ...(buffers.rootRequests === undefined ? {} : { rootRequests: buffers.rootRequests }),
      ...(buffers.previousScreenDepth === undefined
        ? {}
        : { previousScreenDepth: buffers.previousScreenDepth }),
      ...(receiverSource === undefined ? {} : { receiverSource }),
      lifetime: new ResidencyLifetime(destroy),
    };
  } catch (cause) {
    destroy();
    throw cause;
  }
}
