import { createHash } from 'node:crypto';
import {
  buildVisibilityDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  meshAssetContribution,
} from '@forgeax/engine-geometry';
import { decodePackBlob, preparePackProgram } from '@forgeax/engine-pack/runtime';
import {
  AssetGuid,
  definePackageId,
  PackageId,
  type PackInstanceJson,
  resolvePackParameterInheritance,
} from '@forgeax/engine-pack/source';
import { type MeshAsset, ok, type PackV2 } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareRuntimePackAnchor,
  prepareRuntimePackContent,
  type RuntimePackCacheEntry,
  type RuntimePackContent,
  RuntimePackProducer,
  type RuntimePackProducerOptions,
} from '../../../import/src/runtime-pack.js';
import { parseRuntimePackSnapshot } from '../../../import/src/runtime-pack-content.js';
import { scriptablePackFingerprint } from '../../../import/src/scriptable-pack-fingerprint.js';
import { materialContribution } from '../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../asset-kind.js';
import { AssetRegistry } from '../asset-registry.js';
import type { CatalogSource } from '../catalog-source.js';
import { createAssetSource } from '../internal/asset-source.js';
import { DecoderRegistry } from '../internal/decoder-registry.js';
import { runtimeAssetReference } from '../internal/runtime-assets';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';
import { loadFixtureAsset, runtimePackDecoders } from './fixtures/runtime-pack-decoders';

const parent = '01900000-0000-7000-8000-000000000101';
const id = '01900000-0000-7000-8000-000000000102';
const other = '01900000-0000-7000-8000-000000000103';
function producer(
  cache?: Map<string, RuntimePackCacheEntry>,
  assetSource?: RuntimePackProducerOptions['assetSource'],
  programHost?: RuntimePackProducerOptions['programHost'],
) {
  const value: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'test-runtime',
    ...(programHost ? { programHost } : {}),
    ...(cache === undefined ? {} : { cache }),
    ...(assetSource === undefined ? {} : { assetSource }),
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        {
          catalog: value.catalog,
          fetcher: value.fetch,
        },
        { ...{ dependencies }, decoders: runtimePackDecoders },
      ),
    imports: {
      geometry: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-geometry') },
      pack: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-pack/source') },
    },
  });
  return value;
}
function reader(source: RuntimePackProducer) {
  const assets = new AssetRegistry({ scopeId: 'test-runtime', shaderRegistry: {} as never });
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.installDecoder(materialContribution.kind, materialContribution.decoder);
  assets.setCatalogSource(source.catalog, source.fetch);
  return assets;
}
function instance(packageId: string, width: number): PackInstanceJson {
  return { schemaVersion: '3.0.0', packageId, parent, values: { width } };
}
function generator(delay = ''): RuntimePackContent {
  return {
    source: {
      schemaVersion: '2.0.0',
      kind: 'scriptable-pack-source',
      source: 'runtime/generator',
      packageId: parent,
      parameters: [{ name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 5 }],
      runtime: { dependencies: [] },
      program: 'project:runtime/generator.js#build',
    },
    programs: {
      'project:runtime/generator.js#build': {
        artifact: preparePackProgram({
          entry: 'generator.js',
          export: 'build',
          imports: { geometry: 'test-engine' },
          modules: {
            'generator.js': `import { createBoxGeometry } from 'geometry'; export async function build({ values }) { ${delay} return { ok: true, value: { box: createBoxGeometry(values.width, 2, 3).unwrap() } }; }`,
          },
        }).unwrap(),
      },
    },
  };
}
function outputGuid(packageId: string) {
  return AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'box'));
}

it('publishes regenerated content immediately while keeping receipts stable across restore', async () => {
  const source = producer(new Map());
  const assets = reader(source);
  const restored = producer();
  const recovered = reader(restored);
  try {
    (await source.admit(generator())).unwrap();
    const first = (await source.generate(instance(id, 2))).unwrap();
    expect((await assets.enumerateCatalog()).unwrap()).toEqual(first.rows);
    const changed = (await source.generate(instance(id, 4))).unwrap();
    expect((await assets.enumerateCatalog()).unwrap()).toEqual(changed.rows);
    expect(assets.catalogSnapshot()?.stale).toBe(false);
    expect((await source.generate(instance(id, 2))).unwrap()).toEqual(first);
    expect((await assets.enumerateCatalog()).unwrap()).toEqual(first.rows);
    expect(assets.catalogSnapshot()?.stale).toBe(false);
    const saved = JSON.parse(JSON.stringify(source.snapshot()));
    (await restored.restore(saved)).unwrap();
    expect((await recovered.enumerateCatalog()).unwrap()).toEqual(first.rows);
    expect((await restored.generate(instance(id, 4))).unwrap()).toEqual(changed);
    expect((await recovered.enumerateCatalog()).unwrap()).toEqual(changed.rows);
    expect(recovered.catalogSnapshot()?.stale).toBe(false);
    const before = await source.catalog.enumerate();
    const after = await restored.catalog.enumerate();
    expect(before.revisions[0]?.rootId).not.toBe(after.revisions[0]?.rootId);
  } finally {
    assets.clearCatalogSource();
    recovered.clearCatalogSource();
    source.dispose();
    restored.dispose();
  }
});

async function inheritedAnchor(width: number) {
  const anchor = '01900000-0000-7000-8000-000000000104';
  const resolution = (
    await resolvePackParameterInheritance(
      {
        format: 'instance',
        packageId: definePackageId(anchor),
        parent: definePackageId(other),
        values: {},
      },
      (packageId) =>
        PackageId.format(packageId) === other
          ? { format: 'instance', packageId, parent: definePackageId(parent), values: { width } }
          : {
              format: 'source',
              packageId: definePackageId(parent),
              parameters: [{ name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 5 }],
            },
    )
  ).unwrap();
  return { anchor, resolution };
}

describe('resolved runtime parameter anchors', () => {
  it('folds inherited values into defaults and restores a copied instance without its original parent chain', async () => {
    const { anchor, resolution } = await inheritedAnchor(4);
    const original = generator();
    const content = prepareRuntimePackAnchor(original, resolution).unwrap();
    expect(content.source).toMatchObject({
      packageId: anchor,
      parameters: [{ name: 'width', default: 4 }],
    });
    expect(original.source).toMatchObject({ packageId: parent, parameters: [{ default: 1 }] });
    expect(content.programs).toEqual(original.programs);
    expect(content.programs).not.toBe(original.programs);
    const cache = new Map<string, RuntimePackCacheEntry>();
    const source = producer(cache);
    const assets = reader(source);
    const restored = producer();
    const recovered = reader(restored);
    try {
      (await source.admit(content)).unwrap();
      expect(source.rows()).toEqual([]);
      const selection: PackInstanceJson = {
        schemaVersion: '3.0.0',
        packageId: id,
        parent: anchor,
        values: {},
      };
      (await source.generate(selection)).unwrap();
      const defaults = (await loadFixtureAsset(assets, outputGuid(id), 'mesh')).unwrap();
      expect(defaults.attributes.position).toEqual(
        createBoxGeometry(4, 2, 3).unwrap().attributes.position,
      );
      const changed = { ...selection, values: { width: 2 } };
      (await source.generate(changed)).unwrap();
      const copy = { ...changed, packageId: other };
      (await source.generate(copy)).unwrap();
      const expected = createBoxGeometry(2, 2, 3).unwrap().attributes.position;
      expect(
        (await loadFixtureAsset(assets, outputGuid(other), 'mesh')).unwrap().attributes.position,
      ).toEqual(expected);
      expect(cache.size).toBe(3);
      (await source.generate(copy)).unwrap();
      expect(cache.size).toBe(3);
      const saved = JSON.parse(JSON.stringify(source.snapshot()));
      expect(saved.packs.map((pack: RuntimePackContent) => pack.source.packageId)).toEqual([
        anchor,
      ]);
      expect(saved.instances).toEqual([changed, copy]);
      cache.clear();
      source.dispose();
      (await restored.restore(saved)).unwrap();
      for (const packageId of [id, other])
        expect(
          (await loadFixtureAsset(recovered, outputGuid(packageId), 'mesh')).unwrap().attributes
            .position,
        ).toEqual(expected);
      (await restored.generate(selection)).unwrap();
      (
        await recovered.reload(defined(runtimeAssetReference(recovered, outputGuid(id))), {
          conflict: 'overwrite',
        })
      ).unwrap();
      expect(
        (await loadFixtureAsset(recovered, outputGuid(id), 'mesh')).unwrap().attributes.position,
      ).toEqual(defaults.attributes.position);
      expect(
        await restored.generate({ ...selection, packageId: parent, parent: id }),
      ).toMatchObject({ ok: false });
      expect(restored.rows()).toHaveLength(2);
    } finally {
      assets.clearCatalogSource();
      recovered.clearCatalogSource();
      source.dispose();
      restored.dispose();
    }
  });

  it('rejects mismatched root identity, parameter contracts and incomplete or invalid effective values', async () => {
    const { resolution } = await inheritedAnchor(4);
    for (const changed of [
      { ...resolution, rootPackageId: definePackageId(other) },
      { ...resolution, parameters: [{ ...resolution.parameters[0], default: 2 }] },
      { ...resolution, values: {} },
      { ...resolution, values: { width: 6 } },
      { ...resolution, values: { width: 4, extra: 1 } },
    ]) {
      expect(prepareRuntimePackAnchor(generator(), changed as typeof resolution)).toMatchObject({
        ok: false,
        error: { code: 'runtime-pack-invalid' },
      });
    }
  });

  it('serializes inherited asset GUID defaults and supplies their native type after restore', async () => {
    const parameters = [
      { name: 'width', type: 'f32' as const, default: 1, minimum: 1, maximum: 5 },
      { name: 'resource', type: 'asset-guid' as const, default: id },
    ];
    const resolution = (
      await resolvePackParameterInheritance(
        {
          format: 'instance',
          packageId: definePackageId(other),
          parent: definePackageId(parent),
          values: { resource: parent, width: 3 },
        },
        () => ({ format: 'source', packageId: definePackageId(parent), parameters }),
      )
    ).unwrap();
    expect(resolution.values.resource).toBeInstanceOf(Uint8Array);
    const original = generator(
      'if (!(values.resource instanceof Uint8Array) || values.resource.byteLength !== 16) throw new Error("lost native GUID");',
    );
    if (!('kind' in original.source)) throw new TypeError('expected a generator');
    const content = prepareRuntimePackAnchor(
      { ...original, source: { ...original.source, parameters } },
      resolution,
    ).unwrap();
    expect(content.source).toMatchObject({ parameters: [{ default: 3 }, { default: parent }] });
    const normalized = resolution.values.resource;
    if (!(normalized instanceof Uint8Array)) throw new TypeError('expected resolved GUID');
    normalized.fill(0);
    expect(content.source).toMatchObject({ parameters: [{ default: 3 }, { default: parent }] });
    const source = producer();
    const restored = producer();
    const assets = reader(restored);
    try {
      (await source.admit(content)).unwrap();
      (
        await source.generate({ schemaVersion: '3.0.0', packageId: id, parent: other, values: {} })
      ).unwrap();
      const saved = JSON.parse(JSON.stringify(source.snapshot()));
      source.dispose();
      (await restored.restore(saved)).unwrap();
      expect(
        (await loadFixtureAsset(assets, outputGuid(id), 'mesh')).unwrap().attributes.position,
      ).toEqual(createBoxGeometry(3, 2, 3).unwrap().attributes.position);
    } finally {
      source.dispose();
      restored.dispose();
      assets.clearCatalogSource();
    }
  });

  it('keeps different inherited anchors separate when they share the same program', async () => {
    const first = await inheritedAnchor(3);
    const second = await inheritedAnchor(5);
    const source = producer(new Map());
    const assets = reader(source);
    try {
      const a = prepareRuntimePackAnchor(generator(), first.resolution).unwrap();
      const b = prepareRuntimePackAnchor(generator(), {
        ...second.resolution,
        packageId: definePackageId(other),
      }).unwrap();
      (await source.admit(a)).unwrap();
      expect(
        await source.admit(prepareRuntimePackAnchor(generator(), second.resolution).unwrap()),
      ).toMatchObject({ ok: false, error: { code: 'runtime-pack-conflict' } });
      (await source.admit(b)).unwrap();
      for (const [packageId, anchor, width] of [
        [id, first.anchor, 3],
        [parent, other, 5],
      ] as const) {
        (
          await source.generate({ schemaVersion: '3.0.0', packageId, parent: anchor, values: {} })
        ).unwrap();
        expect(
          (await loadFixtureAsset(assets, outputGuid(packageId), 'mesh')).unwrap().attributes
            .position,
        ).toEqual(createBoxGeometry(width, 2, 3).unwrap().attributes.position);
      }
      expect(source.programEntries().size).toBe(1);
    } finally {
      assets.clearCatalogSource();
      source.dispose();
    }
  });
});

interface MutableRuntimeContent {
  [key: string | symbol]: unknown;
  source: Record<string, unknown>;
  programs: Record<string, Record<string, unknown>>;
}
describe('durable runtime Pack input', () => {
  it.each([
    [
      'unknown envelope field',
      (content: MutableRuntimeContent) => {
        content.extra = true;
      },
    ],
    [
      'unknown generator field',
      (content: MutableRuntimeContent) => {
        content.source.extra = true;
      },
    ],
    [
      'unknown program wrapper field',
      (content: MutableRuntimeContent) => {
        defined(Object.values(content.programs)[0]).extra = true;
      },
    ],
    [
      'generator blob byte overflow',
      (content: MutableRuntimeContent) => {
        content.blobs = { data: [256] };
      },
    ],
    [
      'generator blob byte NaN',
      (content: MutableRuntimeContent) => {
        content.blobs = { data: [NaN] };
      },
    ],
    [
      'generator blob undefined',
      (content: MutableRuntimeContent) => {
        content.blobs = { data: [undefined] };
      },
    ],
    [
      'generator blob function',
      (content: MutableRuntimeContent) => {
        content.blobs = { data: [() => 1] };
      },
    ],
    [
      'generator blob sparse array',
      (content: MutableRuntimeContent) => {
        content.blobs = { data: new Array(1) };
      },
    ],
    [
      'exotic program source',
      (content: MutableRuntimeContent) => {
        defined(Object.values(content.programs)[0]).source = new Map();
      },
    ],
    [
      'symbol property',
      (content: MutableRuntimeContent) => {
        content[Symbol('lost')] = true;
      },
    ],
    [
      'non-enumerable property',
      (content: MutableRuntimeContent) => {
        Object.defineProperty(content, 'lost', { value: true });
      },
    ],
  ] as const)('rejects %s before publishing a definition', async (_label, mutate) => {
    const value = producer();
    try {
      const content = generator();
      mutate(content as unknown as MutableRuntimeContent);
      expect(await value.admit(content)).toMatchObject({
        ok: false,
        error: { code: 'runtime-pack-invalid' },
      });
      expect(value.inspect().packs).toEqual([]);
      expect(value.programEntries().size).toBe(0);
    } finally {
      value.dispose();
    }
  });
  it('rejects lossy parameter data before executing or claiming an instance', async () => {
    const value = producer();
    try {
      (await value.admit(generator())).unwrap();
      const result = await value.generate({
        ...instance(id, 2),
        values: { width: 2, undeclared: undefined },
      } as never);
      expect(result.ok).toBe(false);
      expect(value.inspect().executions).toEqual([]);
      expect(value.rows()).toEqual([]);
    } finally {
      value.dispose();
    }
  });
  it('takes an owned snapshot before the first asynchronous recovery step', async () => {
    const original = producer();
    const restored = producer();
    try {
      (await original.admit(generator())).unwrap();
      (await original.generate(instance(id, 2))).unwrap();
      const snapshot = JSON.parse(JSON.stringify(original.snapshot()));
      const pending = restored.restore(snapshot);
      snapshot.packs[0].source.program = 'mutated';
      snapshot.instances[0].values.width = 5;
      snapshot.packs.push({ source: null });
      (await pending).unwrap();
      expect(restored.inspect().packs).toHaveLength(1);
      expect(restored.inspect().executions[0]?.instance.values).toEqual({ width: 2 });
    } finally {
      restored.dispose();
      original.dispose();
    }
  });
  it('rejects accessors without running them', async () => {
    const value = producer();
    let calls = 0;
    try {
      const content = generator();
      Object.defineProperty(content, 'source', {
        enumerable: true,
        get() {
          calls++;
          return generator().source;
        },
      });
      expect((await value.admit(content)).ok).toBe(false);
      expect(calls).toBe(0);
    } finally {
      value.dispose();
    }
  });
  it.each([
    null,
    { schemaVersion: 'runtime-pack-source/2', packs: [], instances: [], extra: true },
    { schemaVersion: 'runtime-pack-source/2', packs: [], instances: [], recipeRoots: 'bad' },
    { schemaVersion: 'runtime-pack-source/2', packs: [], instances: [], closure: {} },
  ])('returns a structured failure for malformed saved content %#', async (snapshot) => {
    const value = producer();
    try {
      expect(await value.restore(snapshot as never)).toMatchObject({
        ok: false,
        error: { code: 'runtime-pack-invalid' },
      });
      expect(value.rows()).toEqual([]);
    } finally {
      value.dispose();
    }
  });
});

it('rejects an external root recipe that rebuilds an additional output', async () => {
  const external = producer();
  const assets = reader(external);
  const marker = '__runtimePackExternalRootOutputSet';
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals[marker];
  const source = producer(undefined, {
    exportSource: (versions) => external.exportSource(versions),
  });
  try {
    (
      await external.admit(
        generator(
          `if (globalThis.${marker}) return { ok: true, value: { box: createBoxGeometry(values.width, 2, 3).unwrap(), extra: createBoxGeometry(1, 1, 1).unwrap() } }; globalThis.${marker} = true;`,
        ),
      )
    ).unwrap();
    const output = defined(
      (await external.generate(instance(id, 2))).unwrap().publication?.outputs[0],
    );
    const content = generator();
    const result = await source.admit({
      ...content,
      source: {
        ...content.source,
        packageId: other,
        runtime: { dependencies: [output.guid] },
      } as RuntimePackContent['source'],
      dependencies: { [output.guid]: output.digest },
    });
    expect(result.ok).toBe(false);
    expect(source.rows()).toEqual([]);
  } finally {
    assets.clearCatalogSource();
    source.dispose();
    external.dispose();
    delete globals[marker];
  }
});

it('rejects a recovered fixed recipe that unexpectedly adds an output', async () => {
  const source = producer();
  const marker = '__runtimePackOutputSetRegression';
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals[marker];
  const recovered = producer();
  try {
    (
      await source.admit(
        generator(
          `if (globalThis.${marker}) return { ok: true, value: { box: createBoxGeometry(values.width, 2, 3).unwrap(), extra: createBoxGeometry(1, 1, 1).unwrap() } }; globalThis.${marker} = true;`,
        ),
      )
    ).unwrap();
    const output = defined(
      (await source.generate(instance(id, 2))).unwrap().publication?.outputs[0],
    );
    const content = generator();
    (
      await source.admit({
        ...content,
        source: {
          ...content.source,
          packageId: other,
          program: 'project:output-set-consumer.js#build',
          runtime: { dependencies: [output.guid] },
        } as RuntimePackContent['source'],
        dependencies: { [output.guid]: output.digest },
        programs: {
          'project:output-set-consumer.js#build': defined(
            content.programs?.['project:runtime/generator.js#build'],
          ),
        },
      })
    ).unwrap();
    source.withdraw(parent);
    const saved = source.snapshot();
    expect((await recovered.restore(saved)).ok).toBe(false);
    expect(recovered.rows()).toEqual([]);
  } finally {
    delete globals[marker];
    recovered.dispose();
    source.dispose();
  }
});
it.each([
  'legacy',
  'runtime',
])('fences %s cached and fresh definitions against a transitive reference change', async (mode) => {
  const source = producer();
  const program = {
    artifact: preparePackProgram({
      entry: 'behavior.js',
      export: 'default',
      modules: {
        'behavior.js': 'export default { apply() {} };',
      },
    }).unwrap(),
  };
  const publish = async (
    packageId: string,
    dependency?: {
      guid: string;
      digest: string;
    },
    revision = 1,
  ) => {
    const content = (
      await prepareRuntimePackContent(
        packageId,
        {
          behavior: {
            kind: 'plugin',
            module: { specifier: './behavior.js' },
            config: {
              revision,
              ...(dependency ? { target: { $asset: dependency.guid } } : {}),
            },
          },
        },
        {
          programs: { 'project:behavior.js#default': program },
          ...(dependency ? { dependencies: { [dependency.guid]: dependency.digest } } : {}),
        },
      )
    ).unwrap();
    return (await source.admit(content)).unwrap();
  };
  const c1 = defined(defined((await publish(other)).publication).outputs[0]);
  const b1 = defined(defined((await publish(id, c1)).publication).outputs[0]);
  const a = await publish(parent, b1);
  const guid = defined(a.rows[0]).guid;
  expect(defined(a.publication).externalEvidence).toContainEqual({
    guid: c1.guid,
    digest: c1.digest,
    usage: 'reference',
  });
  const legacy = reader(source);
  const runtime = new AssetRegistry({
    catalog: source.catalog,
    scopeId: 'test-runtime',
    fetcher: source.fetch,
  });
  runtime.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  runtime.installDecoder(materialContribution.kind, materialContribution.decoder);
  const read = () =>
    mode === 'legacy' ? legacy.readPluginDefinition(guid) : runtime.readPluginDefinition(guid);
  expect((await read()).ok).toBe(true);
  source.withdraw(id);
  source.withdraw(other);
  const c2 = defined(defined((await publish(other, undefined, 2)).publication).outputs[0]);
  const b2 = defined(defined((await publish(id, c2)).publication).outputs[0]);
  expect(b2.digest).toBe(b1.digest);
  expect(c2.digest).not.toBe(c1.digest);
  expect((await read()).ok).toBe(false);
  legacy.invalidateAll();
  expect((await read()).ok).toBe(false);
  const saved = JSON.parse(JSON.stringify(source.snapshot()));
  const restored = producer();
  // A still requires C1, while the current B/C roots require C2. A single Catalog cannot satisfy both.
  expect((await restored.restore(saved)).ok).toBe(false);
  expect(restored.rows()).toEqual([]);
  restored.dispose();
  legacy.clearCatalogSource();
  runtime.dispose();
  source.dispose();
});
it('keeps different historical computation versions private and rejects substitution into an admitted source', async () => {
  const source = producer();
  const leaf = async (width: number) =>
    defined(
      defined(
        (
          await source.admit(
            (
              await prepareRuntimePackContent(other, {
                box: createBoxGeometry(width, 2, 3).unwrap(),
              })
            ).unwrap(),
          )
        ).unwrap().publication,
      ).outputs[0],
    );
  const dependent = (
    packageId: string,
    dependency: {
      guid: string;
      digest: string;
    },
  ) => {
    const content = generator();
    return {
      ...content,
      source: {
        ...content.source,
        packageId,
        runtime: { dependencies: [dependency.guid] },
      } as RuntimePackContent['source'],
      dependencies: { [dependency.guid]: dependency.digest },
    };
  };
  const consumerId = '01900000-0000-7000-8000-000000000104';
  const consumerInstanceId = '01900000-0000-7000-8000-000000000105';
  const originals = [];
  for (const width of [1, 4]) {
    const c = await leaf(width);
    (await source.admit(dependent(parent, c))).unwrap();
    const x = defined(
      defined((await source.generate(instance(id, 2))).unwrap().publication).outputs[0],
    );
    const definition = dependent(consumerId, x);
    (await source.admit(definition)).unwrap();
    const instanceRecord = { ...instance(consumerInstanceId, width), parent: consumerId };
    const output = defined(
      defined((await source.generate(instanceRecord)).unwrap().publication).outputs[0],
    );
    originals.push(await source.exportSource(new Map([[output.guid, output.digest]])));
    source.withdraw(consumerId);
    source.withdraw(parent);
    source.withdraw(other);
  }
  const target = producer();
  (await target.restore(defined(originals[0]))).unwrap();
  expect((await target.restore(defined(originals[1]))).ok).toBe(false);
  expect(
    target.inspect().executions.find((item) => item.instance.packageId === consumerInstanceId)
      ?.lastKnownGood?.values,
  ).toEqual({ width: 1 });
  target.dispose();
  // Distinct roots may depend on different versions of the same historical input without exposing it.
  const combined = producer();
  const left = parseRuntimePackSnapshot(defined(originals[0]));
  const right = parseRuntimePackSnapshot(defined(originals[1]));
  const leftRecipe = defined(defined(left.closure).recipes[defined(left.recipeRoots?.[0])]);
  const rightRecipe = defined(defined(right.closure).recipes[defined(right.recipeRoots?.[0])]);
  if (!('content' in leftRecipe) || !('content' in rightRecipe))
    throw new Error('expected authored recipes');
  const leftContent = defined(defined(left.closure).contents[leftRecipe.content]);
  const rightContent = defined(defined(right.closure).contents[rightRecipe.content]);
  const rightId = '01900000-0000-7000-8000-000000000106';
  const rightInstanceId = '01900000-0000-7000-8000-000000000107';
  const rightSource = {
    ...rightContent,
    source: { ...rightContent.source, packageId: rightId },
  };
  const combinedSnapshot = {
    schemaVersion: 'runtime-pack-source/2' as const,
    packs: [leftContent, rightSource],
    instances: [
      defined(leftRecipe.instance),
      { ...defined(rightRecipe.instance), packageId: rightInstanceId, parent: rightId },
    ],
    closure: {
      contents: { ...defined(left.closure).contents, ...defined(right.closure).contents },
      recipes: { ...defined(left.closure).recipes, ...defined(right.closure).recipes },
      bindings: {
        [scriptablePackFingerprint(leftContent)]: leftRecipe.dependencies,
        [scriptablePackFingerprint(rightSource)]: rightRecipe.dependencies,
      },
    },
  };
  const result = await combined.restore(combinedSnapshot);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(combined.rows()).toHaveLength(2);
  const joinedId = '01900000-0000-7000-8000-000000000108';
  const joinedInstanceId = '01900000-0000-7000-8000-000000000109';
  const outputs = combined
    .rows()
    .map((row) =>
      defined(defined(row.publication).outputs.find((output) => output.guid === row.guid)),
    );
  const base = generator();
  const programId = 'project:join.js#build';
  (
    await combined.admit({
      ...base,
      source: {
        ...base.source,
        packageId: joinedId,
        program: programId,
        runtime: { dependencies: outputs.map((output) => output.guid) },
      } as RuntimePackContent['source'],
      dependencies: Object.fromEntries(outputs.map((output) => [output.guid, output.digest])),
      programs: {
        [programId]: {
          artifact: preparePackProgram({
            entry: 'join.js',
            export: 'build',
            imports: { pack: 'test-engine' },
            modules: {
              'join.js': `import { AssetGuid } from 'pack'; export async function build({ readByGuid }) { const output = {}; for (const [index, guid] of ${JSON.stringify(outputs.map((output) => output.guid))}.entries()) { const parsed = AssetGuid.parse(guid); if (!parsed.ok) return parsed; const asset = await readByGuid(parsed.value); if (!asset.ok) return asset; output['mesh' + index] = asset.value; } return { ok: true, value: output }; }`,
            },
          }).unwrap(),
        },
      },
    })
  ).unwrap();
  (await combined.generate({ ...instance(joinedInstanceId, 1), parent: joinedId })).unwrap();
  expect(combined.rows()).toHaveLength(4);
  const fresh = producer();
  (await fresh.restore(JSON.parse(JSON.stringify(combined.snapshot())))).unwrap();
  expect(fresh.rows()).toHaveLength(4);
  fresh.dispose();
  combined.dispose();
  source.dispose();
});
it('refuses a root removed synchronously by an observer during a runtime cache hit', async () => {
  const source = producer();
  const mesh = (
    await source.admit(
      (await prepareRuntimePackContent(id, { box: createBoxGeometry(1, 2, 3).unwrap() })).unwrap(),
    )
  ).unwrap();
  const guid = defined(mesh.rows[0]).guid;
  const runtime = createAssetSource({
    decoders: new DecoderRegistry(),
    catalog: source.catalog,
    scopeId: 'test-runtime',
    fetcher: source.fetch,
  });
  const kind = defineAssetKind<Uint8Array, 'mesh'>('mesh');
  runtime.installDecoder(kind, {
    decode: (input) => input.artifacts.read(defined(input.envelope.artifacts.body)),
  });
  (await runtime.load(guid, kind)).unwrap();
  const hits = runtime.snapshot().counters.cacheHits;
  let changed = false;
  runtime.subscribe((snapshot) => {
    if (!changed && snapshot.counters.cacheHits > hits) {
      changed = true;
      source.withdraw(id);
    }
  });
  expect((await runtime.load(guid, kind)).ok).toBe(false);
  expect(changed).toBe(true);
  expect(runtime.snapshot().ready).not.toContain(guid);
  runtime.dispose();
  source.dispose();
});
it.each([
  'legacy',
  'runtime',
])('fences a %s definition when a referenced dependency changes during its read', async (mode) => {
  const source = producer();
  const mesh = (
    await source.admit(
      (
        await prepareRuntimePackContent(other, { box: createBoxGeometry(1, 2, 3).unwrap() })
      ).unwrap(),
    )
  ).unwrap();
  const dependency = defined(defined(mesh.publication).outputs[0]);
  const content = (
    await prepareRuntimePackContent(
      id,
      {
        behavior: {
          kind: 'plugin',
          module: { specifier: './behavior.js' },
          config: { target: { $asset: dependency.guid } },
        },
      },
      {
        dependencies: { [dependency.guid]: dependency.digest },
        programs: {
          'project:behavior.js#default': {
            artifact: preparePackProgram({
              entry: 'behavior.js',
              export: 'default',
              modules: { 'behavior.js': 'export default { apply() {} };' },
            }).unwrap(),
          },
        },
      },
    )
  ).unwrap();
  const accepted = (await source.admit(content)).unwrap();
  const row = defined(accepted.rows[0]);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const catalog: CatalogSource = {
    ...source.catalog,
    openPackage(url) {
      const fetcher = defined(source.catalog.openPackage(url));
      return async (input, init) => {
        if (String(input) === row.packageUrl) {
          enter();
          await gate;
        }
        return fetcher(input, init);
      };
    },
  };
  const legacy = new AssetRegistry({ scopeId: 'test-runtime', shaderRegistry: {} as never });
  legacy.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  legacy.installDecoder(materialContribution.kind, materialContribution.decoder);
  legacy.setCatalogSource(catalog, source.fetch);
  const runtime = new AssetRegistry({ catalog, scopeId: 'test-runtime', fetcher: source.fetch });
  runtime.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  runtime.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    const pending =
      mode === 'legacy'
        ? legacy.readPluginDefinition(row.guid)
        : runtime.readPluginDefinition(row.guid);
    await entered;
    source.withdraw(other);
    (
      await source.admit(
        (
          await prepareRuntimePackContent(other, { box: createBoxGeometry(4, 2, 3).unwrap() })
        ).unwrap(),
      )
    ).unwrap();
    resume();
    expect((await pending).ok).toBe(false);
  } finally {
    resume();
    legacy.clearCatalogSource();
    runtime.dispose();
    source.dispose();
  }
});
describe('runtime Pack production through real codecs and readers', () => {
  it('admits a new Mesh, persists complete data and rejects conflicting content atomically', async () => {
    const source = producer();
    const assets = reader(source);
    expect((await assets.enumerateCatalog()).unwrap()).toHaveLength(0);
    const mesh = createBoxGeometry(2, 3, 4).unwrap();
    const content = (await prepareRuntimePackContent(id, { box: mesh })).unwrap();
    const admitted = await source.admit(content);
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    const guid = outputGuid(id);
    const loaded = (await loadFixtureAsset(assets, guid, 'mesh')).unwrap();
    expect(loaded.attributes.position).toEqual(mesh.attributes.position);
    expect((await source.admit(structuredClone(content))).ok).toBe(true);
    const conflicting = (
      await prepareRuntimePackContent(id, { box: createBoxGeometry(4, 3, 4).unwrap() })
    ).unwrap();
    expect(await source.admit(conflicting)).toMatchObject({
      ok: false,
      error: { code: 'runtime-pack-conflict' },
    });
    const saved = JSON.stringify(source.snapshot());
    source.dispose();
    const restored = producer();
    expect((await restored.restore(JSON.parse(saved))).ok).toBe(true);
    const restoredAssets = reader(restored);
    expect(
      (await loadFixtureAsset(restoredAssets, guid, 'mesh')).unwrap().attributes.position,
    ).toEqual(mesh.attributes.position);
    restored.dispose();
    assets.clearCatalogSource();
    restoredAssets.clearCatalogSource();
  });
  it('executes new JS, isolates instance caches and restores accepted parameters after a failed edit', async () => {
    const cache = new Map<string, RuntimePackCacheEntry>();
    const source = producer(cache);
    expect((await source.admit(generator())).ok).toBe(true);
    expect(source.rows()).toHaveLength(0);
    const firstGeneration = await source.generate(instance(id, 2));
    expect(firstGeneration.ok, JSON.stringify(firstGeneration)).toBe(true);
    expect((await source.generate(instance(other, 2))).ok).toBe(true);
    expect(cache.size).toBe(2);
    expect((await source.generate(instance(id, 2))).ok).toBe(true);
    expect(cache.size).toBe(2);
    const assets = reader(source);
    const guid = outputGuid(id);
    const first = (await loadFixtureAsset(assets, guid, 'mesh')).unwrap();
    expect((await source.generate(instance(id, 4))).ok).toBe(true);
    (
      await assets.reload(defined(runtimeAssetReference(assets, guid)), { conflict: 'overwrite' })
    ).unwrap();
    const next = (await loadFixtureAsset(assets, guid, 'mesh')).unwrap();
    expect(next.attributes.position).not.toEqual(first.attributes.position);
    expect((await source.generate(instance(id, 100))).ok).toBe(false);
    expect(
      source.inspect().executions.find((item) => item.instance.packageId === id),
    ).toMatchObject({ status: 'failed', lastKnownGood: { values: { width: 4 } } });
    const saved = JSON.parse(JSON.stringify(source.snapshot()));
    cache.clear();
    source.dispose();
    const restored = producer(cache);
    const result = await restored.restore(saved);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const recoveredAssets = reader(restored);
    expect(
      (await loadFixtureAsset(recoveredAssets, guid, 'mesh')).unwrap().attributes.position,
    ).toEqual(next.attributes.position);
    restored.dispose();
    assets.clearCatalogSource();
    recoveredAssets.clearCatalogSource();
  });
  it('rejects late results and withdrawal races', async () => {
    const source = producer();
    expect(
      (
        await source.admit(
          generator(
            'await new Promise(resolve => setTimeout(resolve, values.width === 1 ? 30 : 0));',
          ),
        )
      ).ok,
    ).toBe(true);
    const slow = source.generate(instance(id, 1));
    const fast = await source.generate(instance(id, 3));
    expect(fast.ok, JSON.stringify(fast)).toBe(true);
    expect(await slow).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
    const pending = source.generate(instance(id, 1));
    source.withdraw(id);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
    expect(source.rows()).toHaveLength(0);
    source.dispose();
  });
});
it('captures external producer originals during admission and recovers after that producer disappears', async () => {
  const external = producer();
  const direct = (
    await prepareRuntimePackContent(other, { box: createBoxGeometry(3, 4, 5).unwrap() })
  ).unwrap();
  const publication = (await external.admit(direct)).unwrap();
  const output = defined(defined(publication.publication).outputs[0]);
  const assets = reader(external);
  const assetSource: NonNullable<RuntimePackProducerOptions['assetSource']> = {
    exportSource: (versions) => external.exportSource(versions),
  };
  const source = producer(undefined, assetSource);
  const original = generator();
  (
    await source.admit({
      ...original,
      source: {
        ...original.source,
        runtime: { dependencies: [output.guid] },
      } as RuntimePackContent['source'],
      dependencies: { [output.guid]: output.digest },
    })
  ).unwrap();
  const saved = source.snapshot();
  expect(
    Object.values(defined(saved.closure).contents).some((content) => content.blobs !== undefined),
  ).toBe(true);
  source.dispose();
  external.dispose();
  assets.clearCatalogSource();
  const recovered = producer();
  const result = await recovered.restore(JSON.parse(JSON.stringify(saved)));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  (await recovered.generate(instance(id, 2))).unwrap();
  recovered.dispose();
  const tampered = parseRuntimePackSnapshot(saved);
  const key = defined(Object.keys(defined(tampered.closure).contents)[0]);
  (defined(tampered.closure).contents as Record<string, RuntimePackContent>)[key] = generator();
  const rejected = producer();
  expect(await rejected.restore(tampered)).toMatchObject({
    ok: false,
    error: { code: 'runtime-pack-dependency-unavailable' },
  });
  expect(rejected.rows()).toEqual([]);
  rejected.dispose();
});
it('captures an external PluginAsset whose saved source retains another asset reference', async () => {
  const external = producer();
  const mesh = defined(
    defined(
      (
        await external.admit(
          (
            await prepareRuntimePackContent(other, {
              box: createBoxGeometry(3, 4, 5).unwrap(),
            })
          ).unwrap(),
        )
      ).unwrap().publication,
    ).outputs[0],
  );
  const program = 'project:behavior.js#default';
  const plugin = defined(
    defined(
      (
        await external.admit(
          (
            await prepareRuntimePackContent(
              id,
              {
                behavior: {
                  kind: 'plugin',
                  module: { specifier: './behavior.js' },
                  config: { mesh: { $asset: mesh.guid } },
                },
              },
              {
                dependencies: { [mesh.guid]: mesh.digest },
                programs: {
                  [program]: {
                    artifact: preparePackProgram({
                      entry: 'behavior.js',
                      export: 'default',
                      modules: {
                        'behavior.js':
                          'export default { apply() { throw new Error("definition read must not activate"); } };',
                      },
                    }).unwrap(),
                  },
                },
              },
            )
          ).unwrap(),
        )
      ).unwrap().publication,
    ).outputs[0],
  );
  const externalReader = reader(external);
  const pluginOriginal = await external.exportSource(new Map([[plugin.guid, plugin.digest]]));
  const source = producer(undefined, {
    exportSource: (versions) => external.exportSource(versions),
  });
  const content = generator();
  const admitted = await source.admit({
    ...content,
    source: {
      ...content.source,
      runtime: { dependencies: [plugin.guid] },
    } as RuntimePackContent['source'],
    dependencies: { [plugin.guid]: plugin.digest },
  });
  expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
  const saved = JSON.parse(JSON.stringify(source.snapshot()));
  externalReader.clearCatalogSource();
  external.dispose();
  source.dispose();
  const restored = producer();
  const result = await restored.restore(saved);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  (await restored.generate(instance(id, 2))).unwrap();
  expect(restored.rows().some((row) => row.guid === plugin.guid || row.guid === mesh.guid)).toBe(
    false,
  );
  restored.dispose();
  const consumer = producer();
  const recovered = await consumer.restore(pluginOriginal);
  expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
  const consumerReader = reader(consumer);
  expect((await consumerReader.readPluginDefinition(plugin.guid)).ok).toBe(true);
  expect(
    (await loadFixtureAsset(consumerReader, mesh.guid, 'mesh')).unwrap().attributes.position,
  ).toEqual(createBoxGeometry(3, 4, 5).unwrap().attributes.position);
  consumerReader.clearCatalogSource();
  consumer.dispose();
});
it('refuses a seeded old dependency that overlaps a candidate output', async () => {
  const source = producer();
  const publication = (
    await source.admit(
      (
        await prepareRuntimePackContent(id, {
          box: createBoxGeometry(2, 3, 4).unwrap(),
        })
      ).unwrap(),
    )
  ).unwrap();
  const result = await validateAssetPublication(publication.rows, source.fetch, undefined, {
    ...{
      dependencies: new Map([
        [
          outputGuid(id),
          { asset: createBoxGeometry(9, 9, 9).unwrap(), row: defined(publication.rows[0]) },
        ],
      ]),
    },
    decoders: runtimePackDecoders,
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
  source.dispose();
});
it('preserves distinct transitive recipes even when the pinned GUID and output bytes are identical', async () => {
  const source = producer();
  const publishDependency = async (width: number) => {
    const result = (
      await source.admit(
        (
          await prepareRuntimePackContent(other, { box: createBoxGeometry(width, 2, 3).unwrap() })
        ).unwrap(),
      )
    ).unwrap();
    return defined(defined(result.publication).outputs[0]);
  };
  const dependent = (
    packageId: string,
    dependency: {
      guid: string;
      digest: string;
    },
  ): RuntimePackContent => {
    const content = generator();
    return {
      ...content,
      source: {
        ...content.source,
        packageId,
        runtime: { dependencies: [dependency.guid] },
      } as RuntimePackContent['source'],
      dependencies: { [dependency.guid]: dependency.digest },
    };
  };
  const oldDependency = await publishDependency(1);
  (await source.admit(dependent(parent, oldDependency))).unwrap();
  const first = defined(
    defined((await source.generate(instance(id, 2))).unwrap().publication).outputs[0],
  );
  const consumer1 = dependent('01900000-0000-7000-8000-000000000104', first);
  (await source.admit(consumer1)).unwrap();
  source.withdraw(parent);
  source.withdraw(other);
  const newDependency = await publishDependency(4);
  (await source.admit(dependent(parent, newDependency))).unwrap();
  const second = defined(
    defined((await source.generate(instance(id, 2))).unwrap().publication).outputs[0],
  );
  expect(second.digest).toBe(first.digest);
  const consumer2 = dependent('01900000-0000-7000-8000-000000000105', second);
  (await source.admit(consumer2)).unwrap();
  const saved = source.snapshot();
  const left = defined(defined(saved.closure).bindings[scriptablePackFingerprint(consumer1)])[
    first.guid
  ];
  const right = defined(defined(saved.closure).bindings[scriptablePackFingerprint(consumer2)])[
    second.guid
  ];
  expect(left).not.toBe(right);
  source.dispose();
  const restored = producer();
  const result = await restored.restore(JSON.parse(JSON.stringify(saved)));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(defined(restored.snapshot().closure).bindings).toEqual(defined(saved.closure).bindings);
  restored.dispose();
});
it('saves only reachable dependency recipes and restores the pinned version after its source was updated and withdrawn', async () => {
  const source = producer();
  (await source.admit(generator())).unwrap();
  const first = (await source.generate(instance(id, 2))).unwrap();
  const dependency = defined(defined(first.publication).outputs[0]);
  const base = generator();
  const programId = 'project:fixed.js#build';
  const dependent: RuntimePackContent = {
    source: {
      ...base.source,
      packageId: other,
      program: programId,
      runtime: { dependencies: [dependency.guid] },
    } as RuntimePackContent['source'],
    dependencies: { [dependency.guid]: dependency.digest },
    programs: {
      [programId]: {
        artifact: preparePackProgram({
          entry: 'fixed.js',
          export: 'build',
          imports: { pack: 'test-engine' },
          modules: {
            'fixed.js': `import { AssetGuid } from 'pack'; export async function build({ readByGuid }) { const parsed = AssetGuid.parse(${JSON.stringify(dependency.guid)}); if (!parsed.ok) return parsed; const result = await readByGuid(parsed.value); if (!result.ok) return result; return { ok: true, value: { box: result.value } }; }`,
          },
        }).unwrap(),
      },
    },
  };
  (await source.admit(dependent)).unwrap();
  const dependentId = '01900000-0000-7000-8000-000000000104';
  const dependentInstance = { ...instance(dependentId, 1), parent: other };
  {
    const result = await source.generate(dependentInstance);
    expect(
      result.ok,
      JSON.stringify(result, (_, value) =>
        value instanceof Error ? { ...value, message: value.message } : value,
      ),
    ).toBe(true);
  }
  (await source.generate(instance(id, 4))).unwrap();
  source.withdraw(parent);
  // The admitted generator continues using its exact old snapshot.
  {
    const result = await source.generate(dependentInstance);
    expect(
      result.ok,
      JSON.stringify(result, (_, value) =>
        value instanceof Error ? { ...value, message: value.message } : value,
      ),
    ).toBe(true);
  }
  const saved = JSON.parse(JSON.stringify(source.snapshot()));
  expect(saved.packs).toHaveLength(1);
  expect(Object.values(saved.closure.contents)).toHaveLength(1);
  expect(Object.values(saved.closure.recipes)).toHaveLength(1);
  expect(JSON.stringify(saved.closure)).not.toContain('blobs');
  source.dispose();
  const restored = producer();
  const recovery = await restored.restore(saved);
  expect(recovery.ok, JSON.stringify(recovery)).toBe(true);
  const assets = reader(restored);
  const mesh = (await loadFixtureAsset(assets, outputGuid(dependentId), 'mesh')).unwrap();
  expect(mesh.attributes.position).toEqual(createBoxGeometry(2, 2, 3).unwrap().attributes.position);
  expect(restored.rows().some((row) => row.guid === dependency.guid)).toBe(false);
  restored.withdraw(other);
  expect(restored.snapshot().closure).toBeUndefined();
  assets.clearCatalogSource();
  restored.dispose();
});
it('fences concurrent direct admission against an instance claiming the same identity', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  const source: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'race',
    imports: {
      geometry: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-geometry') },
    },
    validate: async (state, fetcher) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return validateAssetPublication(
        state.rows,
        fetcher,
        {
          catalog: source.catalog,
          fetcher: source.fetch,
        },
        { decoders: runtimePackDecoders },
      );
    },
  });
  (await source.admit(generator())).unwrap();
  const direct = (
    await prepareRuntimePackContent(id, { box: createBoxGeometry(5, 5, 5).unwrap() })
  ).unwrap();
  const pending = source.admit(direct);
  await started;
  (await source.generate(instance(id, 2))).unwrap();
  resume();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime-pack-conflict' } });
  expect(source.snapshot().packs.map((pack) => pack.source.packageId)).toEqual([parent]);
  source.dispose();
});
it.each([
  'withdraw',
  'request',
] as const)('cancels admission via %s while validation is in flight', async (mode) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const source = new RuntimePackProducer({
    scopeId: 'withdraw',
    validate: async (state, fetcher) => {
      entered();
      await gate;
      return validateAssetPublication(state.rows, fetcher, undefined, {
        decoders: runtimePackDecoders,
      });
    },
  });
  const content = (
    await prepareRuntimePackContent(id, { box: createBoxGeometry(2, 2, 2).unwrap() })
  ).unwrap();
  const controller = new AbortController();
  const pending = source.admit(content, controller.signal);
  await started;
  if (mode === 'withdraw') source.withdraw(id);
  else controller.abort();
  resume();
  expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
  expect(source.rows()).toEqual([]);
  expect(source.snapshot().packs).toEqual([]);
  // Request cancellation cannot poison the identity for another caller.
  expect((await source.admit(content)).ok).toBe(true);
  expect(source.snapshot().packs).toHaveLength(1);
  source.dispose();
});
it('discards corrupted or cross-instance cache entries and rebuilds from preserved programs', async () => {
  const cache = new Map<string, RuntimePackCacheEntry>();
  const source = producer(cache);
  (await source.admit(generator())).unwrap();
  (await source.generate(instance(id, 2))).unwrap();
  (await source.generate(instance(other, 4))).unwrap();
  const [first, second] = [...cache.entries()];
  cache.set(defined(first)[0], defined(second)[1]);
  (await source.generate(instance(id, 2))).unwrap();
  const invalid = structuredClone(defined(cache.get(defined(first)[0])));
  if (!('assets' in invalid.content.source)) throw new Error('expected cached direct output');
  const badContent = {
    ...invalid.content,
    source: {
      ...invalid.content.source,
      assets: { box: { kind: 'mesh', payload: {}, refs: [], artifacts: {} } },
    },
  };
  cache.set(defined(first)[0], {
    ...invalid,
    content: badContent,
    digest: scriptablePackFingerprint(badContent),
  });
  (await source.generate(instance(id, 2))).unwrap();
  const assets = reader(source);
  expect(
    (await loadFixtureAsset(assets, outputGuid(id), 'mesh')).unwrap().attributes.position,
  ).toEqual(createBoxGeometry(2, 2, 3).unwrap().attributes.position);
  expect(
    (await loadFixtureAsset(assets, outputGuid(other), 'mesh')).unwrap().attributes.position,
  ).toEqual(createBoxGeometry(4, 2, 3).unwrap().attributes.position);
  source.dispose();
  assets.clearCatalogSource();
});

it('does not start another saved generator after cancellation during recovery preflight', async () => {
  const counters = globalThis as typeof globalThis & { runtimePackRestoreStarts?: number };
  counters.runtimePackRestoreStarts = 0;
  const original = producer();
  let restored: RuntimePackProducer | undefined;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  try {
    (await original.admit(generator('globalThis.runtimePackRestoreStarts++;'))).unwrap();
    (await original.generate(instance(id, 2))).unwrap();
    (await original.generate(instance(other, 3))).unwrap();
    const saved = original.snapshot();
    counters.runtimePackRestoreStarts = 0;
    restored = new RuntimePackProducer({
      scopeId: 'restore-cancel',
      imports: {
        geometry: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-geometry') },
      },
      async validate(state, fetcher) {
        if (state.rows.length) {
          enter();
          await gate;
        }
        return validateAssetPublication(state.rows, fetcher, undefined, {
          decoders: runtimePackDecoders,
        });
      },
    });
    const controller = new AbortController();
    const pending = restored.restore(saved, controller.signal);
    await entered;
    controller.abort();
    resume();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime-pack-cancelled' } });
    expect(counters.runtimePackRestoreStarts).toBe(1);
    expect(restored.rows()).toEqual([]);
    expect(restored.snapshot().packs).toEqual([]);
  } finally {
    resume();
    restored?.dispose();
    original.dispose();
    delete counters.runtimePackRestoreStarts;
  }
});
it('restores dependencies and retains old artifacts only in bound in-flight publications', async () => {
  const source = producer();
  (await source.admit(generator())).unwrap();
  const first = (await source.generate(instance(id, 2))).unwrap();
  const dependency = defined(defined(first.publication).outputs[0]);
  const content = generator();
  const dependent: RuntimePackContent = {
    ...content,
    source: {
      ...content.source,
      packageId: other,
      runtime: { dependencies: [dependency.guid] },
    } as RuntimePackContent['source'],
    dependencies: { [dependency.guid]: dependency.digest },
  };
  (await source.admit(dependent)).unwrap();
  const snapshot = source.snapshot();
  source.dispose();
  const restored = producer();
  const result = await restored.restore(JSON.parse(JSON.stringify(snapshot)));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const previous = defined(restored.rows().find((row) => row.guid === dependency.guid));
  const bound = defined(restored.catalog.openPackage(previous.packageUrl));
  const pack = (await (await bound(previous.packageUrl)).json()) as PackV2;
  (await restored.generate(instance(id, 4))).unwrap();
  const descriptor = defined(defined(pack.assets[0]).artifacts.body);
  expect((await bound(new URL(descriptor.path, previous.packageUrl).href)).status).toBe(200);
  expect((await restored.fetch(new URL(descriptor.path, previous.packageUrl).href)).status).toBe(
    404,
  );
  expect(restored.catalog.openPackage(previous.packageUrl)).toBeUndefined();
  restored.dispose();
  expect((await bound(new URL(descriptor.path, previous.packageUrl).href)).status).toBe(200);
});
it.each([
  'legacy',
  'runtime',
] as const)('%s reader pins the selected publication through delayed artifact decode', async (mode) => {
  const source = producer();
  (await source.admit(generator())).unwrap();
  const published = (await source.generate(instance(id, 2))).unwrap();
  const row = defined(published.rows[0]);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let opens = 0;
  // This reader owns a stable snapshot while the producer moves to a newer one.
  const catalog: CatalogSource = {
    enumerate: async () => ok(published.rows),
    subscribe: () => () => {},
    openPackage(url) {
      opens++;
      const bound = defined(source.catalog.openPackage(url));
      return async (input, init) => {
        if (String(input) === row.packageUrl) {
          enter();
          await gate;
        }
        return bound(input, init);
      };
    },
  };
  const legacy = new AssetRegistry({ scopeId: 'test-runtime', shaderRegistry: {} as never });
  legacy.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  legacy.installDecoder(materialContribution.kind, materialContribution.decoder);
  legacy.setCatalogSource(catalog, async () => {
    throw new Error('unbound transport');
  });
  const runtime = new AssetRegistry({
    catalog,
    scopeId: 'test-runtime',
    fetcher: async () => {
      throw new Error('unbound transport');
    },
  });
  runtime.installDecoder(materialContribution.kind, materialContribution.decoder);
  runtime.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  try {
    const pending =
      mode === 'legacy'
        ? loadFixtureAsset(legacy, row.guid, 'mesh')
        : loadFixtureAsset(runtime, row.guid, 'mesh');
    await entered;
    (await source.generate(instance(id, 4))).unwrap();
    expect(source.catalog.openPackage(row.packageUrl)).toBeUndefined();
    resume();
    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(opens).toBe(1);
    expect(result.unwrap().attributes.position).toEqual(
      createBoxGeometry(2, 2, 3).unwrap().attributes.position,
    );
  } finally {
    resume();
    legacy.clearCatalogSource();
    runtime.dispose();
    source.dispose();
  }
});

it('rejects unsupported source tool contracts instead of silently publishing a plugin without its tools', async () => {
  const source = producer();
  const plugin = { kind: 'plugin' as const, module: { specifier: './plugin.js' } };
  const programs = {
    plugin: {
      artifact: preparePackProgram({
        entry: 'plugin.js',
        export: 'default',
        modules: {
          'plugin.js': 'throw new Error("admission must not evaluate"); export default () => {};',
        },
      }).unwrap(),
    },
  };
  try {
    const tools = { ...plugin, toolContract: { specifier: './contract.js' } };
    expect((await prepareRuntimePackContent(id, { behavior: tools }, { programs })).ok).toBe(false);
    const prepared = (
      await prepareRuntimePackContent(id, { behavior: plugin }, { programs })
    ).unwrap();
    const invalid = structuredClone(prepared);
    if (!('assets' in invalid.source)) throw new Error('expected direct Pack source');
    const output = defined(invalid.source.assets.behavior);
    (output.payload as Record<string, unknown>).toolContract = tools.toolContract;
    expect((await source.admit(invalid)).ok).toBe(false);
    expect(source.rows()).toEqual([]);
    expect(source.snapshot().packs).toEqual([]);
  } finally {
    source.dispose();
  }
});

// Publication data stays JSON-durable without one JavaScript property per byte.
it('keeps generated binary content compact through admission and JSON restore', async () => {
  const mesh = createBoxGeometry(2, 3, 4).unwrap();
  const content = (await prepareRuntimePackContent(id, { box: mesh })).unwrap();
  expect(Object.values(content.blobs ?? {}).every((blob) => typeof blob === 'string')).toBe(true);
  const source = producer();
  const restored = producer();
  try {
    (await source.admit(content)).unwrap();
    (await restored.restore(JSON.parse(JSON.stringify(source.snapshot())))).unwrap();
    const assets = reader(restored);
    const result = (await loadFixtureAsset(assets, outputGuid(id), 'mesh')).unwrap();
    expect(result.vertices).toEqual(mesh.vertices);
    expect(result.indices).toEqual(mesh.indices);
    assets.clearCatalogSource();
    assets.invalidateAll();
  } finally {
    source.dispose();
    restored.dispose();
  }
});

it('loads an admitted generator once across parameter edits and retries failed delivery', async () => {
  const url = `data:text/javascript,${encodeURIComponent(`import { createBoxGeometry } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-geometry'))}; export function build({values}) { return {ok:true,value:{box:createBoxGeometry(values.width,2,3).unwrap()}}; }`)}`;
  const publish = vi
    .fn()
    .mockRejectedValueOnce(new Error('delivery interrupted'))
    .mockResolvedValue(url);
  const source = producer(undefined, undefined, { publish });
  try {
    (await source.admit(generator())).unwrap();
    expect((await source.generate(instance(id, 1))).ok).toBe(false);
    (await source.generate(instance(id, 2))).unwrap();
    (await source.generate(instance(id, 3))).unwrap();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(source.rows()).toHaveLength(1);
  } finally {
    source.dispose();
  }
});

it('honors abort during duplicate admission hashing', async () => {
  const source = producer();
  try {
    const content = generator();
    (await source.admit(content)).unwrap();
    const cancellation = new AbortController();
    const pending = source.admit(content, cancellation.signal);
    cancellation.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('runtime-pack-cancelled');
  } finally {
    source.dispose();
  }
});

it('hashes and consumes one private cache snapshot across asynchronous hashing', async () => {
  const cache = new Map<string, RuntimePackCacheEntry>();
  const source = producer(cache);
  const assets = reader(source);
  try {
    (await source.admit(generator())).unwrap();
    (await source.generate(instance(id, 2))).unwrap();
    const cached = defined([...cache.values()][0]);
    const replacement = (
      await prepareRuntimePackContent(
        id,
        { box: createBoxGeometry(5, 2, 3).unwrap() },
        { programs: cached.content.programs },
      )
    ).unwrap();
    const pending = source.generate(instance(id, 2));
    Object.assign(cached.content, replacement);
    (await pending).unwrap();
    const mesh = (await loadFixtureAsset(assets, outputGuid(id), 'mesh')).unwrap();
    expect(mesh.aabb?.[3]).toBe(1);
  } finally {
    assets.clearCatalogSource();
    assets.invalidateAll();
    source.dispose();
  }
});

it('restores existing numeric-byte snapshots with their original content identities', async () => {
  const mesh = createBoxGeometry(2, 3, 4).unwrap();
  const prepared = (await prepareRuntimePackContent(id, { box: mesh })).unwrap();
  const legacy: RuntimePackContent = {
    ...prepared,
    blobs: Object.fromEntries(
      Object.entries(prepared.blobs ?? {}).map(([key, value]) => [
        key,
        Array.from(decodePackBlob(value)),
      ]),
    ),
  };
  const source = producer();
  const restored = producer();
  const assets = reader(restored);
  try {
    const state = (await source.admit(legacy)).unwrap();
    const output = defined(state.rows[0]?.publication?.outputs[0]);
    const saved = await source.exportSource(new Map([[output.guid, output.digest]]));
    (await restored.restore(JSON.parse(JSON.stringify(saved)))).unwrap();
    const loaded = (await loadFixtureAsset(assets, output.guid, 'mesh')).unwrap();
    expect(loaded.vertices).toEqual(mesh.vertices);
    expect(loaded.indices).toEqual(mesh.indices);
  } finally {
    assets.clearCatalogSource();
    assets.invalidateAll();
    restored.dispose();
    source.dispose();
  }
});

it.each([
  'valid',
  'missing',
  'wrong-digest',
  'duplicate-root',
  'cancel',
] as const)('captures sibling dependency outputs in one owned batch (%s)', async (mode) => {
  const external = producer();
  const state = (
    await external.admit(
      (
        await prepareRuntimePackContent(other, {
          left: { kind: 'sampler' },
          right: { kind: 'sampler' },
        })
      ).unwrap(),
    )
  ).unwrap();
  const outputs = defined(state.publication).outputs;
  const versions = new Map(outputs.map((output) => [output.guid, output.digest]));
  const controller = new AbortController();
  let calls = 0;
  const source = producer(undefined, {
    exportSource: async (requested) => {
      calls++;
      expect(requested).toEqual(versions);
      const saved = await external.exportSource(requested);
      // A callback cannot change the producer's request by retaining its Map.
      (requested as Map<string, string>).clear();
      if (mode === 'cancel') controller.abort();
      if (mode === 'missing') return { ...saved, recipeRoots: [] };
      if (mode === 'duplicate-root')
        return {
          ...saved,
          recipeRoots: [...defined(saved.recipeRoots), ...defined(saved.recipeRoots)],
        };
      if (mode === 'wrong-digest') {
        const rootId = defined(saved.recipeRoots?.[0]);
        const recipe = defined(saved.closure?.recipes[rootId]);
        const changed = {
          ...recipe,
          outputs: recipe.outputs.map((output) => ({
            ...output,
            digest: `sha256:${'f'.repeat(64)}`,
          })),
        };
        const changedId = scriptablePackFingerprint(changed);
        return {
          ...saved,
          recipeRoots: [changedId],
          closure: { ...defined(saved.closure), recipes: { [changedId]: changed } },
        };
      }
      return saved;
    },
  });
  try {
    const content = (
      await prepareRuntimePackContent(
        id,
        { sampler: { kind: 'sampler' } },
        { dependencies: Object.fromEntries(versions) },
      )
    ).unwrap();
    const result = await source.admit(content, controller.signal);
    expect(calls).toBe(1);
    expect(result.ok).toBe(mode === 'valid');
    if (mode === 'valid') {
      const saved = JSON.parse(JSON.stringify(source.snapshot()));
      external.dispose();
      const restored = producer();
      try {
        expect((await restored.restore(saved)).ok).toBe(true);
      } finally {
        restored.dispose();
      }
    } else expect(source.rows()).toEqual([]);
  } finally {
    source.dispose();
    external.dispose();
  }
});

it('retains a prepared mesh distance field through native publication, JSON transport and restore', async () => {
  const source = producer();
  const restored = producer();
  const assets = reader(source);
  const mesh = createBoxGeometry(2, 3, 4).unwrap();
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array) || !mesh.indices)
    throw new Error('expected indexed box');
  const field = (
    await buildVisibilityDistanceField(positions, mesh.indices, {
      voxelSize: 0.5,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
  const prepared: MeshAsset = {
    ...mesh,
    distanceField: { ...field, sectionSidedness: mesh.submeshes.map(() => 0 as const) },
  };
  const encoded = (await encodeMeshDistanceField(field)).unwrap();
  const artifact = {
    integrity: {
      algorithm: 'sha256',
      digest: `sha256:${createHash('sha256').update(encoded).digest('hex')}`,
    },
    assetCodec: MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  };
  const content = (await prepareRuntimePackContent(id, { box: prepared })).unwrap();
  const legacy = new AssetRegistry({ scopeId: 'test-runtime', shaderRegistry: {} as never });
  legacy.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  legacy.installDecoder(materialContribution.kind, materialContribution.decoder);
  try {
    const admitted = (await source.admit(content)).unwrap();
    const row = defined(admitted.rows[0]);
    const native = (await loadFixtureAsset(assets, row.guid, 'mesh')).unwrap();
    expect(native.distanceField?.values).toEqual(field.values);
    expect(native.distanceField).toMatchObject({ artifact });
    // The same publication reads through the source-owned transport after JSON serialization.
    const wireRow = structuredClone(row);
    legacy.setCatalogSource(
      {
        expectedScope: source.catalog.expectedScope,
        enumerate: async () => ok([wireRow]),
        subscribe: () => () => {},
        openPackage: source.catalog.openPackage,
      },
      source.fetch,
    );
    const wire = (await loadFixtureAsset(legacy, row.guid, 'mesh')).unwrap();
    expect(wire.distanceField?.meshDigest).toBe(field.meshDigest);
    expect(wire.distanceField?.values).toEqual(field.values);
    expect(wire.distanceField).toMatchObject({ artifact });
    (await restored.restore(JSON.parse(JSON.stringify(source.snapshot())))).unwrap();
    const recovered = reader(restored);
    try {
      const mesh = (await loadFixtureAsset(recovered, row.guid, 'mesh')).unwrap();
      expect(mesh.distanceField?.values).toEqual(field.values);
      expect(mesh.distanceField).toMatchObject({ artifact });
    } finally {
      recovered.clearCatalogSource();
      recovered.invalidateAll();
    }
    for (const invalid of [
      { ...prepared, morphTargets: [{ position: new Float32Array(positions.length) }] },
      {
        ...prepared,
        attributes: {
          ...prepared.attributes,
          skinIndex: new Uint16Array((positions.length / 3) * 4),
        },
      },
      {
        ...prepared,
        distanceField: { ...field, sectionSidedness: [1 as const] },
      },
    ])
      expect((await prepareRuntimePackContent(other, { box: invalid })).ok).toBe(false);
  } finally {
    legacy.clearCatalogSource();
    legacy.invalidateAll();
    assets.clearCatalogSource();
    assets.invalidateAll();
    source.dispose();
    restored.dispose();
  }
});
