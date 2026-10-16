import { AssetRegistry, validateAssetPublication } from '@forgeax/engine/assets-runtime';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import {
  prepareRuntimePackContent,
  type RuntimePackCacheEntry,
  type RuntimePackContent,
  RuntimePackProducer,
} from '@forgeax/engine/import';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { AssetGuid, definePackageId, type PackInstanceJson } from '@forgeax/engine/pack/source';
import type { MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const PARENT = '01900000-0000-7000-8000-00000000f101';
const DIRECT = '01900000-0000-7000-8000-00000000f102';
const INSTANCE = '01900000-0000-7000-8000-00000000f103';

function producer(cache?: Map<string, RuntimePackCacheEntry>): RuntimePackProducer {
  const value: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'feature-lab-runtime-pack',
    ...(cache ? { cache } : {}),
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: value.catalog, fetcher: value.fetch },
        { dependencies },
      ),
    imports: {
      geometry: {
        identity: 'feature-lab-engine',
        url: import.meta.resolve('@forgeax/engine/geometry'),
      },
    },
  });
  return value;
}

function reader(source: RuntimePackProducer): AssetRegistry {
  const assets = new AssetRegistry({} as never);
  assets.setCatalogSource(source.catalog, source.fetch);
  return assets;
}

async function positions(source: RuntimePackProducer, packageId: string): Promise<string> {
  const assets = reader(source);
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'box'));
  const loaded = await assets.loadByGuid<MeshAsset>(assets.parseGuid(guid));
  assets.clearCatalogSource();
  return loaded.ok
    ? JSON.stringify(Array.from(loaded.value.attributes.position as ArrayLike<number>))
    : `error:${loaded.error.code}`;
}

const generator: RuntimePackContent = {
  source: {
    schemaVersion: '2.0.0',
    kind: 'scriptable-pack-source',
    source: 'runtime/generator',
    packageId: PARENT,
    parameters: [{ name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 5 }],
    runtime: { dependencies: [] },
    program: 'project:runtime/generator.js#build',
  },
  programs: {
    'project:runtime/generator.js#build': {
      artifact: preparePackProgram({
        entry: 'generator.js',
        export: 'build',
        imports: { geometry: 'feature-lab-engine' },
        modules: {
          'generator.js':
            "import { createBoxGeometry } from 'geometry'; export async function build({ values }) { return { ok: true, value: { box: createBoxGeometry(values.width, 2, 3).unwrap() } }; }",
        },
      }).unwrap(),
    },
  },
};

const instance = (width: number): PackInstanceJson => ({
  schemaVersion: '3.0.0',
  packageId: INSTANCE,
  parent: PARENT,
  values: { width },
});

export default defineFeature({
  title: 'Runtime Pack generation',
  catalog: 'Runtime Pack generation',
  kind: 'headless',
  summary:
    'RuntimePackProducer admits direct content and runtime generators, publishes ordinary Catalog rows, and restores from a durable snapshot.',
  expect:
    'Direct Mesh loads by derived GUID; conflicting re-admission fails atomically; generator instances regenerate, keep lastKnownGood on a bad edit, and restore from JSON.',
  async run(checks) {
    const source = producer();
    const mesh = createBoxGeometry(2, 3, 4).unwrap();
    const content = await prepareRuntimePackContent(DIRECT, { box: mesh });
    if (!content.ok) {
      checks.ok('prepare direct content', false, JSON.stringify(content.error));
      return;
    }
    const admitted = await source.admit(content.value);
    checks.ok(
      'direct content admitted with Catalog rows',
      admitted.ok && admitted.value.rows.length === 1,
      JSON.stringify(admitted.ok ? admitted.value.status : admitted.error.code),
    );
    const directPositions = await positions(source, DIRECT);
    checks.equal(
      'GUID load returns the authored Mesh',
      directPositions,
      JSON.stringify(Array.from(mesh.attributes.position as ArrayLike<number>)),
    );
    checks.ok(
      'identical re-admission is idempotent',
      (await source.admit(structuredClone(content.value))).ok,
    );
    const conflicting = (
      await prepareRuntimePackContent(DIRECT, { box: createBoxGeometry(4, 3, 4).unwrap() })
    ).unwrap();
    const conflict = await source.admit(conflicting);
    checks.equal(
      'conflicting content is refused',
      conflict.ok ? 'ok' : conflict.error.code,
      'runtime-pack-conflict',
    );
    checks.equal(
      'refused content left the published Mesh intact',
      await positions(source, DIRECT),
      directPositions,
    );

    const cache = new Map<string, RuntimePackCacheEntry>();
    const live = producer(cache);
    checks.ok(
      'generator admission publishes no outputs yet',
      (await live.admit(generator)).ok && live.rows().length === 0,
    );
    const first = await live.generate(instance(2));
    checks.ok(
      'instance generation publishes rows',
      first.ok && first.value.rows.length === 1,
      first.ok ? '' : JSON.stringify(first.error),
    );
    const w2 = await positions(live, INSTANCE);
    checks.ok(
      'edited instance regenerates new data under the same GUID',
      (await live.generate(instance(4))).ok && (await positions(live, INSTANCE)) !== w2,
    );
    const w4 = await positions(live, INSTANCE);
    const bad = await live.generate(instance(100));
    const execution = live
      .inspect()
      .executions.find((item) => item.instance.packageId === INSTANCE);
    checks.equal(
      'out-of-range edit fails and keeps lastKnownGood',
      [bad.ok, execution?.status, execution?.lastKnownGood?.values],
      [false, 'failed', { width: 4 }],
    );
    checks.equal(
      'failed edit keeps last good payload visible',
      await positions(live, INSTANCE),
      w4,
    );

    const saved = JSON.parse(JSON.stringify(live.snapshot()));
    checks.equal('snapshot is runtime-pack-source/2', saved.schemaVersion, 'runtime-pack-source/2');
    live.dispose();
    source.dispose();
    cache.clear();
    const restored = producer(cache);
    const recovery = await restored.restore(saved);
    checks.ok(
      'restore re-admits into a fresh producer',
      recovery.ok,
      recovery.ok ? '' : JSON.stringify(recovery.error),
    );
    checks.equal(
      'restored instance reproduces lastKnownGood data',
      await positions(restored, INSTANCE),
      w4,
    );
    restored.withdraw(INSTANCE);
    checks.equal('withdraw removes generated rows', restored.rows().length, 0);
    restored.dispose();
  },
});
