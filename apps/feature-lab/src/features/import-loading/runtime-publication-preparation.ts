import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { createBoxGeometry, packMeshBin, prepareMeshData } from '@forgeax/engine/geometry';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import type { CatalogEntry, MaterialAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const GUID = '019f1a00-0000-7000-8000-0000000000f1';
const PACKAGE_URL = 'https://feature-lab.invalid/prepared/candidate.pack.json';

const unreachable = (async () => new Response('', { status: 404 })) as typeof fetch;
const invalid = () => ({ kind: 'material', passes: [], values: {} }) as unknown as MaterialAsset;

function throws(body: () => void): boolean {
  try {
    body();
    return false;
  } catch {
    return true;
  }
}

export default defineFeature({
  title: 'Runtime publication preparation',
  catalog: 'Runtime publication preparation',
  kind: 'headless',
  summary:
    'Runtime-produced Packs are prepared privately by the registry loaders and adopted only through a single-use commit proof. Portable mesh encoding (prepareMeshData / packMeshBin) is a separate pure geometry kernel.',
  expect:
    'A prepared material stays invisible to lookup until commit; edits to the prepared read, the source Pack, and the loaded copy never reach the adopted payload; a second commit throws; public catalog() still validates. Box geometry encodes; a truncated vertex stream is mesh-bin-payload-invalid.',
  async run(checks) {
    const { pack, publication } = createRuntimePackPublication({
      scopeId: 'feature-lab-prepared',
      sourcePath: 'candidate.pack.ts',
      sourceRevision: 'lab',
      packageUrl: PACKAGE_URL,
      pack: {
        assets: [
          {
            guid: GUID,
            kind: 'material',
            payload: { passes: [{ program: { module: 'feature-lab' } }], values: {} },
            refs: [],
            artifacts: {},
          },
        ],
      },
    });
    const rows: CatalogEntry[] = [
      {
        guid: GUID,
        kind: 'material',
        sourcePath: 'candidate.pack.ts',
        packageUrl: PACKAGE_URL,
        refs: [],
        publication,
      },
    ];
    const registry = new AssetRegistry({} as never);
    registry.setCatalogSource(createCatalogSource({ entries: [] }), unreachable);
    try {
      const prepared = await registry.preparePublication(rows, unreachable, undefined, { pack });
      checks.ok(
        'prepare ok',
        prepared.ok,
        prepared.ok ? undefined : String((prepared.error as { code?: unknown }).code),
      );
      if (!prepared.ok) return;
      checks.ok('prepared payload is private before commit', registry.lookup(GUID) === undefined);
      const read = prepared.value.get(GUID);
      const copy = typeof read === 'function' ? await read() : read;
      Object.assign(copy ?? {}, invalid());
      (pack.assets[0]?.payload as Record<string, unknown>).passes = [];
      registry.commitPreparedPublication(pack);
      const loaded = await registry.loadByGuid<MaterialAsset>(registry.parseGuid(GUID));
      checks.ok('committed payload loads', loaded.ok);
      if (loaded.ok) {
        checks.equal('edits before commit did not leak', loaded.value.passes?.length, 1);
        Object.assign(loaded.value, invalid());
        const again = typeof read === 'function' ? await read() : read;
        checks.equal(
          'loaded copy is isolated from retention',
          (again as MaterialAsset).passes?.length,
          1,
        );
        checks.ok('public catalog still validates', !registry.catalog(GUID, loaded.value).ok);
      }
      checks.ok(
        'commit proof is single-use',
        throws(() => registry.commitPreparedPublication(pack)),
      );
      checks.ok(
        'foreign registry cannot commit',
        throws(() => new AssetRegistry({} as never).commitPreparedPublication(pack)),
      );
    } finally {
      registry.clearCatalogSource();
    }

    const box = createBoxGeometry(1, 1, 1).unwrap();
    const meshData = prepareMeshData(box, 'lab-box');
    checks.ok('prepareMeshData(box) ok', meshData.ok);
    const bytes = packMeshBin(box, 'lab-box');
    checks.ok(
      'packMeshBin(box) emits bytes',
      bytes.ok && bytes.value.byteLength > 0,
      bytes.ok ? `${bytes.value.byteLength} B` : bytes.error.code,
    );
    const position = box.attributes.position as Float32Array;
    const truncated = {
      ...box,
      attributes: { ...box.attributes, position: position.subarray(0, position.length - 1) },
    };
    const broken = prepareMeshData(truncated as typeof box, 'lab-broken');
    checks.ok(
      'inconsistent stream is rejected',
      !broken.ok,
      broken.ok ? 'accepted' : broken.error.code,
    );
    if (!broken.ok)
      checks.equal('structured encode code', broken.error.code, 'mesh-bin-payload-invalid');
  },
});
