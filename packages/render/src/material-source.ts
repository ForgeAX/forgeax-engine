import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Asset, AssetError, err, ok, type Result } from '@forgeax/engine-types';
import type { RenderResourceScope } from './publication/resource-scope';

/** Exact CPU source closure of an accepted material, shared by all of its consumers. */
export interface MaterialSourceSnapshot {
  readonly root: number;
  readonly revision: number;
  readonly assets: readonly Readonly<{
    handle: number;
    revision: number;
    value?: Asset;
    source?: Readonly<{ guid: string; sourceKey?: string }>;
  }>[];
}

/** Clone-safe version references; CPU payloads travel through the exact-version owner. */
export type MaterialSourceReferences = Readonly<{
  root: number;
  revision: number;
  assets: readonly Readonly<{
    handle: number;
    revision: number;
    source?: Readonly<{ guid: string; sourceKey?: string }>;
  }>[];
}>;

/** Capture only at material version admission; an unchanged material reuses this whole fact. */
export function captureMaterialSource(
  scope: RenderResourceScope,
  root: number,
): MaterialSourceSnapshot | undefined {
  const owner = scope.world?.assets;
  if (owner === undefined) return undefined;
  const records = runtimeAssets(owner);
  const captured = records.snapshot(root).unwrap();
  try {
    const assets: MaterialSourceSnapshot['assets'][number][] = [];
    const pending = [root];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const handle = pending.pop();
      if (handle === undefined || seen.has(handle)) continue;
      seen.add(handle);
      const revision = captured.version(handle).unwrap();
      const value = captured.read<Asset>(handle).unwrap();
      const source = scope.sourceForAsset(handle);
      assets.push(
        Object.freeze({
          handle,
          revision,
          value,
          ...(source === undefined ? {} : { source: Object.freeze({ ...source }) }),
        }),
      );
      pending.push(...records.dependencies(handle).unwrap());
    }
    if (!captured.matchesCurrent())
      throw new Error('Material closure changed during source capture');
    return Object.freeze({
      root,
      revision: captured.version(root).unwrap(),
      assets: Object.freeze(assets),
    });
  } finally {
    captured.dispose();
  }
}

export function materialSourceMatchesCurrent(
  scope: RenderResourceScope,
  source: MaterialSourceSnapshot,
): boolean {
  return source.assets.every((asset) => scope.assetRevision(asset.handle) === asset.revision);
}

export function sameMaterialSource(
  left: MaterialSourceSnapshot | undefined,
  right: MaterialSourceSnapshot | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.root === right.root &&
      left.revision === right.revision &&
      left.assets.length === right.assets.length &&
      left.assets.every((asset, index) => {
        const other = right.assets[index];
        return (
          other !== undefined &&
          asset.handle === other.handle &&
          asset.revision === other.revision &&
          asset.source?.guid === other.source?.guid &&
          asset.source?.sourceKey === other.source?.sourceKey
        );
      }))
  );
}

const scopes = new WeakMap<
  MaterialSourceSnapshot,
  WeakMap<RenderResourceScope, RenderResourceScope>
>();

/** Residency and recording read the same accepted source, including retired dependency handles. */
export function materialSourceScope(
  scope: RenderResourceScope,
  source: MaterialSourceSnapshot | undefined,
  resolveVersion?: (handle: number, revision: number) => Asset | undefined,
): RenderResourceScope {
  if (source === undefined) return scope;
  let owners = scopes.get(source);
  const previous = owners?.get(scope);
  if (previous !== undefined) return previous;
  type SourceAsset = MaterialSourceSnapshot['assets'][number];
  let single: SourceAsset | undefined;
  const assets = source.assets.length > 1 ? new Map<number, SourceAsset>() : undefined;
  let guids: Map<string, number> | undefined;
  let complete = true;
  for (const entry of source.assets) {
    let asset = entry;
    if (asset.value === undefined) {
      const resolved = resolveVersion?.(asset.handle, asset.revision);
      const fallback =
        resolved === undefined ? scope.resolveAsset(asset.handle, asset.revision) : undefined;
      const value = resolved ?? (fallback?.ok === true ? fallback.value : undefined);
      if (value === undefined) complete = false;
      else asset = { ...asset, value };
    }
    if (assets === undefined) single = asset;
    else assets.set(asset.handle, asset);
    if (asset.source !== undefined) {
      guids ??= new Map();
      guids.set(asset.source.guid.toLowerCase(), asset.handle);
    }
  }
  const rowFor = (handle: number) => (single?.handle === handle ? single : assets?.get(handle));
  const fixed: RenderResourceScope = {
    ...scope,
    resolveAsset: <T extends Asset>(handle: number, revision?: number): Result<T, AssetError> => {
      const asset = rowFor(handle);
      if (asset === undefined) return scope.resolveAsset<T>(handle, revision);
      if (revision !== undefined && revision !== asset.revision)
        return err(
          new AssetError({
            code: 'asset-reference-invalid',
            expected: 'the accepted material source revision',
            hint: 'read the material and its dependencies from their accepted source closure',
          }),
        );
      if (asset.value === undefined) {
        return err(
          new AssetError({
            code: 'asset-reference-invalid',
            expected: 'the retained exact material source payload',
            hint: 'retain every material source version before preparing its bindings',
          }),
        );
      }
      return ok(asset.value as T);
    },
    assetRevision: (handle) => rowFor(handle)?.revision ?? scope.assetRevision(handle),
    handleForGuid: (guid) => guids?.get(guid.toLowerCase()) ?? scope.handleForGuid(guid),
    sourceForAsset: (handle) => rowFor(handle)?.source ?? scope.sourceForAsset(handle),
    lookupAsset: <T extends Asset>(guid: string): T | undefined => {
      const handle = guids?.get(guid.toLowerCase());
      if (handle === undefined) return scope.lookupAsset<T>(guid);
      const row = rowFor(handle);
      if (row === undefined) return undefined;
      if (row.value !== undefined) return row.value as T;
      return undefined;
    },
  };
  if (complete) {
    // Source lookup can reenter; publish into the current owner table.
    owners = scopes.get(source);
    if (owners === undefined) {
      owners = new WeakMap();
      scopes.set(source, owners);
    }
    owners.set(scope, fixed);
  }
  return fixed;
}

export function materialSourceReferences(source: MaterialSourceSnapshot): MaterialSourceReferences {
  return Object.freeze({
    root: source.root,
    revision: source.revision,
    assets: Object.freeze(
      source.assets.map(({ handle, revision, source }) =>
        Object.freeze({
          handle,
          revision,
          ...(source === undefined
            ? {}
            : {
                source: Object.freeze({
                  guid: source.guid,
                  ...(source.sourceKey === undefined ? {} : { sourceKey: source.sourceKey }),
                }),
              }),
        }),
      ),
    ),
  });
}

export function isMaterialSourceSnapshot(value: unknown): value is MaterialSourceSnapshot {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('root' in value) ||
    !('revision' in value) ||
    !('assets' in value) ||
    !Number.isSafeInteger(value.root) ||
    (value.root as number) <= 0 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.assets) ||
    value.assets.length > 65536
  )
    return false;
  const handles = new Set<number>();
  for (const asset of value.assets) {
    if (!validMaterialSourceAsset(asset, handles)) return false;
    handles.add(asset.handle);
  }
  return value.assets.some(
    (asset) => asset.handle === value.root && asset.revision === value.revision,
  );
}

function validMaterialSourceAsset(
  asset: MaterialSourceSnapshot['assets'][number],
  handles: ReadonlySet<number>,
): boolean {
  if (
    asset === null ||
    typeof asset !== 'object' ||
    !Number.isSafeInteger(asset.handle) ||
    asset.handle <= 0 ||
    !Number.isSafeInteger(asset.revision) ||
    asset.revision < 0 ||
    handles.has(asset.handle) ||
    (asset.value !== undefined &&
      (asset.value === null ||
        typeof asset.value !== 'object' ||
        typeof asset.value.kind !== 'string')) ||
    (asset.source !== undefined &&
      (typeof asset.source !== 'object' ||
        asset.source === null ||
        typeof asset.source.guid !== 'string'))
  )
    return false;
  return true;
}
