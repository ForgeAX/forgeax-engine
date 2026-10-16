import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import sceneOwner from '../scene-owner.pack.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('empty template authoring contract', () => {
  it('has a strict project manifest and an entity-free scene source', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      schemaVersion?: string;
      roots: { engine?: string };
    };
    expect(manifest.schemaVersion).toBe('3.0.0');
    expect(manifest.roots.engine).toBe(AssetGuid.format(AssetGuid.derive(sceneOwner.packageId, 'plugin/scene')));
    const scene = JSON.parse(
      await readFile(resolve(root, 'assets/world/world.scene.pack.json'), 'utf8'),
    ) as {
      readonly assets: readonly {
        readonly guid: string;
        readonly kind: string;
        readonly sourceKey: string;
        readonly payload: {
          readonly kind: string;
          readonly entities: Record<string, unknown>;
        };
        readonly refs: readonly string[];
      }[];
    };
    expect(scene.assets).toHaveLength(1);
    expect(scene.assets[0]).toMatchObject({
      guid: '019fb7ce-1000-7000-8000-000000000001',
      kind: 'scene',
      sourceKey: 'world/empty',
      payload: { kind: 'scene', entities: {} },
      refs: [],
    });
    expect(Object.keys(scene.assets[0]?.payload.entities ?? {})).toHaveLength(0);
    await access(resolve(root, 'assets/world/world.scene.pack.json'));
    await expect(access(resolve(root, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
