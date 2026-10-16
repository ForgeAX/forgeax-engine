import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId } from '@forgeax/engine/pack/source';

// Fixture-owned namespaces must not collide with the Engine game-3d template.
const proofPackageId = definePackageId('019f6ad2-a101-7000-8000-000000000000');
const scenePackageId = definePackageId('019fb7ce-3900-7000-8000-000000000000');

/** The real game and UI proof modules are selected through asset roots. */
export async function writeProofGameAssets(root, { ui = false } = {}) {
  const key = 'plugin/game';
  const uiKey = 'plugin/ui';
  const assets = {
    [key]: { kind: 'plugin', payload: {
      module: { specifier: './game.plugin.ts' },
      config: { scene: { $asset: AssetGuid.format(AssetGuid.derive(scenePackageId, 'scene/proof')) } },
    } },
    ...(ui ? { [uiKey]: { kind: 'plugin', payload: { module: { specifier: './ui.plugin.ts' } } } } : {}),
  };
  await writeFile(join(root, 'assets/proof-plugins.pack.json'), JSON.stringify({
    schemaVersion: '3.0.0', packageId: AssetGuid.format(proofPackageId), assets,
  }));
  return {
    engine: AssetGuid.format(AssetGuid.derive(proofPackageId, key)),
    ...(ui ? { frontend: AssetGuid.format(AssetGuid.derive(proofPackageId, uiKey)) } : {}),
  };
}
