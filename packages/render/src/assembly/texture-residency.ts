import type { World } from '@forgeax/engine-ecs';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, type TextureAsset } from '@forgeax/engine-types';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { ResidencyLease } from '../device/residency-lifetime';
import { worldRenderResources } from '../publication/resource-scope';
import type { Renderer } from '../render-contract';
import { TextureResidencyError } from '../texture-residency';

export function createTextureResidencyPreparer(
  attachedWorlds: ReadonlySet<World>,
  getStore: () => GpuResidencyCache,
  getDevice: () => RhiDevice,
): Renderer['prepareTextureResidency'] {
  return (world, textureHandle) => {
    if (!attachedWorlds.has(world))
      return err(new TextureResidencyError({ reason: 'world-not-attached', textureHandle }));
    const source = worldRenderResources(world);
    const resolved = source.resolveAsset<TextureAsset>(textureHandle);
    if (!resolved.ok || resolved.value.kind !== 'texture')
      return err(
        new TextureResidencyError({
          reason: 'invalid-texture',
          textureHandle,
          cause: resolved.ok ? 'asset is not a TextureAsset' : resolved.error,
        }),
      );
    const store = getStore();
    const failure = (cause: unknown) =>
      err(new TextureResidencyError({ reason: 'upload-failed', textureHandle, cause }));
    const prepared = store.prepareTextureResidency(textureHandle, resolved.value, source);
    if (!prepared.ok) return failure(prepared.error);
    // Reuse the native mip transaction, selecting only this texture's work.
    const mips = store.prepareTextureMips(prepared.value.texture.handle);
    if (!mips.ok) return failure(mips.error);
    const work = mips.value;
    if (work === undefined) return ok(undefined);
    let accepted = false;
    let lease: ResidencyLease | undefined;
    try {
      const device = getDevice();
      lease = store.retainTextureResidency(textureHandle, source);
      const submitted =
        work.buffer === undefined ? ok(undefined) : device.queue.submit([work.buffer]);
      accepted = submitted.ok;
      if (accepted && work.buffer !== undefined) lease?.track(device.queue.onSubmittedWorkDone());
      return submitted.ok ? ok(undefined) : failure(submitted.error);
    } finally {
      try {
        work.complete(accepted);
      } finally {
        void lease?.release(false);
      }
    }
  };
}
