import { fileURLToPath } from 'node:url';
import { scanInventory, STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS } from '@forgeax/engine-pack/build';
import { describe, expect, it } from 'vitest';
import terrainPack from '../assets/water-r0-base-terrain.pack';
import recipePack from '../assets/water-r0-recipes.pack';
import { waterR0TerrainGuid } from '../src/surface-standard-evidence-identity';

describe('Water R0 Pack closure', () => {
  it('admits Water packs and template player/world through the same Catalog scan', async () => {
    const inventory = await scanInventory(
      [
        fileURLToPath(new URL('../assets/water-r0-base-terrain.pack.ts', import.meta.url)),
        fileURLToPath(new URL('../assets/water-r0-recipes.pack.ts', import.meta.url)),
        fileURLToPath(new URL('../../../templates/game-3d/assets/player/player.pack.ts', import.meta.url)),
        fileURLToPath(new URL('../../../templates/game-3d/assets/world/world.pack.ts', import.meta.url)),
      ],
      { scriptablePack: STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS },
    );
    expect(inventory.ok, inventory.ok ? undefined : JSON.stringify(inventory.error)).toBe(true);
    if (!inventory.ok) return;
    expect(inventory.value.declarations.size).toBe(4);
  });

  it('publishes the built Terrain root at the GUID used by the BrushRecipe', async () => {
    const terrain = await terrainPack.build(undefined as never);
    const recipes = await recipePack.build(undefined as never);
    expect(terrain.ok).toBe(true);
    expect(recipes.ok).toBe(true);
    if (!terrain.ok || !recipes.ok) return;

    expect(Object.keys(terrain.value)).toContain('terrain/base');
    expect(Object.keys(terrain.value)).not.toContain('terrain');
    expect(terrain.value['terrain/base']).toMatchObject({ kind: 'terrain', columns: 8, rows: 8, spacing: 1 });
    expect(recipes.value['water/brush/river']).toMatchObject({ baseTerrainGuid: waterR0TerrainGuid('terrain/base') });
  });
});
