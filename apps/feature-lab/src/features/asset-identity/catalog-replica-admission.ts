import { AssetRegistry, CatalogReplica, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { defineFeature } from '../../lab/feature';

const GUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4d01';
const URL_ = 'https://feature-lab.invalid/catalog.json';
const SCOPE = { scopeId: 'lab-scope', generation: 2 };
const REVISION = { digest: 'sha256:r1', observedAt: 10, rootId: 'lab' };
const entry = {
  guid: GUID,
  kind: 'sampler',
  packageUrl: '/lab.pack.json',
  sourcePath: 'lab.pack.json',
  revision: REVISION,
};

function fetcher(body: unknown, counter: { count: number }): typeof fetch {
  return (async () => {
    counter.count += 1;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const scoped = (scope: typeof SCOPE, authority = 'authoritative') => ({
  schemaVersion: 'runtime-catalog-snapshot-v1',
  ...scope,
  authority,
  diagnostics: [],
  entries: [entry],
});

async function admit(source: ReturnType<typeof createCatalogSource>) {
  const replica = new CatalogReplica(source);
  const result = await replica.start();
  const snapshot = replica.snapshot();
  replica.dispose();
  return {
    code: result.ok ? 'ok' : result.error.code,
    rows: snapshot.entries.length,
    stale: snapshot.stale,
  };
}

export default defineFeature({
  title: 'Catalog replica admission',
  catalog: 'Catalog replica admission',
  kind: 'headless',
  summary:
    'Sources with expectedScope/expectedRevision re-enumerate and must pass admission before exposing rows.',
  expect:
    'Matching scope and revision are admitted; mismatches, degraded snapshots, and cached unscoped rows are rejected.',
  async run(checks) {
    const hits = { count: 0 };
    checks.equal(
      'matching scope is admitted',
      await admit(
        createCatalogSource({
          url: URL_,
          fetch: fetcher(scoped(SCOPE), hits),
          expectedScope: SCOPE,
        }),
      ),
      { code: 'ok', rows: 1, stale: false },
    );
    const wrongScope = await admit(
      createCatalogSource({
        url: URL_,
        fetch: fetcher(scoped({ ...SCOPE, generation: 1 }), hits),
        expectedScope: SCOPE,
      }),
    );
    checks.equal(
      'older generation is rejected with no rows',
      [wrongScope.code, wrongScope.rows],
      ['asset-parse-failed', 0],
    );
    const degraded = await admit(
      createCatalogSource({
        url: URL_,
        fetch: fetcher(scoped(SCOPE, 'degraded'), hits),
        expectedScope: SCOPE,
      }),
    );
    checks.equal(
      'degraded scoped snapshot is rejected',
      [degraded.code, degraded.rows],
      ['asset-parse-failed', 0],
    );
    checks.equal(
      'matching revision is admitted',
      (await admit(createCatalogSource({ entries: [entry], expectedRevision: REVISION }))).code,
      'ok',
    );
    checks.equal(
      'mismatched revision is rejected',
      (
        await admit(
          createCatalogSource({
            entries: [entry],
            expectedRevision: { ...REVISION, observedAt: 11 },
          }),
        )
      ).code,
      'asset-parse-failed',
    );

    const assets = new AssetRegistry({} as never);
    const shared = { count: 0 };
    assets.setCatalogSource(createCatalogSource({ url: URL_, fetch: fetcher([entry], shared) }));
    const baseline = await assets.enumerateCatalog();
    checks.equal(
      'unscoped URL baseline is accepted',
      baseline.ok ? baseline.value.length : baseline.error.code,
      1,
    );
    assets.setCatalogSource(
      createCatalogSource({
        url: URL_,
        fetch: fetcher(scoped({ ...SCOPE, generation: 9 }), shared),
        expectedScope: SCOPE,
      }),
    );
    const constrained = await assets.enumerateCatalog();
    checks.equal(
      'scoped source rejects instead of reusing cached rows',
      constrained.ok ? 'ok' : constrained.error.code,
      'asset-parse-failed',
    );
    checks.equal(
      'rejected source exposes no accepted rows',
      assets.catalogSnapshot()?.entries.length ?? 0,
      0,
    );
    checks.ok(
      'scoped source re-enumerated its own URL',
      shared.count >= 2,
      `fetches=${shared.count}`,
    );
    assets.clearCatalogSource();
  },
});
