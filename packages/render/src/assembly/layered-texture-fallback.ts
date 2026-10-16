import type { RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { texelFallbackDescriptor, writeTexelFallback } from '../ibl/skylight-bind-group';
import { runShimSyncStep } from './renderer-helpers';

// Two layers keep WebGL2 on a real 2D array texture instead of collapsing a
// single layer to TEXTURE_2D.
const ARRAY_FALLBACK_LAYERS = 2;

export interface LayeredTextureFallbackViews {
  /** 1x1x1 white volume bound to `texture_3d` params until a source promotes. */
  readonly defaultWhite3dTextureView: TextureView;
  /** Two-layer white array bound to `texture_2d_array` params until a source promotes. */
  readonly defaultWhite2dArrayTextureView: TextureView;
}

/**
 * White fallbacks for layered material params. A custom material that binds a
 * 3D or array RenderTarget before its first write submission needs a view of
 * the same dimension; a 2D view would invalidate the material BGL.
 */
export function createLayeredTextureFallbackViews(
  rhiDevice: RhiDevice,
  createTexture: RhiDevice['createTexture'],
): LayeredTextureFallbackViews {
  return {
    defaultWhite3dTextureView: createWhiteView(rhiDevice, createTexture, '3d', 1),
    defaultWhite2dArrayTextureView: createWhiteView(
      rhiDevice,
      createTexture,
      '2d-array',
      ARRAY_FALLBACK_LAYERS,
    ),
  };
}

function createWhiteView(
  rhiDevice: RhiDevice,
  createTexture: RhiDevice['createTexture'],
  viewDimension: '3d' | '2d-array',
  layers: number,
): TextureView {
  const label = `fallback-white-${viewDimension}`;
  const descriptor = texelFallbackDescriptor(label, 'rgba8unorm', viewDimension, layers);
  const texture = runShimSyncStep(
    () => createTexture(descriptor),
    'webgpu-runtime-error',
    `createTexture (${label}) succeeded`,
    'check device.limits.maxTextureDimension3D / maxTextureArrayLayers',
  );
  if (!texture.ok) throw texture.error;
  const written = runShimSyncStep(
    () =>
      writeTexelFallback(
        rhiDevice.queue,
        texture.value,
        descriptor,
        new Uint8Array([255, 255, 255, 255]),
      ),
    'queue-write-buffer-out-of-bounds',
    `queue.writeTexture (${label}) succeeded`,
    'verify bytesPerRow / rowsPerImage alignment',
  );
  if (!written.ok) throw written.error;
  const view = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(texture.value, {
        label: `${label}-view`,
        dimension: viewDimension,
        ...(viewDimension === '2d-array' ? { baseArrayLayer: 0, arrayLayerCount: layers } : {}),
      }),
    'webgpu-runtime-error',
    `createTextureView (${label}) succeeded`,
    'check fallback texture format / usage',
  );
  if (!view.ok) throw view.error;
  return view.value;
}
