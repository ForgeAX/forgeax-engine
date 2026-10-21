import {
  AssetRegistry,
  type CatalogSource,
  createCatalogSource,
} from '@forgeax/engine/assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import { samplerContribution } from '@forgeax/engine/render';
import { type CatalogEntry, ok } from '@forgeax/engine/types';
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

const publication = createRuntimePackPublication({
  pack: PACK,
  scopeId: 'asset-runtime',
  sourcePath: 'lazy',
  sourceRevision: 'fixture',
  packageUrl: PACKAGE_URL,
});

const fetcher = (async (input: RequestInfo | URL) =>
  String(input) === PACKAGE_URL
    ? new Response(JSON.stringify(publication.pack))
    : new Response('', { status: 404 })) as typeof fetch;

function code(error: unknown): string {
  return String((error as { code?: unknown }).code);
}

export default defineFeature({
  title: 'Lazy import transport',
  catalog: 'Lazy import transport',
  kind: 'headless',
  summary:
    'A declared unpublished Catalog output routes through the injected ImportTransport. The fake transport "imports" by publishing the row and returning it for the incremental catalog patch; the shipped form has no transport and fails fast.',
  expect:
    'A declared unpublished output requests fetchPack once, then loads the GUID. A refused publication is asset-package-invalid with the producer reason; an undeclared GUID is asset-not-found without calling the producer.',
  async run(checks) {
    const rows: CatalogEntry[] = [GUID, REFUSED].map((guid) => ({
      guid,
      kind: 'sampler',
      lifecycle: 'missing',
      packageUrl: PACKAGE_URL,
      sourcePath: 'lazy',
    }));
    const requested: string[] = [];
    const studio = new AssetRegistry();
    const transportSource = createCatalogSource({
      entries: rows,
      importTransport: {
        fetchPack: async (guid) => {
          requested.push(guid);
          if (guid !== GUID) return { ok: false };
          const row = {
            guid: GUID,
            kind: 'sampler',
            packageUrl: PACKAGE_URL,
            sourcePath: 'lazy',
            publication: publication.publication,
          };
          rows.push(row);
          return { ok: true, entries: [row] };
        },
      },
    });
    studio.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    studio.setCatalogSource(transportSource, fetcher);
    const loaded = await studio.load(GUID, 'sampler');
    checks.ok(
      'studio miss loads through the transport',
      loaded.ok,
      loaded.ok ? undefined : code(loaded.error),
    );
    checks.equal('fetchPack called once for the miss', requested, [GUID]);
    const refused = await studio.load(REFUSED, 'sampler');
    checks.ok('refused import fails', !refused.ok);
    if (!refused.ok) {
      checks.equal('refused publication code', code(refused.error), 'asset-package-invalid');
      checks.ok(
        'refusal preserves the producer reason',
        JSON.stringify(refused.error).includes('asset-not-imported'),
      );
    }
    studio.dispose();

    const shipped = new AssetRegistry();
    shipped.setCatalogSource(source([]), fetcher);
    const miss = await shipped.load(GUID, 'sampler');
    checks.ok('shipped miss fails fast', !miss.ok);
    if (!miss.ok) checks.equal('shipped miss code', code(miss.error), 'asset-not-found');
    shipped.dispose();
  },
});
