import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import type { SamplerAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

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
  title: 'loadByGuid',
  catalog: '`loadByGuid`',
  kind: 'headless',
  summary:
    'An AssetRegistry with an in-memory Catalog row and a fetcher serving a Pack v2 body loads a sampler by GUID and returns the concrete SamplerAsset POD.',
  expect:
    'The GUID resolves to kind "sampler" with the authored filters, a second load reuses the ready payload without fetching, and an uncatalogued GUID fails with a structured code.',
  async run(checks) {
    let fetches = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      fetches++;
      return String(input) === PACKAGE_URL
        ? new Response(JSON.stringify(PACK))
        : new Response('', { status: 404 });
    }) as typeof fetch;
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(
      createCatalogSource({
        entries: [{ guid: GUID, kind: 'sampler', packageUrl: PACKAGE_URL, sourcePath: 'sampler' }],
      }),
      fetcher,
    );
    const first = await registry.loadByGuid<SamplerAsset>(registry.parseGuid(GUID));
    checks.ok(
      'loadByGuid ok',
      first.ok,
      first.ok ? undefined : String((first.error as { code?: unknown }).code),
    );
    if (first.ok) {
      checks.equal('concrete POD kind', first.value.kind, 'sampler');
      checks.equal('authored magFilter', first.value.magFilter, 'nearest');
      checks.equal('authored addressModeV', first.value.addressModeV, 'clamp-to-edge');
    }
    const second = await registry.loadByGuid<SamplerAsset>(registry.parseGuid(GUID));
    checks.ok('second load ok', second.ok);
    checks.equal('ready payload is reused (one fetch)', fetches, 1);
    const missing = await registry.loadByGuid(registry.parseGuid(UNKNOWN));
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
    registry.clearCatalogSource();
  },
});
