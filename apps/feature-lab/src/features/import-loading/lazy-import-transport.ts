import { AssetRegistry, type CatalogSource } from '@forgeax/engine/assets-runtime';
import { type CatalogEntry, ok, type SamplerAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const GUID = '019f1a00-0000-7000-8000-0000000000e1';
const REFUSED = '019f1a00-0000-7000-8000-0000000000e2';
const PACKAGE_URL = 'https://feature-lab.invalid/lazy/pack.json';

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    { guid: GUID, kind: 'sampler', payload: { magFilter: 'linear' }, refs: [], artifacts: {} },
  ],
};

function source(rows: CatalogEntry[]): CatalogSource {
  return { enumerate: async () => ok([...rows]), subscribe: () => () => {} };
}

const fetcher = (async (input: RequestInfo | URL) =>
  String(input) === PACKAGE_URL
    ? new Response(JSON.stringify(PACK))
    : new Response('', { status: 404 })) as typeof fetch;

function code(error: unknown): string {
  return String((error as { code?: unknown }).code);
}

export default defineFeature({
  title: 'Lazy import transport',
  catalog: 'Lazy import transport',
  kind: 'headless',
  summary:
    'A catalog miss routes through the injected ImportTransport (studio form). The fake transport "imports" by publishing the row and returning it for the incremental catalog patch; the shipped form has no transport and fails fast.',
  expect:
    'With a transport, the first miss calls fetchPack once and then loads the GUID; a refused import is asset-not-imported; without a transport the same miss is asset-not-imported and fetchPack is never reached.',
  async run(checks) {
    const rows: CatalogEntry[] = [];
    const requested: string[] = [];
    const studio = new AssetRegistry({} as never, {
      fetchPack: async (guid) => {
        requested.push(guid);
        if (guid !== GUID) return { ok: false };
        const row = { guid: GUID, kind: 'sampler', packageUrl: PACKAGE_URL, sourcePath: 'lazy' };
        rows.push(row);
        return { ok: true, entries: [row] };
      },
    });
    studio.setCatalogSource(source(rows), fetcher);
    const loaded = await studio.loadByGuid<SamplerAsset>(studio.parseGuid(GUID));
    checks.ok(
      'studio miss loads through the transport',
      loaded.ok,
      loaded.ok ? undefined : code(loaded.error),
    );
    checks.equal('fetchPack called once for the miss', requested, [GUID]);
    const refused = await studio.loadByGuid(studio.parseGuid(REFUSED));
    checks.ok('refused import fails', !refused.ok);
    if (!refused.ok) checks.equal('refused import code', code(refused.error), 'asset-not-imported');
    studio.clearCatalogSource();

    const shipped = new AssetRegistry({} as never);
    shipped.setCatalogSource(source([]), fetcher);
    const miss = await shipped.loadByGuid(shipped.parseGuid(GUID));
    checks.ok('shipped miss fails fast', !miss.ok);
    if (!miss.ok) checks.equal('shipped miss code', code(miss.error), 'asset-not-imported');
    shipped.clearCatalogSource();
  },
});
