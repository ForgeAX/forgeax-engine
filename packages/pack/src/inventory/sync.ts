import type { AuthorInventory } from './declaration.js';

export type InventoryDigest = string;

export function inventoryDigest(inventory: AuthorInventory): InventoryDigest {
  return inventory.declarations
    .map(
      (row) =>
        `${row.guid}\0${row.sourceKey}\0${row.kind}\0${row.sceneEntityKeys?.join('\0') ?? ''}`,
    )
    .sort()
    .join('\n');
}

export function syncAuthorInventory(inventory: AuthorInventory): AuthorInventory {
  return {
    declarations: inventory.declarations.map((row) => ({
      ...row,
      refs: [...row.refs],
      ...(row.sceneEntityKeys === undefined ? {} : { sceneEntityKeys: [...row.sceneEntityKeys] }),
    })),
  };
}
