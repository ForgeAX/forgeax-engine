// @perf-budget-skip: scans real template sources and resolves their portable closure.
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  ]);
  expect(host.map((record) => record.sourceKey)).toEqual(['plugin/host']);
  const guideMeta = JSON.parse(
    await readFile(resolve(root, 'assets/ui/guide.ui.html.meta.json'), 'utf8'),
  );
  expect(host[0]?.definition.asset.config).toMatchObject({
    guide: guideMeta.subAssets[0].guid,
  });
  expect(new Set([...engine, ...host].map((record) => record.sourcePath)).size).toBe(6);
  expect(
    engine.find((record) => record.sourceKey === 'plugin/player')?.definition.asset.config,
  ).toMatchObject({ speed: 5.5, jumpSpeed: 6.25, gravity: 17, walk: expect.any(String) });

  const ui = await collectAuthorPackClosure(root, 'assets/ui/ui.pack.ts', ['assets']);
  const uiFiles = ui.files.map((file) => file.path);
  expect(uiFiles).toEqual(
    expect.arrayContaining([
      'assets/ui/ui.pack.ts',
      'assets/ui/guide.ui.html',
      'assets/ui/guide.ui.css',
      'assets/ui/guide.ui.html.meta.json',
    ]),
  );
  expect(uiFiles).not.toContain('assets/game.pack.ts');
  expect(uiFiles).not.toContain('assets/player/player.pack.ts');

  const game = await collectAuthorPackClosure(root, 'assets/game.pack.ts', ['assets']);
  const gameFiles = game.files.map((file) => file.path);
  expect(gameFiles).toEqual(
    expect.arrayContaining([
      'assets/physics.pack.json',
      'assets/world/world.pack.ts',
      'assets/player/player.pack.ts',
      'assets/player/player.ts',
      'assets/camera/camera.pack.ts',
      'assets/player/character.pack.ts',
      'assets/scene.pack.ts',
    ]),
  );
  expect(gameFiles).not.toContain('assets/ui/ui.pack.ts');
}, 60_000);

it('resolves the template behavior closure when only its asset root is copied', async () => {
  const project = await mkdtemp(resolve(tmpdir(), 'forgeax-template-assets-'));
  try {
    await cp(resolve(root, 'assets'), resolve(project, 'assets'), { recursive: true });
    await mkdir(resolve(project, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(root, '../../packages/engine'),
      resolve(project, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(
      resolve(project, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { '@forgeax/engine': '*' },
      }),
    );
    const manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
    const inventory = await discoverPluginAssets({ root: project, assetRoots: ['assets'] });
    expect(
      pluginAssetClosure(inventory, manifest.roots.engine)
        .map((record) => record.sourceKey)
        .sort(),
    ).toEqual([
      'plugin/camera',
      'plugin/engine',
      'plugin/physics',
      'plugin/player',
      'plugin/scene',
    ]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 60_000);
