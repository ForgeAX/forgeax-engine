import { validateMeta } from '@forgeax/engine/pack';
import { scanInventory } from '@forgeax/engine/pack/scanner';
import { defineFeature } from '../../lab/feature';
import { errorCode, imageMeta, PNG_SIGNATURE, withFixture } from './support/fixture';

const GUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';

export default defineFeature({
  title: 'External Meta sidecar',
  catalog: 'External Meta sidecar',
  kind: 'headless',
  summary:
    'A `<source>.meta.json` next to an external file carries importer, subAsset GUIDs, and provenance.',
  expect:
    'A valid sidecar scans as a meta.json declaration; missing importer, bad GUID, or a missing source file fail fast.',
  async run(checks) {
    const provenance = { provider: 'feature-lab', version: '1.0.0' };
    checks.ok(
      'schema accepts importer + subAssets + provenance',
      validateMeta(JSON.parse(imageMeta(GUID, { provenance }))) === true,
    );

    await checks.run('valid sidecar becomes a meta.json declaration', () =>
      withFixture(
        { 'hero.png': PNG_SIGNATURE, 'hero.png.meta.json': imageMeta(GUID, { provenance }) },
        async (root) => {
          const result = await scanInventory([root]);
          if (!result.ok) throw new Error(`scan failed: ${result.error.code}`);
          const declaration = [...result.value.declarations.values()].find(
            (entry) => entry.format === 'meta.json',
          );
          if (declaration?.format !== 'meta.json') throw new Error('no meta.json declaration');
          return (
            declaration.value.importer === 'image' &&
            declaration.value.subAssets[0]?.guid === GUID &&
            declaration.value.provenance?.provider === 'feature-lab'
          );
        },
      ),
    );

    const withoutImporter = JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importSettings: {},
      subAssets: [],
    });
    checks.equal(
      'missing importer -> pack-malformed-meta',
      await withFixture(
        { 'hero.png': PNG_SIGNATURE, 'hero.png.meta.json': withoutImporter },
        async (root) => errorCode(await scanInventory([root])),
      ),
      'pack-malformed-meta',
    );
    checks.equal(
      'malformed subAsset guid -> pack-malformed-meta',
      await withFixture(
        { 'hero.png': PNG_SIGNATURE, 'hero.png.meta.json': imageMeta('not-a-guid') },
        async (root) => errorCode(await scanInventory([root])),
      ),
      'pack-malformed-meta',
    );
    checks.equal(
      'sidecar without its source file -> pack-orphan-meta',
      await withFixture({ 'hero.png.meta.json': imageMeta(GUID) }, async (root) =>
        errorCode(await scanInventory([root])),
      ),
      'pack-orphan-meta',
    );
  },
});
