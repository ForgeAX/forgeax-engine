import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { defineFeature } from '../../lab/feature';

const ROOT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01';
const MID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02';
const LEAF = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03';
const BROKEN = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b09';
const MISSING = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4bff';
const PACK_URL = 'https://feature-lab.invalid/refs.pack.json';

const node = (guid: string, name: string, refs: readonly string[]) => ({
  guid,
  kind: 'lab-node',
  payload: { name, ...(refs.length > 0 ? { child: 0 } : {}) },
  refs,
  artifacts: {},
});

const PACK = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    node(ROOT, 'root', [MID]),
    node(MID, 'mid', [LEAF]),
    node(LEAF, 'leaf', []),
    node(BROKEN, 'broken', [MISSING]),
  ],
};

export default defineFeature({
  title: 'AssetEnvelope refs',
  catalog: 'AssetEnvelope refs',
  kind: 'headless',
  summary:
    'Each envelope lists its dependencies in `refs`; payload fields point at refs by index and loadByGuid walks the graph.',
  expect:
    'Loading the root resolves mid and leaf transitively; a dangling ref fails with a structured error naming its referrer.',
  async run(checks) {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input) === PACK_URL
        ? new Response(JSON.stringify(PACK))
        : new Response('', { status: 404 })) as typeof fetch;
    const assets = new AssetRegistry({} as never);
    const seen: string[] = [];
    assets.loaders.registerPackLoader({
      kind: 'lab-node',
      load: (input) => {
        seen.push(`${String(input.payload.name)}:${input.refs.join(',')}`);
        return { kind: 'lab-node', ...input.payload };
      },
    });
    const entries = [ROOT, MID, LEAF, BROKEN].map((guid) => ({
      guid,
      kind: 'lab-node',
      packageUrl: PACK_URL,
      sourcePath: guid,
    }));
    assets.setCatalogSource(
      createCatalogSource({ entries: entries as never, fetch: fetcher }),
      fetcher,
    );

    const root = await assets.loadByGuid(assets.parseGuid(ROOT));
    checks.ok('root loads', root.ok, root.ok ? undefined : root.error.code);
    checks.equal('loader receives refs as GUID strings', seen[0], `root:${MID}`);
    checks.ok('mid is loaded through refs', assets.lookup(assets.parseGuid(MID)) !== undefined);
    checks.ok('leaf is loaded recursively', assets.lookup(assets.parseGuid(LEAF)) !== undefined);

    const broken = await assets.loadByGuid(assets.parseGuid(BROKEN));
    checks.equal(
      'dangling ref is a structured failure',
      broken.ok ? 'ok' : broken.error.code,
      'asset-not-imported',
    );
    checks.ok(
      'failure names the missing ref',
      !broken.ok && JSON.stringify(broken.error).includes(MISSING),
    );
  },
});
