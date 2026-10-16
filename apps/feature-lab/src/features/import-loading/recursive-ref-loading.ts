import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { defineFeature } from '../../lab/feature';

const ROOT = '019f1a00-0000-7000-8000-0000000000c1';
const MIDDLE = '019f1a00-0000-7000-8000-0000000000c2';
const LEAF = '019f1a00-0000-7000-8000-0000000000c3';
const PACKAGE_URL = 'https://feature-lab.invalid/refs/pack.json';

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    { guid: ROOT, kind: 'lab-root', payload: { name: 'root' }, refs: [MIDDLE], artifacts: {} },
    { guid: MIDDLE, kind: 'lab-middle', payload: { name: 'middle' }, refs: [LEAF], artifacts: {} },
    { guid: LEAF, kind: 'lab-leaf', payload: { name: 'leaf' }, refs: [], artifacts: {} },
  ],
};

export default defineFeature({
  title: 'Recursive ref loading',
  catalog: 'Recursive ref loading',
  kind: 'headless',
  summary:
    'loadByGuid(root) walks the AssetEnvelope refs root -> middle -> leaf. The three GUIDs use three unrelated custom kinds, so traversal cannot depend on a specific asset kind.',
  expect:
    'Loading only the root prepares all three assets, loaders run owner-first (register-before-recurse), the whole closure is ready when the root promise resolves, and the Pack body is fetched once.',
  async run(checks) {
    const order: string[] = [];
    let fetches = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      fetches++;
      return String(input) === PACKAGE_URL
        ? new Response(JSON.stringify(PACK))
        : new Response('', { status: 404 });
    }) as typeof fetch;
    const registry = new AssetRegistry({} as never);
    for (const kind of ['lab-root', 'lab-middle', 'lab-leaf']) {
      registry.loaders.registerPackLoader({
        kind,
        load: (input) => {
          order.push(String(input.payload.name));
          return { kind, ...input.payload };
        },
      });
    }
    registry.setCatalogSource(
      createCatalogSource({
        entries: PACK.assets.map(({ guid, kind }) => ({
          guid,
          kind,
          packageUrl: PACKAGE_URL,
          sourcePath: guid,
        })),
      }),
      fetcher,
    );
    const root = await registry.loadByGuid<{ name: string }>(registry.parseGuid(ROOT));
    checks.ok(
      'root loads',
      root.ok,
      root.ok ? undefined : String((root.error as { code?: unknown }).code),
    );
    if (root.ok) checks.equal('root payload', root.value.name, 'root');
    checks.ok('middle prepared by the walk', registry.lookup(MIDDLE) !== undefined);
    checks.ok('leaf prepared by the walk', registry.lookup(LEAF) !== undefined);
    checks.equal('owner registers before its refs recurse', order, ['root', 'middle', 'leaf']);
    checks.ok(
      'whole closure is ready when the root load resolves',
      [ROOT, MIDDLE, LEAF].every((guid) => registry.lookup(guid) !== undefined),
    );
    checks.equal('one Pack fetch for the closure', fetches, 1);
    registry.clearCatalogSource();
  },
});
