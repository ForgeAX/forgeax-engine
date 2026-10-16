import type { AssetReader, AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, type TimeResource, type World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { Asset, Handle } from '@forgeax/engine-types';
import type { TransparentSortConfig } from '../systems/transparent-sort-config';
import type { ReceivedCanvasFrame } from './canvas';

/** Owned data in a receiver, or a synchronously borrowed source World. */
export interface PublishedRenderResources extends AssetReader {
  /** Current accepted packet revision; an observation of the receiver authority. */
  readonly revision: number;
  readonly time: TimeResource;
  readonly transparentSort: TransparentSortConfig;
  lookupAsset<T extends Asset>(guid: string): T | undefined;
  canvasFrame?(id: number): ReceivedCanvasFrame | undefined;
  videoFrame(entity: number, clip: number): VideoFrame | undefined;
  handleForGuid(guid: string): Handle<string, 'shared'> | undefined;
  sourceForAsset(
    handle: Handle<string, 'shared'>,
  ): { readonly guid: string; readonly sourceKey?: string } | undefined;
}

export type RenderResourceScope = World | PublishedRenderResources;

export function renderTime(source: RenderResourceScope): TimeResource {
  return 'resolveAsset' in source ? source.time : source.getResource(Time);
}

/** GUID consumers use the same accepted resource namespace as handle consumers. */
export function renderAssetByGuid<T extends Asset>(
  source: RenderResourceScope,
  assets: AssetRegistry,
  guid: string | Parameters<typeof AssetGuid.format>[0],
): T | undefined {
  return 'resolveAsset' in source
    ? source.lookupAsset<T>(typeof guid === 'string' ? guid : AssetGuid.format(guid))
    : assets.lookup<T>(guid);
}
