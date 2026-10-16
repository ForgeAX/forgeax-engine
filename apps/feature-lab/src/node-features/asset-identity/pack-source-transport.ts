import { definePackageId, parsePackSourceJson } from '@forgeax/engine/pack';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { scanInventory } from '@forgeax/engine/pack/scanner';
import { defineFeature } from '../../lab/feature';
import { errorCode, withFixture } from './support/fixture';

const PACKAGE = '0190a1b2-0000-7000-8000-00000000a001';
const PARENT = '0190a1b2-0000-7000-8000-00000000a002';
const TRANSPORT_GUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11';

const direct = JSON.stringify({
  schemaVersion: '3.0.0',
  packageId: PACKAGE,
  assets: { 'samplers/linear': { kind: 'sampler', payload: {}, refs: [] } },
});
const transport = JSON.stringify({
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [{ guid: TRANSPORT_GUID, kind: 'sampler', payload: {}, refs: [] }],
});

export default defineFeature({
  title: 'Pack source / transport',
  catalog: 'Pack source / transport',
  kind: 'headless',
  summary:
    'The scanner tells v3 authoring (direct / instance) apart from v2 generated transport by schemaVersion.',
  expect:
    'v3 direct outputs get sourceKey-derived GUIDs, v2 transport keeps explicit GUIDs, mixed branches fail.',
  async run(checks) {
    await checks.run('scanner separates v3 direct from v2 transport', () =>
      withFixture(
        { 'source.pack.json': direct, 'generated.pack.json': transport },
        async (root) => {
          const result = await scanInventory([root]);
          if (!result.ok) throw new Error(`scan failed: ${result.error.code}`);
          const rows = result.value.inventory;
          const authored = rows.find((row) => row.sourcePath.endsWith('source.pack.json'));
          const generated = rows.find((row) => row.sourcePath.endsWith('generated.pack.json'));
          const derived = AssetGuid.format(
            AssetGuid.derive(definePackageId(PACKAGE), 'samplers/linear'),
          );
          if (authored?.guid !== derived || authored.sourceKey !== 'samplers/linear')
            return `authored=${JSON.stringify(authored)}`;
          if (generated?.guid !== TRANSPORT_GUID || generated.sourceKey !== undefined)
            return `generated=${JSON.stringify(generated)}`;
          const versions = [...result.value.declarations.values()].map((entry) =>
            entry.format === 'pack.json' ? entry.value.schemaVersion : entry.format,
          );
          return versions.includes('3.0.0') && versions.includes('2.0.0');
        },
      ),
    );

    const instance = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: PACKAGE,
      parent: PARENT,
      values: { width: 2 },
    });
    checks.equal(
      'v3 instance branch parses as instance',
      instance.ok ? instance.value.format : instance.error.code,
      'instance',
    );
    const both = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: PACKAGE,
      assets: {},
      parent: PARENT,
      values: {},
    });
    checks.equal(
      'assets + parent together is rejected',
      both.ok ? 'ok' : both.error.code,
      'pack-parameter-invalid',
    );
    checks.equal(
      'scanner rejects the mixed branch document',
      await withFixture(
        {
          'bad.pack.json': JSON.stringify({
            schemaVersion: '3.0.0',
            packageId: PACKAGE,
            assets: {},
            parent: PARENT,
          }),
        },
        async (root) => errorCode(await scanInventory([root])),
      ),
      'pack-malformed-pack',
    );
  },
});
