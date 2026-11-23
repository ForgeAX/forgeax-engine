import { definePackageId, parsePackSourceJson } from '@forgeax/engine/pack';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { parsePackV2 } from '@forgeax/engine/pack/runtime';
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
  assets: [{ guid: TRANSPORT_GUID, kind: 'sampler', payload: {}, refs: [], artifacts: {} }],
});

export default defineFeature({
  title: 'Pack source / transport',
  catalog: 'Pack source / transport',
  kind: 'headless',
  summary:
    'V3 direct and instance declarations are scanned as source. The runtime reader admits v2 output.',
  expect:
    'The direct output derives its GUID. Runtime v2 keeps the explicit GUID and is rejected as source.',
  async run(checks) {
    await checks.run('scanner admits authoring and skips Runtime Pack paths', () =>
      withFixture(
        { 'source.pack.json': direct, 'generated.runtime-pack.json': transport },
        async (root) => {
          const result = await scanInventory([root]);
          if (!result.ok) throw result.error;
          const [authored] = result.value.inventory;
          const derived = AssetGuid.format(
            AssetGuid.derive(definePackageId(PACKAGE), 'samplers/linear'),
          );
          return (
            result.value.inventory.length === 1 &&
            authored?.guid === derived &&
            authored.sourceKey === 'samplers/linear'
          );
        },
      ),
    );
    checks.equal(
      'runtime retains its explicit GUID',
      parsePackV2(JSON.parse(transport)).unwrap().assets[0]?.guid,
      TRANSPORT_GUID,
    );
    checks.equal(
      'scanner rejects v2 content at an authoring path',
      await withFixture({ 'generated.pack.json': transport }, async (root) =>
        errorCode(await scanInventory([root])),
      ),
      'pack-malformed-pack',
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
