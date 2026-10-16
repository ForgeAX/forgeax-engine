import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { build } from 'esbuild';

it('shows Pack source keys while retaining asset identity and other names', async () => {
  const bundled = await build({
    entryPoints: [resolve(import.meta.dirname, '../packages/view-plugin-content-browser/src/ui/workspace-catalog.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { projectCatalog } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const catalog = projectCatalog('/project', [
    { guid: 'pack-guid', kind: 'mesh', sourcePath: 'assets/props.pack.ts', sourceKey: 'mesh/barrel', name: 'Old name' },
    { guid: 'fallback-guid', kind: 'mesh', sourcePath: 'assets/props.pack.ts' },
    { guid: 'image-guid', kind: 'texture', sourcePath: 'assets/sky.png', sourceKey: 'texture/sky', name: 'Sky' },
  ]);
  const assets = catalog.files.flatMap((file) => file.assets);
  assert.deepEqual(assets.map(({ guid, name }) => [guid, name]), [
    ['pack-guid', 'mesh/barrel'],
    ['fallback-guid', 'fallback-guid'],
    ['image-guid', 'Sky'],
  ]);
});

it('projects the Game 3D fixture source counts and directory tree', async () => {
  const [scenarioBundle, catalogBundle] = await Promise.all([
    build({ entryPoints: [resolve(import.meta.dirname, '../apps/view-fixture-host/src/scenarios/default.ts')], bundle: true, platform: 'node', format: 'esm', write: false }),
    build({ entryPoints: [resolve(import.meta.dirname, '../packages/view-plugin-content-browser/src/ui/workspace-catalog.ts')], bundle: true, platform: 'node', format: 'esm', write: false }),
  ]);
  const scenario = await import(`data:text/javascript;base64,${Buffer.from(scenarioBundle.outputFiles[0].contents).toString('base64')}`);
  const { projectCatalog } = await import(`data:text/javascript;base64,${Buffer.from(catalogBundle.outputFiles[0].contents).toString('base64')}`);
  const catalog = projectCatalog(scenario.PROJECT_ROOT, scenario.ASSETS);
  const counts = new Map(catalog.files.map(file => [file.path, file.assets.length]));
  assert.equal(scenario.PROJECT.name, 'Game 3D');
  for (const [path, count] of [
    ['assets/environment.pack.ts', 1], ['assets/fantasy-meshes.pack.ts', 3],
    ['assets/game.pack.ts', 1], ['assets/geometry.pack.ts', 8],
    ['assets/materials.pack.ts', 15], ['assets/physics.pack.json', 1],
    ['assets/scene.pack.ts', 1], ['assets/guide.ui.html', 1],
  ]) assert.equal(counts.get(path), count, path);
  for (const folder of ['assets/camera', 'assets/player', 'assets/runtime-vase', 'assets/ui', 'assets/world']) {
    assert(catalog.folders.some(item => item.path === folder), folder);
  }
});

it('promotes one output to its asset card while retaining empty and multiple-output sources', async () => {
  const bundled = await build({
    entryPoints: [resolve(import.meta.dirname, '../packages/view-plugin-content-browser/src/ui/derived-view.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  const { deriveViewItems } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const files = [0, 1, 2].map((count) => ({
    type: 'file', path: `assets/pack-${count}.pack.json`, diskPath: `assets/pack-${count}.pack.json`,
    name: `pack-${count}.pack.json`, family: 'pack', isAssetPackage: true, kindLabel: '',
    assets: Array.from({ length: count }, (_, index) => ({
      type: 'asset', guid: `asset-${count}-${index}`, kind: 'mesh', name: `mesh-${index}`,
      packPath: `assets/pack-${count}.pack.json`,
    })),
  }));
  const derive = (expandedPacks) => deriveViewItems({
    folders: [], files, currentPath: 'assets', searchQuery: '',
    activeFamilies: new Set(), activeKinds: new Set(), sortState: { key: 'name', dir: 'asc' },
    expandedPacks, withKindLabel: (file) => file,
  }).viewItems;
  assert.deepEqual(derive(new Set()).map((item) => item.type), ['file', 'asset', 'file']);
  assert.deepEqual(derive(new Set(files.map((file) => file.path))).map((item) => item.type),
    ['file', 'asset', 'file', 'asset', 'asset']);
  const filtered = deriveViewItems({
    folders: [], files, currentPath: 'assets', searchQuery: 'no-match',
    activeFamilies: new Set(['texture']), activeKinds: new Set(['texture']),
    sortState: { key: 'name', dir: 'asc' }, expandedPacks: new Set(),
    withKindLabel: file => file, revealPath: 'assets/pack-1.pack.json',
  });
  assert.deepEqual(filtered.viewItems.map(item => item.type === 'asset' ? item.guid : item.path),
    ['asset-1-0']);
  assert.equal(filtered.searchActive, true, 'the search preference stays active during reveal');
  assert.equal(filtered.kindFilterActive, true, 'the kind preference stays active during reveal');
});

it('filters mixed Pack outputs by their asset file types', async () => {
  const bundled = await build({
    entryPoints: [resolve(import.meta.dirname, '../packages/view-plugin-content-browser/src/ui/derived-view.ts')],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  const { deriveViewItems } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const packPath = 'assets/game.pack.ts';
  const file = {
    type: 'file', path: packPath, diskPath: packPath, name: 'game.pack.ts',
    family: 'pack', isAssetPackage: true, kindLabel: '',
    assets: ['scene', 'audio', 'mesh', 'texture'].map(kind => ({
      type: 'asset', guid: kind, kind, name: kind, packPath,
    })),
  };
  const filtered = (families, kinds = [], searchQuery = '') => deriveViewItems({
    folders: [], files: [file], currentPath: 'assets', searchQuery,
    activeFamilies: new Set(families), activeKinds: new Set(kinds),
    sortState: { key: 'name', dir: 'asc' }, expandedPacks: new Set(),
    withKindLabel: value => value,
  }).viewItems.map(item => item.type === 'asset' ? item.guid : item.path);
  assert.deepEqual(filtered(['scene']), ['scene']);
  assert.deepEqual(filtered(['audio']), ['audio']);
  assert.deepEqual(filtered(['model']), ['mesh']);
  assert.deepEqual(filtered(['image']), ['texture']);
  assert.deepEqual(filtered(['scene', 'audio']), ['scene', 'audio']);
  assert.deepEqual(filtered(['pack']), [packPath]);
  assert.deepEqual(filtered(['pack'], ['audio']), ['audio']);
  assert.deepEqual(filtered(['scene'], ['audio']), []);
  assert.deepEqual(filtered(['scene'], [], 'audio'), []);
  assert.deepEqual(filtered(['scene'], [], 'scene'), ['scene']);
  assert.deepEqual(filtered(['pack'], [], 'audio'), [packPath, 'audio']);
});

it('projects Pack source inventory even with no published assets or a broken sibling', async () => {
  const bundled = await build({
    entryPoints: [resolve(import.meta.dirname, '../packages/view-plugin-content-browser/src/ui/workspace-catalog.ts')],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  const { projectCatalog } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const catalog = projectCatalog('/project', [], [
    { sourcePath: 'assets/empty.pack.json', revision: 'sha256:empty' },
    { sourcePath: 'assets/bad.pack.json', revision: 'sha256:bad', diagnostic: { code: 'pack-malformed-meta', hint: 'invalid JSON' } },
  ]);
  assert.deepEqual(catalog.files.map(file => file.path), ['assets/empty.pack.json', 'assets/bad.pack.json']);
  assert.deepEqual(catalog.files.map(file => file.assets.length), [0, 0]);
  assert.equal(catalog.files[1].diagnostic.code, 'pack-malformed-meta');
});

it('keeps descendants beside their parents and hides every collapsed ancestor', async () => {
  const bundled = await build({
    entryPoints: [resolve(import.meta.dirname, '../packages/view-plugin-content-browser/src/ui/workspace-catalog.ts')],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  const { projectCatalog, visibleCatalogFolders } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  const { folders } = projectCatalog('/project', [
    { guid: 'one', kind: 'mesh', path: 'assets/z/mesh.pack.ts' },
    { guid: 'internal', kind: 'mesh', path: '.forgeax/generated/serve-proof/engine-builtins.pack.json' },
    { guid: 'two', kind: 'scene', path: 'assets/a/scene.pack.ts' },
    { guid: 'sibling', kind: 'mesh', path: 'assets-other/main.pack.ts' },
  ]);
  const paths = collapsed => visibleCatalogFolders(folders, new Set(collapsed)).map(folder => folder.path);
  assert.deepEqual(paths([]), ['.forgeax', '.forgeax/generated', '.forgeax/generated/serve-proof', 'assets', 'assets/a', 'assets/z', 'assets-other']);
  assert.deepEqual(paths(['.forgeax', 'assets']), ['.forgeax', 'assets', 'assets-other']);
  assert.deepEqual(paths(['.forgeax/generated']), ['.forgeax', '.forgeax/generated', 'assets', 'assets/a', 'assets/z', 'assets-other']);
});
