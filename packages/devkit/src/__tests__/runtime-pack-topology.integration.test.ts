import {
  AssetRegistry,
  resolveAssetHandle,
  validateAssetPublication,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  prepareRuntimePackContent,
  type RuntimePackContent,
  RuntimePackProducer,
} from '@forgeax/engine-import';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId, type PackInstanceJson } from '@forgeax/engine-pack/source';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { prepareRuntimePackProgram } from '../build/pack-program.js';
import { defined } from './assert-defined.js';

const parent = '01900000-0000-7000-8000-000000000101';
const id = '01900000-0000-7000-8000-000000000102';
const other = '01900000-0000-7000-8000-000000000103';
function producer() {
  const value: RuntimePackProducer = new RuntimePackProducer({
    scopeId: 'topology',
    imports: {
      geometry: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-geometry') },
      pack: { identity: 'test-engine', url: import.meta.resolve('@forgeax/engine-pack/source') },
    },
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(
        state.rows,
        fetcher,
        { catalog: value.catalog, fetcher: value.fetch },
        { dependencies },
      ),
  });
  return value;
}
function reader(source: RuntimePackProducer) {
  const assets = new AssetRegistry({} as never);
  assets.setCatalogSource(source.catalog, source.fetch);
  return assets;
}
function instance(packageId: string, width: number): PackInstanceJson {
  return { schemaVersion: '3.0.0', packageId, parent, values: { width } };
}
function outputGuid(packageId: string) {
  return AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'box'));
}
function generator(): RuntimePackContent {
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
  };
}

it.each([
  'js',
  'ts',
] as const)('consumes %s parameter-only dependencies and complete dynamic output topology', async (language) => {
  const source = producer();
  const assets = reader(source);
  const world = new World();
  let handle: Handle<'MeshAsset', 'shared'> | undefined;
  const replace = async () => {
    const payload = (await assets.loadByGuid(assets.parseGuid(outputGuid(id)))).unwrap();
    if (payload.kind !== 'mesh') throw new Error('mesh consumer requires a mesh output');
    const next = world.allocSharedRef('MeshAsset', payload);
    if (handle !== undefined) world.sharedRefs.release(handle).unwrap();
    handle = next;
  };
  const bound = () => resolveAssetHandle<MeshAsset>(world, defined(handle)).unwrap();
  try {
    const direct = (
      await prepareRuntimePackContent(other, { dependency: createBoxGeometry(1, 2, 7).unwrap() })
    ).unwrap();
    const admitted = (await source.admit(direct)).unwrap();
    const dependency = defined(defined(admitted.publication).outputs[0]);
    const input = {
      entry: `generator.${language}`,
      export: 'build',
      imports: { geometry: 'test-engine', pack: 'test-engine' },
      modules: {
        [`generator.${language}`]: `import { createBoxGeometry } from 'geometry';
          import { AssetGuid } from 'pack';
          export async function build({ values, readByGuid }${language === 'ts' ? ': any' : ''}) {
            if (values.width === 5) return { ok: true, value: {} };
            if (values.width === 4) return { ok: true, value: { box: { kind: 'scene', entities: {} } } };
            let depth = 3;
            if (values.width > 1) {
              const parsed = AssetGuid.parse(${JSON.stringify(dependency.guid)});
              if (!parsed.ok) return parsed;
              const result = await readByGuid(parsed.value);
              if (!result.ok) return result;
              depth = result.value.aabb[5] - result.value.aabb[2];
            }
            return { ok: true, value: { box: createBoxGeometry(values.width, 2, depth).unwrap(),
              ...(values.width === 3 ? { extra: createBoxGeometry(1, 1, 1).unwrap() } : {}) } };
          }`,
      },
    };
    // JS never invokes the TypeScript producer. TS contains type syntax and
    // exercises the actual conversion before sharing this admission path.
    const program =
      language === 'js'
        ? { artifact: preparePackProgram(input).unwrap() }
        : prepareRuntimePackProgram(input).unwrap();
    const original = generator();
    (
      await source.admit({
        ...original,
        source: {
          ...original.source,
          runtime: { dependencies: [dependency.guid] },
        } as RuntimePackContent['source'],
        dependencies: { [dependency.guid]: dependency.digest },
        programs: { 'project:runtime/generator.js#build': program },
      })
    ).unwrap();
    const generate = async (width: number) => (await source.generate(instance(id, width))).unwrap();
    await generate(1);
    await replace();
    expect(Array.from(bound().aabb ?? [])).toEqual([-0.5, -1, -1.5, 0.5, 1, 1.5]);
    await generate(2);
    await replace();
    expect(Array.from(bound().aabb ?? [])).toEqual([-1, -1, -3.5, 1, 1, 3.5]);
    await generate(3);
    const extraGuid = AssetGuid.format(AssetGuid.derive(definePackageId(id), 'extra'));
    expect((await assets.loadByGuid(assets.parseGuid(extraGuid))).unwrap().kind).toBe('mesh');
    await replace();
    await generate(2);
    expect((await assets.loadByGuid(assets.parseGuid(extraGuid))).ok).toBe(false);
    await replace();
    const previous = handle;
    await generate(4);
    expect((await assets.loadByGuid(assets.parseGuid(outputGuid(id)))).unwrap().kind).toBe('scene');
    await expect(replace()).rejects.toThrow('requires a mesh output');
    expect(handle).toBe(previous);
    expect(bound().kind).toBe('mesh');
    await generate(5);
    expect(source.rows().filter((row) => row.packageId === id)).toEqual([]);
    await expect(replace()).rejects.toBeDefined();
    expect(handle).toBe(previous);
    expect(world.sharedRefs._liveCount()).toBe(1);
    await generate(1);
    await replace();
    expect(world.sharedRefs._liveCount()).toBe(1);
    // The unselected branch needs no dependency, but selecting it must not
    // read the live catalog unless the source pinned that dependency first.
    source.withdraw(id);
    source.withdraw(parent);
    (
      await source.admit({
        ...original,
        programs: { 'project:runtime/generator.js#build': program },
      })
    ).unwrap();
    await generate(1);
    const acceptedRows = source.rows();
    const rejected = await source.generate(instance(id, 2));
    expect(rejected.ok).toBe(false);
    expect(source.rows()).toEqual(acceptedRows);
    expect(bound().kind).toBe('mesh');
    expect(world.sharedRefs._liveCount()).toBe(1);
  } finally {
    if (handle !== undefined) world.sharedRefs.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
    assets.clearCatalogSource();
    source.dispose();
  }
});
