import type { RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING } from '../gpu-texture-usage';
import { runShimSyncStep } from './renderer-helpers';

// Two layers keep WebGL2 on a real 2D array texture instead of collapsing a
// single layer to TEXTURE_2D.
const SHADOW_ARRAY_FALLBACK_LAYERS = 2;

/**
 * No-shadow binding for the layered directional and spot shadow maps: a
 * cleared depth array with the same view dimension, so comparison sampling
 * always reports fully lit.
 */
export function createShadowArrayFallbackView(
  rhiDevice: RhiDevice,
  createTexture: RhiDevice['createTexture'],
): TextureView {
  const texture = runShimSyncStep(
    () =>
      createTexture({
        label: 'shadow-array-fallback-depth-1x1',
        size: { width: 1, height: 1, depthOrArrayLayers: SHADOW_ARRAY_FALLBACK_LAYERS },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: 'depth32float',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: '2d-array',
      }),
    'webgpu-runtime-error',
    'createTexture (shadow array fallback depth) succeeded',
    'check device.limits.maxTextureArrayLayers',
  );
  if (!texture.ok) throw texture.error;
  const view = runShimSyncStep(
    () =>
      rhiDevice.createTextureView(texture.value, {
        label: 'shadow-array-fallback-depth-view',
        dimension: '2d-array',
        aspect: 'depth-only',
        baseArrayLayer: 0,
        arrayLayerCount: SHADOW_ARRAY_FALLBACK_LAYERS,
        baseMipLevel: 0,
        mipLevelCount: 1,
      }),
    'webgpu-runtime-error',
    'createTextureView (shadow array fallback depth) succeeded',
    'check shadow array fallback texture format / usage',
  );
  if (!view.ok) throw view.error;
  // A depth attachment view covers one layer, so each layer owns a clear pass.
  const encoder = rhiDevice.createCommandEncoder({ label: 'shadow-array-fallback-clear-encoder' });
  if (!encoder.ok) throw encoder.error;
  for (let layer = 0; layer < SHADOW_ARRAY_FALLBACK_LAYERS; layer++) {
    const layerView = runShimSyncStep(
      () =>
        rhiDevice.createTextureView(texture.value, {
          label: `shadow-array-fallback-layer-${layer}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      'webgpu-runtime-error',
      `createTextureView (shadow array fallback layer ${layer}) succeeded`,
      'check shadow array fallback texture format / usage',
    );
    if (!layerView.ok) throw layerView.error;
    const pass = encoder.value.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: layerView.value,
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as never);
    pass.end();
  }
  const finished = encoder.value.finish();
  if (!finished.ok) throw finished.error;
  const submitted = rhiDevice.queue.submit([finished.value]);
  if (!submitted.ok) throw submitted.error;
  return view.value;
}
