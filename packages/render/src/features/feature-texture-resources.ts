import type { ImportedTextureDescriptor } from '@forgeax/engine-render-graph';
import type { RhiDevice, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import type { RenderFeatureTextureDescriptor } from './feature-texture';

export interface OwnedFeatureTexture {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly graph: ImportedTextureDescriptor;
  readonly source: RenderFeatureTextureDescriptor;
  release(): Result<void, RhiError>;
}
/** Called exclusively by the RenderFeature GPU session. Allocation and fence
 * retirement share its DeviceScope and never escape to producer callbacks. */
export function allocateFeatureTexture(
  scope: DeviceScope,
  device: RhiDevice,
  name: string,
  source: RenderFeatureTextureDescriptor,
): Result<OwnedFeatureTexture, RhiError> {
  const usage = source.usage.reduce(
    (mask, role) => mask | { sampled: 4, storage: 8, 'copy-src': 1, 'copy-dst': 2 }[role],
    0,
  );
  const size = {
    width: source.width,
    height: source.height,
    depthOrArrayLayers: source.layers ?? 1,
  };
  const allocated = scope.allocate(
    'texture',
    () =>
      device.createTexture({
        label: name,
        size,
        format: source.format,
        usage,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
        textureBindingViewDimension: source.layers === 6 ? undefined : (source.dimension ?? '2d'),
      }),
    (texture) => device.destroyTexture(texture),
  );
  if (!allocated.ok) return allocated;
  const texture = allocated.value.reference.value;
  const view = device.createTextureView(texture, {
    label: `${name}.view`,
    dimension: source.dimension ?? '2d',
  });
  if (!view.ok) {
    const cleanup = allocated.value.release();
    if (!cleanup.ok) return cleanup;
    return view;
  }
  return ok({
    texture,
    view: view.value,
    source,
    graph: {
      format: source.format,
      size,
      usage,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
    },
    release: () => allocated.value.release(),
  });
}
