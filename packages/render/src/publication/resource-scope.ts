import type { AssetReader } from '@forgeax/engine-assets-runtime/internal';
import {
  runtimeAssetReference,
  runtimeAssetRegistry,
  runtimeAssetSource,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import { Time, type TimeResource, type World } from '@forgeax/engine-ecs';
import {
  VIDEO_SOURCE_PROVIDER_KEY,
  type VideoSourceProvider,
} from '@forgeax/engine-graphics-extras';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type Asset, AssetError, type AssetHandle, err } from '@forgeax/engine-types';
import {
  getTransparentSortConfig,
  type TransparentSortConfig,
} from '../systems/transparent-sort-config';
import type { ReceivedCanvasFrame } from './canvas';

/** One domain reader. World state is borrowed only for native service and lifecycle integration. */
export interface RenderResourceScope extends AssetReader {
  readonly world?: World;
  /** Current accepted packet revision, present on a publication receiver. */
  readonly revision?: number;
  assetRevision(handle: number): number | undefined;
  readonly time: TimeResource;
  readonly transparentSort: TransparentSortConfig;
  lookupAsset<T extends Asset>(guid: string): T | undefined;
  canvasFrame?(id: string): ReceivedCanvasFrame | undefined;
  videoFrame(entity: number, clip: number): HTMLVideoElement | VideoFrame | undefined;
  handleForGuid(guid: string): number | undefined;
  sourceForAsset(
    handle: number,
  ): { readonly guid: string; readonly sourceKey?: string } | undefined;
}

const worldResources = new WeakMap<World, RenderResourceScope>();

/** Compose once per World; this view owns no assets, payload cache, subscriptions or resources. */
export function worldRenderResources(world: World): RenderResourceScope {
  let view = worldResources.get(world);
  if (view !== undefined) return view;
  const owner = world.assets;
  const records = owner === undefined ? undefined : runtimeAssets(owner);
  view = {
    identity: world.identity,
    world,
    resolveAsset: (handle, revision) =>
      records === undefined
        ? err(
            new AssetError({
              code: 'asset-reference-invalid',
              expected: 'an installed asset owner',
              hint: 'create the World with the asset owner before binding asset fields',
            }),
          )
        : records.resolveAsset(handle, revision),
    assetRevision: (handle) => {
      const version = records?.version(handle);
      return version?.ok ? version.value : undefined;
    },
    get time() {
      return world.getResource(Time);
    },
    get transparentSort() {
      return getTransparentSortConfig(world);
    },
    handleForGuid: (guid) => (owner === undefined ? undefined : runtimeAssetReference(owner, guid)),
    sourceForAsset: (handle) => {
      const guid = owner === undefined ? undefined : runtimeAssetSource(owner, handle);
      if (guid === undefined || owner === undefined) return undefined;
      const sourceKey = runtimeAssetRegistry(owner).sourceKeyOf(guid);
      return { guid, ...(sourceKey === undefined ? {} : { sourceKey }) };
    },
    lookupAsset: <T extends Asset>(guid: string) => {
      const handle = owner === undefined ? undefined : runtimeAssetReference(owner, guid);
      const value = handle === undefined ? undefined : records?.resolveAsset<T>(handle);
      return value?.ok ? value.value : undefined;
    },
    videoFrame: (entity, clip) =>
      world.hasResource(VIDEO_SOURCE_PROVIDER_KEY)
        ? world
            .getResource<VideoSourceProvider>(VIDEO_SOURCE_PROVIDER_KEY)
            .getSource(
              entity as import('@forgeax/engine-ecs').EntityHandle,
              clip as AssetHandle<'video'>,
            )
        : undefined,
  };
  worldResources.set(world, view);
  return view;
}

export function renderAssetRevision(
  source: RenderResourceScope,
  handle: number,
): number | undefined {
  return source.assetRevision(handle);
}

export function renderTime(source: RenderResourceScope): TimeResource {
  return source.time;
}

/** Runtime references and source GUIDs resolve within the same accepted namespace. */
export function renderAsset<T extends Asset>(
  source: RenderResourceScope,
  reference: number | string | Parameters<typeof AssetGuid.format>[0],
): T | undefined {
  const handle =
    typeof reference === 'number'
      ? reference
      : source.handleForGuid(
          typeof reference === 'string' ? reference : AssetGuid.format(reference),
        );
  if (handle === undefined) return undefined;
  const payload = source.resolveAsset<T>(handle);
  return payload.ok ? payload.value : undefined;
}
