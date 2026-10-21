import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { samplerContribution } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { installMemoryPack } from '../asset-formats/fixtures/memory-pack';

const GUID = '019f1a00-0000-7000-8000-0000000000d1';
const UNKNOWN = '019f1a00-0000-7000-8000-0000000000d2';
const PACKAGE_URL = 'https://feature-lab.invalid/sampler/pack.json';

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: GUID,
      kind: 'sampler',
      payload: {
        magFilter: 'nearest',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'clamp-to-edge',
      },
      refs: [],
      artifacts: {},
    },
  ],
};

export default defineFeature({
  title: 'Load by GUID',
  catalog: '`AssetRegistry.load`',
  kind: 'headless',
  summary:
    'An AssetRegistry with an in-memory Catalog row and a fetcher serving a Pack v2 body loads a sampler by GUID and returns its owner-scoped runtime handle.',
  expect:
    'The GUID resolves to kind "sampler" with the authored filters, a second load retains the same runtime identity without fetching, and an uncatalogued GUID fails with a structured code.',
  async run(checks) {
    const registry = new AssetRegistry();
    registry.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const { fetched } = await installMemoryPack(registry, PACK.assets, PACKAGE_URL);
    const first = await registry.load(GUID, 'sampler');
    checks.ok(
      'load returns a runtime handle',
      first.ok,
      first.ok ? undefined : String((first.error as { code?: unknown }).code),
    );
    if (first.ok) {
      const payload = registry.read(first.value).unwrap();
      checks.equal('concrete POD kind', payload.kind, 'sampler');
      checks.equal('authored magFilter', payload.magFilter, 'nearest');
      checks.equal('authored addressModeV', payload.addressModeV, 'clamp-to-edge');
    }
    const second = await registry.load(GUID, 'sampler');
    checks.ok('second load ok', second.ok);
    checks.ok(
      'repeated load retains the same identity',
      first.ok && second.ok && first.value === second.value,
    );
    checks.equal('ready source is reused (one fetch)', fetched.length, 1);
    const missing = await registry.load(UNKNOWN, 'sampler');
    checks.ok('uncatalogued GUID fails', !missing.ok);
    if (!missing.ok) {
      const code = String((missing.error as { code?: unknown }).code);
      checks.ok(
        'structured miss code',
        code === 'asset-not-found' || code === 'asset-not-imported',
        code,
      );
    }
    await checks.run('malformed GUID is rejected at parse', () => {
      try {
        registry.parseGuid('not-a-guid');
        return false;
      } catch (error) {
        return (error as { code?: unknown }).code === 'asset-parse-failed'
          ? 'asset-parse-failed'
          : false;
      }
    });
    registry.dispose();
  },
});
