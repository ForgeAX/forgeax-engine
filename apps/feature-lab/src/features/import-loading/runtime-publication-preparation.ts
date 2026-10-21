import { AssetRegistry, type CatalogListener } from '@forgeax/engine/assets-runtime';
import { createBoxGeometry, packMeshBin, prepareMeshData } from '@forgeax/engine/geometry';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import { samplerContribution } from '@forgeax/engine/render';
import { type CatalogEntry, ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const GUID = '019f1a00-0000-7000-8000-0000000000f1';
const PACKAGE_URL = 'https://feature-lab.invalid/prepared/candidate.pack.json';
const unreachable = (async () => new Response('', { status: 404 })) as typeof fetch;

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
    'Runtime-produced Packs are privately decoded and retained before a single-use commit proof and the producer Catalog delta publish them. Portable mesh encoding is a separate pure geometry kernel.',
  expect:
    'Preparation creates no runtime identity. Edits to prepared reads, the producer Pack and loaded snapshots cannot change retained content. Reused or foreign commit proofs fail, and ordinary runtime writes retain owner validation.',
  async run(checks) {
    const { pack, publication } = createRuntimePackPublication({
      scopeId: 'asset-runtime',
      sourcePath: 'candidate.pack.ts',
      sourceRevision: 'lab',
      packageUrl: PACKAGE_URL,
      pack: {
        assets: [
          {
            guid: GUID,
            kind: 'sampler',
            payload: { kind: 'sampler', magFilter: 'nearest' },
            refs: [],
            artifacts: {},
          },
        ],
      },
    });
    const rows: CatalogEntry[] = [
      {
        guid: GUID,
        kind: 'sampler',
        sourcePath: 'candidate.pack.ts',
        packageUrl: PACKAGE_URL,
        refs: [],
        publication,
      },
    ];
    const registry = new AssetRegistry();
    registry.installDecoder(samplerContribution.kind, samplerContribution.decoder);
    const listeners = new Set<CatalogListener>();
    registry.setCatalogSource(
      {
        enumerate: async () => ok([]),
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      unreachable,
    );
    try {
      const prepared = await registry.preparePublication(rows, unreachable, undefined, { pack });
      checks.ok('prepare succeeds', prepared.ok, prepared.ok ? undefined : String(prepared.error));
      if (!prepared.ok) return;
      checks.equal('preparation creates no runtime identity', registry.inspect().assets.length, 0);
      const read = prepared.value.get(GUID);
      const copy = typeof read === 'function' ? await read() : read;
      Object.assign(copy ?? {}, { magFilter: 'invalid' });
      Object.assign(pack.assets[0]?.payload ?? {}, { magFilter: 'invalid' });
      registry.commitPreparedPublication(pack);
      for (const listener of listeners) listener({ added: rows, changed: [], removed: [] });
      const loaded = await registry.load(GUID, 'sampler');
      checks.ok(
        'committed payload loads without producer I/O',
        loaded.ok,
        loaded.ok ? undefined : loaded.error.code,
      );
      if (loaded.ok) {
        const value = registry.read(loaded.value).unwrap();
        checks.equal('edits before commit did not leak', value.magFilter, 'nearest');
        Object.assign(value, { magFilter: 'invalid' });
        checks.equal(
          'loaded snapshots cannot change retained content',
          registry.read(loaded.value).unwrap().magFilter,
          'nearest',
        );
        const again = typeof read === 'function' ? await read() : read;
        checks.ok(
          'private retention remains unchanged',
          again?.kind === 'sampler' && again.magFilter === 'nearest',
        );
        checks.ok(
          'runtime updates retain owner validation',
          !registry.update(loaded.value, { lodMinClamp: -1 }).ok,
        );
      }
      checks.ok(
        'commit proof is single-use',
        throws(() => registry.commitPreparedPublication(pack)),
      );
      const foreign = new AssetRegistry();
      checks.ok(
        'foreign registry cannot commit',
        throws(() => foreign.commitPreparedPublication(pack)),
      );
      foreign.dispose();
    } finally {
      registry.dispose();
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
