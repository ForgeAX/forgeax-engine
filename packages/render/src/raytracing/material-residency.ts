import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import {
  type Handle,
  ok,
  type ParamSchemaEntry,
  type SamplerAsset,
  type TextureAsset,
} from '@forgeax/engine-types';
import type { GpuResidencyCache, TextureResidencyReceipt } from '../device/gpu-residency';
import type { ResidencyLease } from '../device/residency-lifetime';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import { rayReferenceFailure } from './scene';

/** Retain accepted static allocations through the Renderer residency owner.
 * Track each submission, then release on cancellation, replacement or disposal. */
export function prepareSurfaceMaterialTextures(
  store: GpuResidencyCache,
  defaultSampler: Sampler,
  paramSchema: readonly ParamSchemaEntry[],
  world: RenderResourceScope,
  snapshot: MaterialSnapshot,
  prepareTexture?: (
    handle: Handle<'TextureAsset', 'shared'>,
    asset: TextureAsset,
  ) => ReturnType<GpuResidencyCache['prepareTextureResidencyForGraph']>,
) {
  const textures = new Map<
    string,
    {
      view: TextureView;
      sampler: Sampler;
      texture: Texture;
      receipt: TextureResidencyReceipt;
    }
  >();
  const leases: ResidencyLease[] = [];
  const witnesses: (() => boolean)[] = [];
  const keys: unknown[] = [];
  let accepted = false;
  try {
    for (const parameter of paramSchema) {
      if (parameter.type !== 'texture2d') continue;
      const name = parameter.name;
      if (snapshot.textureSources?.has(name) || snapshot.videoTextureFields?.has(name))
        return rayReferenceFailure(`ray texture ${name} requires a qualified dynamic source`);
      const handle = snapshot.textureHandles?.get(name);
      if (handle === undefined || handle === 0)
        return rayReferenceFailure(`ray texture ${name} has no accepted resource handle`);
      const asset = resolveAssetHandle<TextureAsset>(world, handle);
      if (!asset.ok) return asset;
      const prepared = prepareTexture?.(handle, asset.value);
      if (prepared !== undefined && !prepared.ok) return prepared;
      const resident =
        prepared === undefined
          ? store.ensureResident(handle, asset.value, world)
          : ok(prepared.value.entry);
      if (!resident.ok) return resident;
      const lease = prepared?.value.lease ?? store.retainTextureResidency(handle, world);
      if (lease === undefined) return rayReferenceFailure(`surface texture ${name} lost residency`);
      leases.push(lease);
      if (resident.value.receipt.view !== '2d')
        return rayReferenceFailure(`surface texture ${name} requires an accepted 2d view`);
      const payload = asset.value;
      witnesses.push(() => {
        const current = resolveAssetHandle<TextureAsset>(world, handle);
        return (
          current.ok &&
          current.value === payload &&
          (prepared === undefined
            ? store.getTextureGpuView(handle, world) === resident.value.view
            : prepared.value.current())
        );
      });
      let sampler = defaultSampler;
      let samplerSource: SamplerAsset | undefined;
      const samplerHandle = snapshot.samplerHandles?.get(name);
      if (samplerHandle !== undefined && samplerHandle !== 0) {
        const asset = resolveAssetHandle<SamplerAsset>(world, samplerHandle);
        if (!asset.ok) return asset;
        const resident = store.ensureSamplerResident(samplerHandle, asset.value, world);
        if (!resident.ok) return resident;
        sampler = resident.value;
        samplerSource = asset.value;
        const payload = asset.value;
        witnesses.push(() => {
          const current = resolveAssetHandle<SamplerAsset>(world, samplerHandle);
          return current.ok && current.value === payload;
        });
      } else if (snapshot.authoredSamplerFields?.has(name)) {
        return rayReferenceFailure(`ray texture ${name} has no accepted sampler handle`);
      }
      keys.push([
        name,
        Number(handle),
        resident.value.receipt.deviceEpoch,
        resident.value.receipt.generation,
        samplerHandle ?? null,
        samplerSource ?? null,
      ]);
      textures.set(name, {
        view: resident.value.view,
        sampler,
        texture: resident.value.texture.handle,
        receipt: resident.value.receipt,
      });
    }
    accepted = true;
    return ok({
      textures,
      contentKey: JSON.stringify(keys),
      current: () => witnesses.every((current) => current()),
      track: (completed: Promise<unknown>) => {
        for (const lease of leases) lease.track(completed);
      },
      release: async () => {
        await Promise.all(leases.map((lease) => lease.release(false)));
      },
    });
  } finally {
    if (!accepted) for (const lease of leases) lease.release(false);
  }
}
