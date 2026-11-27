import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import type { FieldReceiverGpuSource } from './field-receiver-texture';
import type { PreparedIrradianceField } from './renderer-irradiance-field';

/** The existing receiver owner alone supplies row/pose/material/source facts.
 * No source or missing row is synthesized by the texture transport. */
export function screenProbeReceiverSource(
  device: RhiDevice,
  field: PreparedIrradianceField,
  frame: number,
): FieldReceiverGpuSource {
  const receivers = field.receivers.unwrap();
  if (receivers.state === 'ready') {
    const source = receivers
      .gpuSource(field.canonical.expected, receivers.frameOwner, frame, {
        maxTextureDimension2D: device.limits.maxTextureDimension2D,
        // Preserve the current per-resource admission ceiling. Texture padding
        // and the complete source image count against it, rather than just rows.
        maxBytes: device.limits.maxStorageBufferBindingSize,
      })
      .unwrap();
    if (source.state === 'ready') return source;
  }
  return { state: 'ready', width: 4, height: 1, bytes: 64, words: new Uint32Array(16) };
}

export function screenProbeReceiverDescriptor(source: FieldReceiverGpuSource) {
  return {
    label: 'screen-probe.receiver-source',
    size: { width: source.width, height: source.height, depthOrArrayLayers: 1 },
    dimension: '2d' as const,
    textureBindingViewDimension: '2d' as const,
    format: 'rgba32uint' as const,
    usage: 2 | 4,
  };
}

export function uploadScreenProbeReceiverSource(
  device: RhiDevice,
  texture: Texture,
  source: FieldReceiverGpuSource,
) {
  return device.queue.writeTexture(
    { texture },
    source.words,
    { offset: 0, bytesPerRow: source.width * 16, rowsPerImage: source.height },
    { width: source.width, height: source.height, depthOrArrayLayers: 1 },
  );
}
