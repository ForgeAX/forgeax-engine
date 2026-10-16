// @perf-budget-skip: isolated Pack execution and real filesystem source closure.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { collectAuthorPackClosure } from '../author-closure.js';
import { AssetGuid, PackageId } from '../guid.js';

it('discovers instance outputs and computed module edges with their declaring source base', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-author-closure-'));
  try {
    await mkdir(resolve(root, 'assets/instances'), { recursive: true });
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(import.meta.dirname, '../..'),
      resolve(root, 'node_modules/@forgeax/engine-pack'),
      'dir',
    );
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'closure-test', dependencies: { '@forgeax/engine-pack': '*' } }),
    );
    const parent = '01900000-0000-7000-8000-000000000171';
    const instance = '01900000-0000-7000-8000-000000000172';
    await writeFile(
      resolve(root, 'assets/character.pack.ts'),
      `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${parent}'),
  parameters: [{ name: 'speed', type: 'f32', default: 2 }],
  build: ({ values }) => ({ ok: true, value: { ['plugin/' + 'player']: {
    kind: 'plugin', module: { specifier: './' + 'player.ts' }, config: { speed: values.speed }
  } } }) });`,
    );
    await writeFile(
      resolve(root, 'assets/player.ts'),
      "import './player.css'; export default { apply() {} };",
    );
    await writeFile(
      resolve(root, 'assets/player.css'),
      'body { background-image: url(texture.png); }',
    );
    await writeFile(resolve(root, 'assets/texture.png'), new Uint8Array([1, 2, 3]));
    await writeFile(
      resolve(root, 'assets/instances/player.pack.json'),
      JSON.stringify({ schemaVersion: '3.0.0', packageId: instance, parent, values: { speed: 5 } }),
    );
    const closure = await collectAuthorPackClosure(root, 'assets/instances/player.pack.json');
    expect(closure.files.map((file) => file.path)).toEqual([
      'assets/character.pack.ts',
      'assets/instances/player.pack.json',
      'assets/player.css',
      'assets/player.ts',
      'assets/texture.png',
    ]);
    const parsed = PackageId.parse(instance);
    if (!parsed.ok) throw parsed.error;
    const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'plugin/player'));
    expect(closure.identities.get(guid)).toEqual({
      packageId: instance,
      sourceKey: 'plugin/player',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('includes external Meta identities and their source resource closure without cooking', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-author-meta-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"meta-closure"}');
    const guid = '019fb7ce-3600-7000-8000-000000000001';
    await writeFile(
      resolve(root, 'assets/game.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000171',
        assets: {
          'plugin/ui': {
            kind: 'plugin',
            payload: {
              module: { specifier: './ui.ts' },
              config: { guide: { $asset: guid } },
            },
          },
        },
      }),
    );
    await writeFile(resolve(root, 'assets/ui.ts'), 'export default { apply() {} };');
    await writeFile(
      resolve(root, 'assets/guide.ui.html.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'ui',
        source: 'guide.ui.html',
        importSettings: {},
        subAssets: [{ guid, sourceIndex: 0, sourceKey: 'ui/guide', kind: 'ui' }],
      }),
    );
    await writeFile(resolve(root, 'assets/guide.ui.html'), '<img src="./icon.png">');
    await writeFile(resolve(root, 'assets/guide.ui.css'), 'main { background: url(./paper.png); }');
    await writeFile(resolve(root, 'assets/paper.png'), new Uint8Array([4, 5, 6]));
    await writeFile(resolve(root, 'assets/icon.png'), new Uint8Array([1, 2, 3]));
    const closure = await collectAuthorPackClosure(root, 'assets/game.pack.json');
    expect(closure.files.map((file) => file.path)).toEqual([
      'assets/game.pack.json',
      'assets/guide.ui.css',
      'assets/guide.ui.html',
      'assets/guide.ui.html.meta.json',
      'assets/icon.png',
      'assets/paper.png',
      'assets/ui.ts',
    ]);
    expect(closure.identities.get(guid)).toEqual({ sourceKey: 'ui/guide' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('follows authored shader module identities and their transitive imports', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-author-shaders-'));
  try {
    await mkdir(resolve(root, 'assets/shaders'), { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"name":"shader-closure"}');
    await writeFile(
      resolve(root, 'assets/material.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000171',
        assets: {
          material: {
            kind: 'material',
            refs: [],
            payload: {
              passes: [{ name: 'forward', program: { module: 'local::surface' } }],
            },
          },
        },
      }),
    );
    await writeFile(
      resolve(root, 'assets/shaders/surface.wgsl'),
      '#define_import_path local::surface\n#import local::noise::{noise}\n',
    );
    await writeFile(
      resolve(root, 'assets/shaders/noise.wgsl'),
      '#define_import_path local::noise\nfn noise() -> f32 { return 1.0; }\n',
    );
    await writeFile(
      resolve(root, 'assets/shaders/unrelated.wgsl'),
      '#define_import_path local::unrelated\n',
    );
    const closure = await collectAuthorPackClosure(root, 'assets/material.pack.json');
    expect(closure.files.map((file) => file.path)).toEqual([
      'assets/material.pack.json',
      'assets/shaders/noise.wgsl',
      'assets/shaders/surface.wgsl',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
