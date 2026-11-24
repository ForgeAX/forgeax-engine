import type { RhiDevice, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { SCREEN_PROBE_SCATTER_NOISE_BASE64 } from './screen-probe-scatter-noise-data';

export const SCREEN_PROBE_SCATTER_NOISE_DESCRIPTOR = {
  label: 'screen-probe.scatter-noise',
  size: { width: 128, height: 128 * 8 },
  format: 'rg8unorm',
  textureBindingViewDimension: undefined,
  usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} as const;

export interface ScreenProbeScatterNoise {
  readonly texture: Texture;
  readonly view: TextureView;
}

export function createScreenProbeScatterNoise(
  device: RhiDevice,
): Result<ScreenProbeScatterNoise, RhiError> {
  const descriptor = SCREEN_PROBE_SCATTER_NOISE_DESCRIPTOR;
  const bytes = Uint8Array.from(atob(SCREEN_PROBE_SCATTER_NOISE_BASE64), (byte) =>
    byte.charCodeAt(0),
  );
  const texture = device.createTexture(descriptor);
  if (!texture.ok) return texture;
  const uploaded = device.queue.writeTexture(
    { texture: texture.value },
    bytes,
    { bytesPerRow: descriptor.size.width * 2, rowsPerImage: descriptor.size.height },
    descriptor.size,
  );
  if (!uploaded.ok) {
    device.destroyTexture(texture.value);
    return uploaded;
  }
  const view = device.createTextureView(texture.value, { dimension: '2d' });
  if (!view.ok) {
    device.destroyTexture(texture.value);
    return view;
  }
  return ok({ texture: texture.value, view: view.value });
}
