import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { definePackageId, parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine/pack/source';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('empty template authoring contract', () => {
  it('has a strict project manifest', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      schemaVersion?: string;
      assetLibraries?: readonly string[];
      roots: { engine?: string };
    };
    expect(manifest.schemaVersion).toBe('3.0.0');
    expect(manifest.assetLibraries).toEqual(['@forgeax/engine/content']);
    expect(AssetGuid.parse(manifest.roots.engine ?? '').ok).toBe(true);
    await expect(access(resolve(root, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Starter content: delete this test together with assets/scene-owner.pack.ts
  // and assets/world/ when the game replaces the starter scene.
  it('ships an entity-free starter scene rooted at its scene owner', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      roots: { engine?: string };
    };
    // Mirrors the packageId declared in assets/scene-owner.pack.ts.
    const sceneOwnerPackage = definePackageId('019fb7ce-1100-7000-8000-000000000000');
    expect(manifest.roots.engine).toBe(
      AssetGuid.format(AssetGuid.derive(sceneOwnerPackage, 'plugin/scene')),
    );
    const scene = parsePackSourceJson(
      JSON.parse(await readFile(resolve(root, 'assets/world/world.scene.pack.json'), 'utf8')),
    ).unwrap();
    if (scene.format !== 'direct') throw new Error('The starter scene must be a direct Pack');
    const assets = projectDirectPackJson(scene).assets;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      guid: 'ee7f6b3d-74ee-54e9-a62a-97d3fc58f125',
      kind: 'scene',
      sourceKey: 'world/empty',
      payload: { kind: 'scene', entities: {} },
      refs: [],
    });
    const payload = assets[0]?.payload as { readonly entities: Record<string, unknown> };
    expect(Object.keys(payload.entities)).toHaveLength(0);
  });
});
