import { definePackageId } from '@forgeax/engine/pack';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { scanInventory } from '@forgeax/engine/pack/scanner';
import { defineFeature } from '../../lab/feature';
import {
  errorCode,
  type FixtureFiles,
  imageMeta,
  PNG_SIGNATURE,
  withFixture,
} from './support/fixture';

const PACKAGE = '0190a1b2-0000-7000-8000-00000000c001';
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(definePackageId(PACKAGE), key));
const G1 = guid('a');
const G2 = guid('b');
const sampler = (refs: readonly string[] = []) => ({ kind: 'sampler', payload: {}, refs });
const pack = (assets: Readonly<Record<string, ReturnType<typeof sampler>>>) =>
  JSON.stringify({ schemaVersion: '3.0.0', packageId: PACKAGE, assets });
const gltfMeta = (subAssets: readonly unknown[]) =>
  JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'gltf',
    importSettings: {},
    subAssets,
  });

const CASES: ReadonlyArray<readonly [string, FixtureFiles, string]> = [
  [
    'clean tree scans',
    {
      'a.pack.json': pack({ a: sampler() }),
      'hero.png': PNG_SIGNATURE,
      'hero.png.meta.json': imageMeta(G2),
    },
    'ok',
  ],
  ['unparsable pack.json', { 'a.pack.json': '{' }, 'pack-malformed-pack'],
  [
    'schema violation in meta',
    { 'hero.png': PNG_SIGNATURE, 'hero.png.meta.json': '{"schemaVersion":"1.0.0"}' },
    'pack-malformed-meta',
  ],
  [
    'duplicate GUID across Pack and Meta',
    {
      'a.pack.json': pack({ a: sampler() }),
      'hero.png': PNG_SIGNATURE,
      'hero.png.meta.json': imageMeta(G1),
    },
    'pack-guid-collision',
  ],
  [
    'duplicate packageId across two Packs',
    {
      'a.pack.json': JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: PACKAGE,
        assets: { a: { kind: 'sampler', payload: {}, refs: [] } },
      }),
      'b.pack.json': JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: PACKAGE,
        assets: { b: { kind: 'sampler', payload: {}, refs: [] } },
      }),
    },
    'pack-guid-collision',
  ],
  ['orphaned Meta', { 'hero.png.meta.json': imageMeta(G1) }, 'pack-orphan-meta'],
  [
    'subAssets without distinguishing sourceKey',
    {
      'hero.glb': PNG_SIGNATURE,
      'hero.glb.meta.json': gltfMeta([
        { guid: G1, sourceIndex: 0, kind: 'mesh' },
        { guid: G2, sourceIndex: 1, kind: 'mesh' },
      ]),
    },
    'pack-malformed-meta',
  ],
  [
    'reference cycle',
    { 'a.pack.json': pack({ a: sampler([G2]), b: sampler([G1]) }) },
    'pack-cyclic-reference',
  ],
];

export default defineFeature({
  title: 'Pack scanner',
  catalog: 'Pack scanner',
  kind: 'headless',
  summary:
    'scanInventory() walks asset roots and fails fast with one structured PackError per violation class.',
  expect: 'Each malformed fixture tree returns its PackError code; the clean tree scans ok.',
  async run(checks) {
    for (const [name, files, expected] of CASES) {
      checks.equal(
        name,
        await withFixture(files, async (root) => errorCode(await scanInventory([root]))),
        expected,
      );
    }
    await checks.run('blacklisted node_modules is skipped', () =>
      withFixture(
        { 'node_modules/x/a.pack.json': '{' },
        async (root) => errorCode(await scanInventory([root])) === 'ok',
      ),
    );
  },
});
