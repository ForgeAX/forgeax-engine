import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { defineFeature } from '../../lab/feature';

const GUID = '019f1a00-0000-7000-8000-0000000000b1';
const PACKAGE_URL = 'https://feature-lab.invalid/retry/pack.json';

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    { guid: GUID, kind: 'lab-retry', payload: { label: 'retried' }, refs: [], artifacts: {} },
  ],
};

interface Script {
  readonly statuses: readonly number[];
  readonly calls: { readonly cache: RequestCache | undefined }[];
}

async function load(statuses: readonly number[]) {
  const script: Script = { statuses, calls: [] };
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const status = script.statuses[script.calls.length] ?? 200;
    script.calls.push({ cache: init?.cache });
    return status === 200 ? new Response(JSON.stringify(PACK)) : new Response('', { status });
  }) as typeof fetch;
  const registry = new AssetRegistry({} as never);
  registry.loaders.registerPackLoader({
    kind: 'lab-retry',
    load: (input) => ({ kind: 'lab-retry', ...input.payload }),
  });
  registry.setCatalogSource(
    createCatalogSource({
      entries: [{ guid: GUID, kind: 'lab-retry', packageUrl: PACKAGE_URL, sourcePath: 'retry' }],
    }),
    fetcher,
  );
  const started = performance.now();
  const result = await registry.loadByGuid<{ label: string }>(registry.parseGuid(GUID));
  const elapsed = performance.now() - started;
  registry.clearCatalogSource();
  return { result, calls: script.calls, elapsed };
}

function describeError(error: unknown): { code: string; hint: string } {
  const value = error as { code?: unknown; hint?: unknown };
  return { code: String(value.code), hint: String(value.hint) };
}

export default defineFeature({
  title: 'Transient package read retry',
  catalog: 'Transient package read retry',
  kind: 'headless',
  summary:
    'Pack GETs that fail with a transient status (408/429/500/502/503/504) retry twice after 250 ms and 750 ms with cache "reload"; permanent statuses fail on the first request.',
  expect:
    'Two 503s then 200 load the asset in 3 requests (>= 1 s); a 404 fails after 1 request; three 503s fail after 3 requests with the attempt count in the hint.',
  async run(checks) {
    const recovered = await load([503, 503]);
    checks.ok(
      '503, 503, 200 loads',
      recovered.result.ok,
      recovered.result.ok ? undefined : describeError(recovered.result.error).hint,
    );
    if (recovered.result.ok)
      checks.equal('payload survives the retry', recovered.result.value.label, 'retried');
    checks.equal('three requests', recovered.calls.length, 3);
    checks.ok(
      'bounded backoff waits >= 1 s',
      recovered.elapsed >= 950,
      `${recovered.elapsed.toFixed(0)} ms`,
    );
    checks.equal(
      'retries bypass the HTTP cache',
      recovered.calls.slice(1).map((call) => call.cache),
      ['reload', 'reload'],
    );

    const missing = await load([404]);
    checks.ok('404 fails', !missing.result.ok);
    checks.equal('404 is not retried', missing.calls.length, 1);
    if (!missing.result.ok) {
      const error = describeError(missing.result.error);
      checks.equal('404 code', error.code, 'asset-not-imported');
      checks.ok(
        '404 hint names one request',
        error.hint.includes('HTTP 404 after 1 request(s)'),
        error.hint,
      );
    }

    const exhausted = await load([503, 503, 503]);
    checks.ok('three 503s fail', !exhausted.result.ok);
    checks.equal('retry budget is two retries', exhausted.calls.length, 3);
    if (!exhausted.result.ok) {
      const error = describeError(exhausted.result.error);
      checks.ok(
        'exhausted hint names three requests',
        error.hint.includes('HTTP 503 after 3 request(s)'),
        error.hint,
      );
    }
  },
});
