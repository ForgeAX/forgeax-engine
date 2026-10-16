import { terrainDerivedClosureValid } from '@forgeax/engine-terrain';
import type { Asset, TerrainAsset } from '@forgeax/engine-types';
import type { AssetRegistry } from './asset-registry.js';

const closures = new WeakMap<AssetRegistry, WeakMap<TerrainAsset, ReadonlyMap<string, Asset>>>();

/** Terrain derived outputs are adopted with the root, never repinned after a partial rewrite. */
export function captureTerrainClosure(registry: AssetRegistry, root: TerrainAsset): boolean {
  let roots = closures.get(registry);
  if (roots === undefined) {
    roots = new WeakMap();
    closures.set(registry, roots);
  }
  const held = roots.get(root);
  if (held !== undefined)
    return [...held].every(([guid, asset]) => registry.lookup(guid) === asset);
  const direct = [
    ...root.grids,
    ...root.layers.flatMap((layer) =>
      layer.blend === 'height' ? [layer.material, layer.height] : [layer.material],
    ),
    ...root.sections.flatMap((section) => [
      section.heightTexture,
      section.weightTexture,
      section.material,
    ]),
  ];
  const pending = [...direct],
    assets = new Map<string, Asset>();
  while (pending.length) {
    const next = pending.pop();
    if (next === undefined) break;
    const guid = next.toLowerCase();
    if (assets.has(guid)) continue;
    const asset = registry.lookup<Asset>(guid);
    if (asset === undefined) return false;
    assets.set(guid, asset);
    for (const ref of registry.assetCatalog.get(guid)?.refs ?? []) pending.push(ref.guid);
    // Inline Standard materials have the same GUID values but need not carry refs metadata.
    if (asset.kind === 'material')
      for (const value of Object.values(asset.values ?? {})) {
        if (typeof value === 'string') pending.push(value);
        else if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          'texture' in value
        ) {
          if (typeof value.texture === 'string') pending.push(value.texture);
          if ('sampler' in value && typeof value.sampler === 'string') pending.push(value.sampler);
        }
      }
  }
  if (!terrainDerivedClosureValid(root, assets)) return false;
  roots.set(root, assets);
  return true;
}
export function terrainClosureCurrent(registry: AssetRegistry, root: TerrainAsset): boolean {
  const held = closures.get(registry)?.get(root);
  return held !== undefined && [...held].every(([guid, asset]) => registry.lookup(guid) === asset);
}
