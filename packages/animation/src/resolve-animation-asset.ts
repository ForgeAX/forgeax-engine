import type { World } from '@forgeax/engine-ecs';
import type { Asset, Handle, Result } from '@forgeax/engine-types';
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

type AnimationAssetTarget<T extends Asset> = T extends { readonly kind: 'animation-clip' }
  ? 'AnimationClip'
  : 'AnimationGraph';

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
  readonly handle: Handle<AnimationAssetTarget<T>, 'shared'>;
}

export type AnimationAssetLookup<T extends Asset> = T | { readonly code: 'stale' } | undefined;

/**
 * Resolve a durable GUID through the caller's existing payload owner, then
 * project that payload into the current World. The callback is deliberately a
 * lookup seam, not a registry: AssetRegistry remains GUID -> payload only.
 */
export function resolveAnimationAsset<T extends Asset>(
  world: World,
  guid: string,
  expectedKind: T['kind'],
  lookup: (guid: string) => AnimationAssetLookup<T>,
): Result<ResolvedAnimationAsset<T>, AnimationAssetError> {
  if (guid.length === 0) {
    return err(
      new AnimationAssetError({
        code: 'animation-asset-not-found',
        expected: `a durable ${expectedKind} GUID`,
        hint: 'load the animation asset by GUID before evaluating the graph',
        detail: { guid, expectedKind, lookupCode: 'guid-empty' },
      }),
    );
  }
  let asset: AnimationAssetLookup<T>;
  try {
    asset = lookup(guid);
  } catch {
    return err(
      new AnimationAssetError({
        code: 'animation-asset-not-found',
        expected: `a loaded ${expectedKind} payload for GUID ${guid}`,
        hint: 'repair the animation asset lookup provider and retry resolution',
        detail: { guid, expectedKind, lookupCode: 'lookup-threw' },
      }),
    );
  }
  if (asset !== undefined && 'code' in asset && asset.code === 'stale') {
    return err(
      new AnimationAssetError({
        code: 'animation-asset-stale',
        expected: `a current ${expectedKind} payload for GUID ${guid}`,
        hint: 'rebuild the stale asset projection before evaluating the graph',
        detail: { guid, expectedKind, lookupCode: 'asset-stale' },
      }),
    );
  }
  if (asset === undefined) {
    return err(
      new AnimationAssetError({
        code: 'animation-asset-not-found',
        expected: `a loaded ${expectedKind} payload for GUID ${guid}`,
        hint: 'load or retain the referenced animation asset before evaluating the graph',
        detail: { guid, expectedKind, lookupCode: 'asset-not-found' },
      }),
    );
  }
  const payload = asset as T;
  if (payload.kind !== expectedKind) {
    return err(
      new AnimationAssetError({
        code: 'animation-asset-kind-mismatch',
        expected: `asset kind '${expectedKind}'`,
        hint: `replace GUID ${guid} with a loaded ${expectedKind} asset`,
        detail: {
          guid,
          expectedKind,
          actualKind: payload.kind,
          lookupCode: 'asset-kind-mismatch',
        },
      }),
    );
  }
  const target = expectedKind === 'animation-clip' ? 'AnimationClip' : 'AnimationGraph';
  const handle = world.internSharedRef(target, payload) as Handle<
    AnimationAssetTarget<T>,
    'shared'
  >;
  return ok({ guid, asset: payload, handle });
}
