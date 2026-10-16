import type { AssetRef, SceneEntityRef } from '@forgeax/engine-types';
import type { AuthorInventory } from './declaration.js';

export function projectAssetRefs(inventory: AuthorInventory): readonly AssetRef[] {
  return inventory.declarations.map(
    (row) =>
      ({
        guid: row.guid,
        sourceKey: row.sourceKey,
        kind: row.kind,
      }) as AssetRef,
  );
}

/** Derive instance-relative scene refs from the same validated author rows. */
export function projectSceneEntityRefs(inventory: AuthorInventory): readonly SceneEntityRef[] {
  return inventory.declarations.flatMap((row) =>
    row.sceneEntityKeys === undefined
      ? []
      : row.sceneEntityKeys.map((address) => ({
          sceneSourceKey: row.sourceKey,
          address,
        })),
  );
}
