import type { RhiDevice, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';

/** A reproducible, filterable RGBA noise field; each channel has an independent sample. */
export function createFeatureNoisePixels(): Uint8Array {
  const pixels = new Uint8Array(64 * 64 * 4);
  let state = 0x6d2b79f5;
  for (let index = 0; index < pixels.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state >>> 24;
  }
  return pixels;
}

/** The caller's device scope owns the texture, like the other built-in material inputs. */
export function createFeatureNoiseTexture(
  device: RhiDevice,
): Result<{ readonly texture: Texture; readonly view: TextureView }, RhiError> {
  const texture = device.createTexture({
    label: 'feature-noise-64x64',
    size: { width: 64, height: 64 },
    format: 'rgba8unorm',
    usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  if (!texture.ok) return texture;
  const uploaded = device.queue.writeTexture(
    { texture: texture.value },
    createFeatureNoisePixels(),
    { bytesPerRow: 256, rowsPerImage: 64 },
    { width: 64, height: 64 },
  );
  if (!uploaded.ok) {
    device.destroyTexture(texture.value);
    return uploaded;
  }
  const view = device.createTextureView(texture.value, {
    label: 'feature-noise-view',
    dimension: '2d',
  });
  if (!view.ok) {
    device.destroyTexture(texture.value);
    return view;
  }
  return ok({ texture: texture.value, view: view.value });
}

/** Lazily provisions one generation-owned noise view for feature preparation. */
export function createFeatureNoiseResolver(input: {
  readonly scope: DeviceScope;
  readonly getDevice: () => RhiDevice;
  readonly onError: (error: RhiError) => void;
}): (frameNumber: number) => TextureView | undefined {
  let current:
    | { readonly device: RhiDevice; readonly generation: number; readonly view: TextureView }
    | undefined;
  let attempt:
    | { readonly device: RhiDevice; readonly generation: number; readonly frameNumber: number }
    | undefined;
  return (frameNumber) => {
    const device = input.getDevice();
    const generation = input.scope.generation;
    if (current?.device === device && current.generation === generation) return current.view;
    if (
      attempt?.device === device &&
      attempt.generation === generation &&
      attempt.frameNumber === frameNumber
    ) {
      return undefined;
    }
    current = undefined;
    attempt = { device, generation, frameNumber };
    const created = createFeatureNoiseTexture(device);
    if (!created.ok) {
      input.onError(created.error);
      return undefined;
    }
    input.scope._adopt('texture', created.value.texture, (value) => {
      device.destroyTexture(value);
    });
    current = { device, generation, view: created.value.view };
    return current.view;
  };
}
