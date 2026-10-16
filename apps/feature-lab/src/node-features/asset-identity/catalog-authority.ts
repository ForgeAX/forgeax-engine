import { buildCatalogResult } from '@forgeax/engine/import';
import { defineFeature } from '../../lab/feature';
import { type FixtureFiles, imageMeta, PNG_SIGNATURE, withFixture } from './support/fixture';

const TEXTURE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const TOOL = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02';
const PACKAGE = '0190a1b2-0000-7000-8000-00000000b001';

const samplerPack = JSON.stringify({
  schemaVersion: '3.0.0',
  packageId: PACKAGE,
  assets: { 'sampler/main': { kind: 'sampler', payload: {}, refs: [] } },
});
const toolMeta = (kind: string) =>
  JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'lab-tool',
    importSettings: {},
    subAssets: [{ guid: TOOL, sourceIndex: 0, sourceKey: 'main', kind }],
  });
const clean: FixtureFiles = {
  'sampler.pack.json': samplerPack,
  'hero.png': PNG_SIGNATURE,
  'hero.png.meta.json': imageMeta(TEXTURE),
};

async function project(files: FixtureFiles, importers: readonly string[] = []) {
  return withFixture(files, async (root) => {
    const result = await buildCatalogResult([root], '/', new Set(importers));
    return {
      authority: result.authority,
      codes: result.diagnostics.map((item) => item.code),
      kinds: result.entries.map((entry) => entry.kind).sort(),
    };
  });
}

export default defineFeature({
  title: 'Catalog authority',
  catalog: 'Catalog authority',
  kind: 'headless',
  summary:
    'Catalog projection reports authoritative/degraded plus structured diagnostics instead of posing as success.',
  expect:
    'A clean tree is authoritative; unknown providers, host kind conflicts, and scan failures degrade with codes.',
  async run(checks) {
    checks.equal('clean tree is authoritative with both rows', await project(clean), {
      authority: 'authoritative',
      codes: [],
      kinds: ['sampler', 'texture'],
    });

    const unknown = await project({
      ...clean,
      'tool.dat': 'x',
      'tool.dat.meta.json': toolMeta('lab-note'),
    });
    checks.equal('unregistered provider degrades but keeps valid rows', unknown, {
      authority: 'degraded',
      codes: ['catalog-raw-source-unsupported'],
      kinds: ['sampler', 'texture'],
    });

    const registered = await project(
      { ...clean, 'tool.dat': 'x', 'tool.dat.meta.json': toolMeta('lab-note') },
      ['lab-tool'],
    );
    checks.equal(
      'registered host provider is authoritative',
      [registered.authority, registered.kinds.length],
      ['authoritative', 3],
    );

    const reserved = await project({ 'tool.dat': 'x', 'tool.dat.meta.json': toolMeta('mesh') }, [
      'lab-tool',
    ]);
    checks.equal('host provider may not claim engine kinds', reserved.codes, [
      'catalog-host-kind-conflict',
    ]);

    const broken = await project({ ...clean, 'broken.pack.json': '{' });
    checks.equal('scan failure publishes no rows', broken, {
      authority: 'degraded',
      codes: ['catalog-scan-failed'],
      kinds: [],
    });
  },
});
