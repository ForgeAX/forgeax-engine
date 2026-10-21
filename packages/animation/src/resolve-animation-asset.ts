import { runtimeAssetReference, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import type { Asset, AssetHandle, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

/** Closed animation-domain failure codes for durable GUID projection. */
export type AnimationAssetErrorCode =
  | 'animation-asset-not-found'
  | 'animation-asset-stale'
  | 'animation-asset-kind-mismatch';

export interface AnimationAssetErrorDetail {
  readonly guid: string;
  readonly expectedKind: string;
  readonly actualKind?: string;
  readonly lookupCode: string;
}

/** Structured failure at the animation consumer boundary. */
export class AnimationAssetError extends Error {
  readonly code: AnimationAssetErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationAssetErrorDetail;

  constructor(args: {
    code: AnimationAssetErrorCode;
    expected: string;
    hint: string;
    detail: AnimationAssetErrorDetail;
  }) {
    super(`[AnimationAssetError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'AnimationAssetError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

export interface ResolvedAnimationAsset<T extends Asset> {
  readonly guid: string;
  readonly asset: T;
  readonly handle: AssetHandle<T['kind']>;
}

/** Resolve directly through the World asset owner; resolving grants no producer hold. */
export function resolveAnimationAsset<T extends Asset>(
  world: World,
  reference: string | number,
  expectedKind: T['kind'],
): Result<ResolvedAnimationAsset<T>, AnimationAssetError> {
  const guid = String(reference);
  const owner = world.assets;
  const handle =
    typeof reference === 'number'
      ? reference
      : owner === undefined
        ? undefined
        : runtimeAssetReference(owner, reference);
  if (handle === undefined)
    return err(
      new AnimationAssetError({
        code: 'animation-asset-not-found',
        expected: `a loaded ${expectedKind} reference ${guid}`,
        hint: 'load the animation asset closure before playback',
        detail: { guid, expectedKind, lookupCode: 'asset-not-found' },
      }),
    );
  const read = runtimeAssets(world.assets).resolveAsset<T>(handle);
  if (!read.ok)
    return err(
      new AnimationAssetError({
        code: 'animation-asset-stale',
        expected: `a retained ${expectedKind} reference ${guid}`,
        hint: 'bind assets from the live World owner',
        detail: { guid, expectedKind, lookupCode: read.error.code },
      }),
    );
  if (read.value.kind !== expectedKind)
    return err(
      new AnimationAssetError({
        code: 'animation-asset-kind-mismatch',
        expected: `asset kind ${expectedKind}`,
        hint: 'bind the matching animation asset kind',
        detail: {
          guid,
          expectedKind,
          actualKind: read.value.kind,
          lookupCode: 'asset-kind-mismatch',
        },
      }),
    );
  return ok({ guid, asset: read.value, handle: handle as AssetHandle<T['kind']> });
}
