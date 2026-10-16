// @perf-budget-skip: scans real template sources and resolves their portable closure.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectAuthorPackClosure } from '@forgeax/engine-pack/build';
import { expect, it } from 'vitest';
import { discoverPluginAssets, pluginAssetClosure } from '../build/plugin-assets.js';

const root = resolve(import.meta.dirname, '../../../../templates/game-3d');

it('resolves feature-owned behavior Packs with separate engine and host closures', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
  const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  const engine = pluginAssetClosure(inventory, manifest.roots.engine);
  const host = pluginAssetClosure(inventory, manifest.roots.frontend);
  expect(engine.map((record) => record.sourceKey).sort()).toEqual([
    'plugin/camera',
    'plugin/engine',
    'plugin/physics',
    'plugin/player',
    'plugin/scene',
    'plugin/vase',
  ]);
  expect(host.map((record) => record.sourceKey)).toEqual(['plugin/host']);
  const guideMeta = JSON.parse(
    await readFile(resolve(root, 'assets/guide.ui.html.meta.json'), 'utf8'),
  );
  expect(host[0]?.definition.asset.config).toMatchObject({
    guide: guideMeta.subAssets[0].guid,
  });
  expect(new Set([...engine, ...host].map((record) => record.sourcePath)).size).toBe(7);
  expect(
    engine.find((record) => record.sourceKey === 'plugin/player')?.definition.asset.config,
  ).toMatchObject({ speed: 5.5, jumpSpeed: 6.25, gravity: 17, walk: expect.any(String) });

  const ui = await collectAuthorPackClosure(root, 'assets/ui/ui.pack.ts');
  const uiFiles = ui.files.map((file) => file.path);
  expect(uiFiles).toEqual(
    expect.arrayContaining([
      'assets/ui/ui.pack.ts',
      'assets/guide.ui.html',
      'assets/guide.ui.css',
      'assets/guide.ui.html.meta.json',
    ]),
  );
  expect(uiFiles).not.toContain('assets/game.pack.ts');
  expect(uiFiles).not.toContain('assets/player/player.pack.ts');

  const game = await collectAuthorPackClosure(root, 'assets/game.pack.ts');
  const gameFiles = game.files.map((file) => file.path);
  expect(gameFiles).toEqual(
    expect.arrayContaining([
      'assets/physics.pack.json',
      'assets/world/world.pack.ts',
      'assets/player/player.pack.ts',
      'assets/player/player.ts',
      'assets/camera/camera.pack.ts',
      'assets/character.pack.ts',
      'assets/scene.pack.ts',
    ]),
  );
  expect(gameFiles).not.toContain('assets/ui/ui.pack.ts');
}, 60_000);
