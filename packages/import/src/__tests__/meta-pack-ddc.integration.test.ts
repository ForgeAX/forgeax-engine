import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { ok } from '@forgeax/engine-types';
import { afterEach, expect, it } from 'vitest';
import type { RunImportMeta } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';
import { produceSourcePackage } from '../source-package.js';
import { createSourcePackageBuildDdc } from '../source-package-build-product.js';

const GUID = '01900000-0000-7000-8000-0000000000f1';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(material = false, inheritedFs = false) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-meta-pack-ddc-'));
  roots.push(root);
  const source = join(root, 'source.bin'),
    sibling = join(root, 'sibling.bin'),
    cacheRoot = join(root, 'ddc');
  await writeFile(source, new Uint8Array([1]));
  await writeFile(sibling, new Uint8Array([2]));
  const counts = { importer: 0, cooker: 0 };
  const registry = new ImporterRegistry();
  registry.register({
    key: 'fixture',
    async import(context) {
      counts.importer++;
      const primary = await context.readSource(),
        dependency = await context.readSibling('sibling.bin');
      if (!primary.ok) return primary;
      if (!dependency.ok) return dependency;
      const primaryValue = primary.value[0],
        siblingValue = dependency.value[0];
      if (primaryValue === undefined || siblingValue === undefined)
        throw new Error('missing fixture bytes');
      const value = primaryValue + siblingValue;
      return ok({
        assets: [
          {
            guid: GUID,
            kind: material ? 'material' : 'mesh',
            payload: material
              ? {
                  kind: 'material',
                  passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' } }],
                  values: { baseColor: [value / 255, 0.2, 0.3, 1] },
                }
              : {
                  kind: 'mesh',
                  attributes: { position: new Float32Array([value, 0, 0]) },
                  indices: new Uint16Array([0]),
                },
            refs: [],
            artifacts: {},
          },
        ],
        sourceDependencies: [],
      });
    },
  });
  const native = material ? createMaterialPackCooker([], { profile: 'webgpu-storage' }) : undefined;
  const nativeIdentity = native?.cacheIdentity;
  if (material && nativeIdentity === undefined) throw new Error('material cooker identity missing');
  let cookerRevision = 'native-v1';
  let nextCookerRevision: string | undefined;
  const cookers: NativeCooker[] =
    native === undefined
      ? []
      : [
          {
            ...native,
            ...(nativeIdentity === undefined
              ? {}
              : { cacheIdentity: async () => `${cookerRevision}:${await nativeIdentity()}` }),
            async cook(input) {
              counts.cooker++;
              if (nextCookerRevision !== undefined) {
                cookerRevision = nextCookerRevision;
                nextCookerRevision = undefined;
              }
              return native.cook(input);
            },
          },
        ];
  let producer = 'sealed-fixture-v1';
  const meta: RunImportMeta = {
    importer: 'fixture',
    source,
    subAssets: [
      { guid: GUID, sourceIndex: 0, sourceKey: 'main', kind: material ? 'material' : 'mesh' },
    ],
  };
  const capabilities = {
    readSource: async (path: string) => ok(new Uint8Array(await readFile(path))),
    readSibling: async (_source: string, uri: string) =>
      ok(new Uint8Array(await readFile(join(root, uri)))),
    ...(inheritedFs ? { sourceIdentityFor: (path: string) => relative(root, path) } : {}),
  };
  const fs: typeof capabilities = inheritedFs ? Object.create(capabilities) : capabilities;
  const run = async (overrides: Partial<RunImportMeta> = {}) => {
    const ddc = await createSourcePackageBuildDdc({
      root: cacheRoot,
      identityRoot: root,
      producerIdentity: producer,
      cookers,
    });
    if (ddc === undefined) throw Error('missing fixture product DDC');
    const result = await produceSourcePackage({
      meta: { ...meta, ...overrides },
      registry,
      fs,
      cookers,
      ddc,
    });
    if (!result.ok) throw result.error;
    return result.value;
  };
  return {
    root,
    source,
    sibling,
    cacheRoot,
    counts,
    run,
    setProducer(value: string) {
      producer = value;
    },
    setCookerRevision(value: string) {
      cookerRevision = value;
    },
    changeCookerDuringNextCook(value: string) {
      nextCookerRevision = value;
    },
  };
}

it('restores a Meta Pack before repeating import and retains native array ownership', async () => {
  const f = await fixture();
  const first = await f.run(),
    second = await f.run();
  expect(f.counts.importer).toBe(1);
  expect(second).toEqual(first);
  const [firstAsset] = first.product.assets,
    [secondAsset] = second.product.assets;
  if (firstAsset === undefined || secondAsset === undefined)
    throw new Error('missing fixture product');
  const a = firstAsset.payload as { attributes: { position: Float32Array } };
  const b = secondAsset.payload as typeof a;
  expect(b.attributes.position).toBeInstanceOf(Float32Array);
  b.attributes.position[0] = 99;
  expect(a.attributes.position[0]).toBe(3);
  expect((await f.run()).product).toEqual(first.product);
});

it('retains inherited filesystem capabilities when capturing producer reads', async () => {
  const f = await fixture(false, true);
  const first = await f.run();
  expect(first.product.sourceDependencies).toEqual(['source.bin', 'sibling.bin']);
  expect(await f.run()).toEqual(first);
  expect(f.counts.importer).toBe(1);
});

it('uses sibling bytes, Meta settings, declared identities and sealed producer inputs in DDC lookup', async () => {
  const f = await fixture();
  await f.run();
  await f.run();
  expect(f.counts.importer).toBe(1);
  await writeFile(f.sibling, new Uint8Array([4]));
  await f.run();
  await f.run();
  expect(f.counts.importer).toBe(2);
  await writeFile(f.source, new Uint8Array([5]));
  await f.run();
  await f.run();
  expect(f.counts.importer).toBe(3);
  await f.run({ importSettings: { variant: 1 } });
  await f.run({ importSettings: { variant: 1 } });
  expect(f.counts.importer).toBe(4);
  f.setProducer('sealed-fixture-v2');
  await f.run();
  await f.run();
  expect(f.counts.importer).toBe(5);
  const changed = {
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'renamed', kind: 'mesh' as const }],
  };
  await f.run(changed);
  await f.run(changed);
  expect(f.counts.importer).toBe(6);
});

it('recovers through the producer when existing Pack DDC evidence is corrupt', async () => {
  const f = await fixture();
  await f.run();
  const entries = join(f.cacheRoot, 'scriptable-pack-products', 'entries');
  const [key] = await readdir(entries);
  if (key === undefined) throw new Error('DDC product was not written');
  await writeFile(join(entries, key, 'artifacts', 'product.v8.br.bin'), 'damaged');
  await f.run();
  expect(f.counts.importer).toBe(2);
});

it('preserves source read failure when a previously cached sibling disappears', async () => {
  const f = await fixture();
  await f.run();
  await rm(f.sibling);
  await expect(f.run()).rejects.toMatchObject({ code: 'source-read-failed' });
  expect(f.counts.importer).toBe(2);
});

it('does not reimport or recook a real material after its Meta Pack hits existing DDC', async () => {
  const f = await fixture(true);
  const first = await f.run(),
    second = await f.run();
  expect(f.counts).toEqual({ importer: 1, cooker: 1 });
  expect(second.product).toEqual(first.product);
  f.setCookerRevision('native-v2');
  await f.run();
  await f.run();
  expect(f.counts).toEqual({ importer: 2, cooker: 2 });
  await writeFile(f.sibling, new Uint8Array([7]));
  await f.run();
  expect(f.counts).toEqual({ importer: 3, cooker: 3 });
}, 60_000);

it('does not persist a Meta product under a native identity that changed during production', async () => {
  const f = await fixture(true);
  f.changeCookerDuringNextCook('native-during-cook');
  await f.run();
  f.setCookerRevision('native-v1');
  await f.run();
  expect(f.counts).toEqual({ importer: 2, cooker: 2 });
  await f.run();
  expect(f.counts).toEqual({ importer: 2, cooker: 2 });
});
