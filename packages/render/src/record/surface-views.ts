import type { Result, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { RenderSystemRuntime } from './render-context';

// Output texture identity owns both display/storage formats across graph replacements.
// Browser swapchain textures expire with their weak key; persistent native targets reuse both.
const surfaceViews = new WeakMap<Texture, Map<GPUTextureFormat | undefined, TextureView>>();

export function surfaceTextureView(
  runtime: Pick<RenderSystemRuntime, 'device'>,
  texture: Texture,
  format: GPUTextureFormat | undefined,
): Result<TextureView, RhiError> {
  let formats = surfaceViews.get(texture);
  const cached = formats?.get(format);
  if (cached !== undefined) return ok(cached);
  const view = runtime.device.createTextureView(texture, format === undefined ? {} : { format });
  if (!view.ok) return view;
  if (formats === undefined) {
    formats = new Map();
    surfaceViews.set(texture, formats);
  }
  formats.set(format, view.value);
  return view;
}
