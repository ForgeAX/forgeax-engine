import { join } from 'node:path';
import {
  AssetGuid,
  definePack,
  definePackageId,
  SCRIPTABLE_PACK_ASSET_KINDS,
} from '@forgeax/engine/pack/source';
import { loadScriptablePack } from '@forgeax/engine/pack/source-node';
import { defineFeature } from '../../lab/feature';
import { withFixture } from './support/fixture';
import { GENERATOR_PACK_ID, GENERATOR_SOURCE, invokeBuild } from './support/scriptable';

const EXTERNAL_TABLE_SOURCE = `export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array(16).fill(5),
  externalAssets: [{ guid: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a31' }],
  build() { return { ok: true, value: {} }; },
};
`;

function definePackCode(input: unknown): string {
  try {
    definePack(input as Parameters<typeof definePack>[0]);
    return 'accepted';
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

export default defineFeature({
  title: 'ScriptablePack / Pack',
  catalog: 'ScriptablePack / Pack',
  kind: 'headless',
  summary:
    'A `*.pack.ts` default-exports definePack({ packageId, parameters, build }) and returns Assets keyed by sourceKey.',
  expect:
    'Parameters drive the output set, GUIDs derive from packageId + sourceKey, output GUID / externalAssets tables are rejected.',
  async run(checks) {
    const packageId = definePackageId(GENERATOR_PACK_ID);
    const build = () => ({ ok: true as const, value: {} });
    checks.equal(
      'definePack accepts the v2 shape',
      definePackCode({ schemaVersion: '2.0.0', packageId, build }),
      'accepted',
    );
    checks.equal(
      'definePack rejects an externalAssets table',
      definePackCode({ schemaVersion: '2.0.0', packageId, externalAssets: [], build }),
      'pack-parameter-invalid',
    );
    checks.equal(
      'definePack rejects an explicit outputs table',
      definePackCode({ schemaVersion: '2.0.0', packageId, outputs: {}, build }),
      'pack-parameter-invalid',
    );
    checks.ok(
      'mesh and material are scriptable output kinds',
      SCRIPTABLE_PACK_ASSET_KINDS.includes('mesh') &&
        SCRIPTABLE_PACK_ASSET_KINDS.includes('material'),
    );

    await withFixture(
      { 'generator.pack.ts': GENERATOR_SOURCE, 'external.pack.ts': EXTERNAL_TABLE_SOURCE },
      async (root) => {
        const loaded = await loadScriptablePack(join(root, 'generator.pack.ts'));
        checks.ok(
          'isolated loader accepts the definePack module',
          loaded.ok,
          loaded.ok ? undefined : loaded.error.code,
        );
        if (loaded.ok) {
          checks.equal(
            'parameters are declared metadata',
            'parameters' in loaded.value ? loaded.value.parameters[0]?.name : undefined,
            'count',
          );
          const built = await invokeBuild(loaded.value, { count: 3 });
          checks.equal('build returns outputs keyed by sourceKey', Object.keys(built.value ?? {}), [
            'samplers/s0',
            'samplers/s1',
            'samplers/s2',
          ]);
          const reloaded = await loadScriptablePack(join(root, 'generator.pack.ts'));
          const again = reloaded.ok
            ? await invokeBuild(reloaded.value, { count: 1 })
            : { ok: false };
          checks.equal(
            'different parameter values change the output set',
            Object.keys(again.value ?? {}),
            ['samplers/s0'],
          );
          const guid = AssetGuid.format(AssetGuid.derive(loaded.value.packageId, 'samplers/s0'));
          checks.equal(
            'output identity derives from packageId + sourceKey',
            guid,
            AssetGuid.format(AssetGuid.derive(packageId, 'samplers/s0')),
          );
        }
        const external = await loadScriptablePack(join(root, 'external.pack.ts'));
        checks.equal(
          'isolated loader rejects a raw default export with externalAssets',
          external.ok ? 'accepted' : external.error.code,
          'pack-parameter-invalid',
        );
      },
    );
  },
});
