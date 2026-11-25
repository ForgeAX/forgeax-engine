import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, Serializer, serialize } from 'node:v8';
import { brotliDecompressSync } from 'node:zlib';
import { DdcEntryStore, ddcOutputDigest } from '@forgeax/engine-ddc';
import {
  AssetGuid,
  definePack,
  definePackageId,
  PackageId,
  type PackBuildContextWithoutParameters,
  type PackBuildResult,
} from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import type { ScriptablePackBuildProduct } from '../scriptable-pack-build-core.js';
import { produceScriptablePackProducts } from '../scriptable-pack-host.js';
import {
  createScriptablePackProductCache,
  shareImmutableProductData,
} from '../scriptable-pack-product-cache.js';
import { packDefinition } from './fixtures/pack-definition.js';

const revision = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function preparedSource(
  sourcePath: string,
  packageId: ReturnType<typeof definePackageId>,
  text: string,
  build: (context: PackBuildContextWithoutParameters) => PackBuildResult,
  publicationGeneration = 1,
  packagePath = `${PackageId.format(packageId)}.pack.json`,
): Parameters<typeof produceScriptablePackProducts>[0]['sources'][number] {
  return {
    sourcePath,
    displaySourcePath: sourcePath,
    definition: definePack({ schemaVersion: '2.0.0', packageId, build }),
    sourceClosure: [{ path: sourcePath, digest: revision(text) }],
    publicationGeneration,
    policy: { base: '/', packagePath, artifactPath: (guid, key) => `${guid}/${key}` },
  };
}

function encodeProduct(value: unknown): Buffer {
  const serializer = new Serializer();
  serializer.writeHeader();
  serializer.writeValue(shareImmutableProductData(value));
  return serializer.releaseBuffer();
}

it('encodes only visible typed-array bytes independently of pooled storage', () => {
  const product = (padding: number, capacity: number) => {
    const buffer = new ArrayBuffer(capacity);
    new Uint8Array(buffer).fill(padding);
    const values = new Float32Array(buffer, 16, 3);
    values.set([1, -0, 3.5]);
    return { values, bytes: new Uint8Array(buffer, 16, 12), view: new DataView(buffer, 16, 12) };
  };
  const first = product(17, 128);
  const second = product(233, 256);
  expect(encodeProduct(first)).toEqual(encodeProduct(second));
  const restored = deserialize(encodeProduct(first)) as typeof first;
  deepStrictEqual(restored, first);
  expect(restored.values.buffer).toBe(restored.bytes.buffer);
  expect(restored.values.buffer).toBe(restored.view.buffer);
  expect(restored.values.byteOffset).toBe(16);
  expect([...new Uint8Array(restored.values.buffer, 0, 16)]).toEqual(new Array(16).fill(0));
  expect(restored.values.buffer.byteLength).toBe(28);
  expect(first.values.buffer.byteLength).toBe(128);
  const explicit = { buffer: first.values.buffer, values: first.values };
  const explicitRestored = deserialize(encodeProduct(explicit)) as typeof explicit;
  deepStrictEqual(explicitRestored, explicit);
  expect(explicitRestored.values.buffer).toBe(explicitRestored.buffer);
});

it('normalizes pooled view offsets without losing overlapping aliases', () => {
  const product = () => {
    const pooled = Buffer.allocUnsafe(128);
    pooled.fill(0);
    const first = new Float32Array(pooled.buffer, pooled.byteOffset + 16, 3);
    const firstBytes = new Uint8Array(pooled.buffer, pooled.byteOffset + 16, 12);
    const second = new Float32Array(pooled.buffer, pooled.byteOffset + 64, 3);
    first.set([1, -0, 3.5]);
    second.set([4, 5, 6]);
    return { first, firstBytes, second };
  };
  const first = product();
  const second = product();
  expect(first.first.byteOffset).not.toBe(second.first.byteOffset);
  expect(encodeProduct(first)).toEqual(encodeProduct(second));

  const restored = deserialize(encodeProduct(first)) as ReturnType<typeof product>;
  expect(restored.first.byteOffset).toBe(0);
  expect(restored.second.byteOffset).toBe(0);
  expect(restored.first.buffer).toBe(restored.firstBytes.buffer);
  expect(restored.first.buffer).not.toBe(restored.second.buffer);
  expect([...restored.first]).toEqual([1, -0, 3.5]);
  expect([...restored.second]).toEqual([4, 5, 6]);
});

it('encodes equal strings independently of V8 one-byte or two-byte storage', () => {
  const narrow = 'cache-product'.repeat(100);
  const wide = `\u0100${narrow}`.slice(1);
  expect(narrow).toBe(wide);
  expect(encodeProduct({ text: narrow })).toEqual(encodeProduct({ text: wide }));
  const text = '\ud800x\udfff';
  deepStrictEqual(deserialize(encodeProduct({ text })), { text });
});

const scratch = temporaryDirectories();
afterEach(scratch.clear);

async function persistenceFixture() {
  const root = await scratch.make('forgeax-pack-product-storage-');
  const sourcePath = join(root, 'fixture.pack.ts');
  await writeFile(sourcePath, 'source');
  const subject = {
    sourcePath,
    sourceClosure: [{ path: sourcePath, digest: revision('source') }],
    definition: packDefinition('01900000-0000-7000-8000-0000000000e1', () => ok({})),
  };
  const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
  const store = new DdcEntryStore(join(root, 'scriptable-pack-products'));
  return { cache, store, subject };
}

function fixtureProduct(product: object): ScriptablePackBuildProduct {
  return {
    product,
    stagedOutputs: [],
    externalEvidence: [],
    inputFingerprint: 'sha256:source',
  } as ScriptablePackBuildProduct;
}

async function storedProductBytes(store: DdcEntryStore) {
  const [key] = await store.listKeys();
  const bytes =
    key === undefined ? undefined : (await store.read(key))?.artifacts['product.v8.br']?.bytes;
  if (!bytes) throw new Error('Missing cached Pack product');
  return bytes;
}

it('keeps cached geometry buffers bounded when individual outputs cross a Worker boundary', async () => {
  const { cache, subject } = await persistenceFixture();
  const payloads = Array.from({ length: 64 }, (_, index) => ({
    vertices: new Float32Array(1024).fill(index),
    indices: new Uint32Array([0, 1, 2]),
  }));
  const product = fixtureProduct({
    assets: payloads.map((payload) => ({ kind: 'mesh', payload })),
  });
  await cache.write(subject, product);
  const restored = await cache.read(subject);
  if (!restored) throw new Error('Geometry product was not restored');
  deepStrictEqual(restored, product);
  for (const entry of restored.product.assets) {
    const geometry = structuredClone(entry.payload) as (typeof payloads)[number];
    expect(geometry.vertices.buffer.byteLength).toBe(geometry.vertices.byteLength);
    expect(geometry.indices.buffer.byteLength).toBe(geometry.indices.byteLength);
  }
});

it('preserves shared geometry views and their offsets in the cached product', async () => {
  const { cache, subject } = await persistenceFixture();
  const buffer = new ArrayBuffer(64);
  const vertices = new Float32Array(buffer, 16, 4);
  vertices.set([1, 2, 3, 4]);
  const payload = { vertices, indices: new Uint32Array(buffer, 32, 3), view: new DataView(buffer) };
  const asset = { kind: 'mesh', payload };
  const product = fixtureProduct({ assets: [asset, { ...asset }] });
  await cache.write(subject, product);
  const restored = await cache.read(subject);
  if (!restored) throw new Error('Shared geometry product was not restored');
  deepStrictEqual(restored, product);
  const first = restored.product.assets[0]?.payload as typeof payload;
  expect(first).toBe(restored.product.assets[1]?.payload);
  expect(first.vertices.buffer).toBe(first.indices.buffer);
  expect(first.vertices.buffer).toBe(first.view.buffer);
  expect(first.vertices.byteOffset).toBe(16);
  expect(first.indices.byteOffset).toBe(32);
  expect(first.vertices.buffer).not.toBe(buffer);
  vertices[0] = 9;
  expect(first.vertices[0]).toBe(1);
  const copied = structuredClone(first);
  expect(copied.vertices.buffer).toBe(copied.indices.buffer);
  expect(copied.vertices.buffer.byteLength).toBe(64);
});

it('encodes equal immutable program metadata once without mutating the publication', async () => {
  const { cache, store, subject } = await persistenceFixture();
  const programs = Array.from({ length: 8 }, () => ({
    wgsl: 'shader text\n'.repeat(8192),
    reflection: { entries: [{ name: 'main', stage: 'fragment' }] },
  }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const product = fixtureProduct({
    assets: programs.map((program) => ({ kind: 'material', payload: { program } })),
    edgeCases: {
      cycle,
      sparse: new Array(3),
      values: [undefined, NaN, -0, 1n],
      first: { text: '\ud800' },
      second: { text: '\ud801' },
      names: JSON.parse('{"__proto__":{"kept":true}}'),
    },
  });
  const before = serialize(product);
  await cache.write(subject, product);
  deepStrictEqual(serialize(product), before);
  expect(programs[0]).not.toBe(programs[1]);
  expect(brotliDecompressSync(await storedProductBytes(store)).byteLength).toBeLessThan(
    before.byteLength / 4,
  );
  deepStrictEqual(await cache.read(subject, noDependencies), product);
});

it('reports an absent optional entry as a cold miss', async () => {
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '1');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { cache, subject } = await persistenceFixture();
    expect(await cache.read(subject, noDependencies)).toBeUndefined();
    const message = log.mock.calls.find(([tag]) => tag === '[forgeax.pack-ddc.timing]');
    expect(JSON.parse(String(message?.[1]))).toMatchObject({
      state: 'miss',
      reason: 'entry-not-found',
    });
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('stores compressed Pack bytes and restores the product through the DDC', async () => {
  const { cache, store, subject } = await persistenceFixture();
  const product = fixtureProduct({
    assets: [{ kind: 'scene', payload: new Uint8Array(2 * 1024 * 1024) }],
  });
  await cache.write(subject, product);
  expect((await storedProductBytes(store)).byteLength).toBeLessThan(16 * 1024);
  deepStrictEqual(await cache.read(subject, noDependencies), product);
}, 15_000);

it('shares equal artifact bytes across a Pack product without changing their content', async () => {
  const { cache, store, subject } = await persistenceFixture();
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 131 + 17) & 255);
  const copy = () => ({ bytes: bytes.slice() });
  const assets = () => ({ kind: 'material', payload: { program: copy() } });
  const product = fixtureProduct({
    assets: [assets(), assets()],
    artifacts: { first: copy(), second: copy() },
  });
  await cache.write(subject, product);
  const raw = brotliDecompressSync(await storedProductBytes(store));
  expect(raw.byteLength).toBeLessThan(bytes.byteLength * 2);

  type Program = { program: { bytes: Uint8Array } };
  const restored = await cache.read(subject, noDependencies);
  deepStrictEqual(restored, product);
  for (const entry of [deserialize(raw) as ScriptablePackBuildProduct, restored]) {
    if (!entry) throw new Error('Missing cached Pack product');
    const [first, second] = entry.product.assets.map(
      ({ payload }) => (payload as Program).program.bytes,
    );
    const { first: firstArtifact, second: secondArtifact } = entry.product.artifacts;
    deepStrictEqual(first, bytes);
    expect(first).toBe(second);
    expect(firstArtifact?.bytes).toBe(first);
    expect(secondArtifact?.bytes).toBe(first);
  }
}, 15_000);

it('keeps unserializable Pack products out of the advisory DDC', async () => {
  const { cache, store, subject } = await persistenceFixture();
  const product = fixtureProduct({ assets: [{ kind: 'scene', payload: new WeakMap() }] });
  await expect(cache.write(subject, product)).resolves.toBeUndefined();
  expect(await cache.read(subject, noDependencies)).toBeUndefined();
  expect(await store.listKeys()).toEqual([]);
});

it('reuses each unchanged Pack product and rebuilds only the edited Pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-product-cache-'));
  const sourceA = join(root, 'a.pack.ts');
  const sourceB = join(root, 'b.pack.ts');
  const cacheRoot = join(root, 'ddc');
  let buildsA = 0;
  let buildsB = 0;
  const scene = (
    sourcePath: string,
    id: string,
    markBuilt: () => number,
    text: string,
    generation: number,
  ) =>
    preparedSource(
      sourcePath,
      definePackageId(id),
      text,
      () => {
        markBuilt();
        return ok({ 'scene/main': { kind: 'scene', entities: {} } });
      },
      generation,
    );
  const firstText = 'first';
  const changedText = 'changed';
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await Promise.all([writeFile(sourceA, firstText), writeFile(sourceB, firstText)]);
  const run = (textA: string, publicationGeneration = 1) =>
    produceScriptablePackProducts({
      sources: [
        scene(
          sourceA,
          '01900000-0000-7000-8000-0000000000a1',
          () => ++buildsA,
          textA,
          publicationGeneration,
        ),
        scene(
          sourceB,
          '01900000-0000-7000-8000-0000000000b1',
          () => ++buildsB,
          firstText,
          publicationGeneration,
        ),
      ],
      buildCacheRoot: cacheRoot,
    });
  expect((await run(firstText)).ok).toBe(true);
  expect([buildsA, buildsB]).toEqual([1, 1]);
  expect((await run(firstText, 7)).ok).toBe(true);
  expect([buildsA, buildsB]).toEqual([1, 1]);
  expect((await run(firstText)).ok).toBe(true);
  expect([buildsA, buildsB]).toEqual([1, 1]);
  await writeFile(sourceA, changedText);
  expect((await run(changedText)).ok).toBe(true);
  expect([buildsA, buildsB]).toEqual([2, 1]);
});

it('invalidates the material Pack while retaining an unrelated scene Pack when shader sources change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-pack-cache-'));
  const sourcePath = join(root, 'material.pack.ts');
  const scenePath = join(root, 'scene.pack.ts');
  const text = 'material source';
  let builds = 0;
  let cooks = 0;
  let sceneBuilds = 0;
  let shaderRevision = 'shader-a';
  let nestedRevision = 'nested-a';
  let nestedCooks = 0;
  const material = {
    kind: 'material' as const,
    passes: [{ name: 'forward', program: { module: 'game::surface' } }] as const,
    parameters: [],
  };
  const nestedCooker = {
    key: 'dependent-material-resource',
    cacheIdentity: () => nestedRevision,
    cook() {
      nestedCooks++;
      return nestedRevision;
    },
  };
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await Promise.all([writeFile(sourcePath, text), writeFile(scenePath, 'scene source')]);
  const run = (publicationGeneration = 1) =>
    produceScriptablePackProducts({
      sources: [
        preparedSource(
          sourcePath,
          definePackageId('01900000-0000-7000-8000-0000000000c1'),
          text,
          () => {
            builds++;
            return ok({ 'material/main': material });
          },
          publicationGeneration,
          'material.pack.json',
        ),
        preparedSource(
          scenePath,
          definePackageId('01900000-0000-7000-8000-0000000000c2'),
          'scene source',
          () => {
            sceneBuilds++;
            return ok({ 'scene/main': { kind: 'scene', entities: {} } });
          },
          publicationGeneration,
          'scene.pack.json',
        ),
      ],
      buildCacheRoot: join(root, 'ddc'),
      cookers: [
        {
          key: 'material',
          cacheIdentity: () => shaderRevision,
          cook(input: unknown) {
            cooks++;
            const draft = input as { guid: string; source: typeof material };
            const dependent = nestedCooker.cook();
            return {
              guid: draft.guid,
              payload: draft.source,
              refs: [],
              artifacts: {},
              inputFingerprint: shaderRevision + dependent,
            };
          },
        },
        {
          ...nestedCooker,
          cook() {
            throw Error('Dependent cooker is invoked by its material owner');
          },
        },
      ],
    });
  expect((await run()).ok).toBe(true);
  expect((await run()).ok).toBe(true);
  expect([builds, cooks]).toEqual([1, 1]);
  expect((await run(2)).ok).toBe(true);
  expect([builds, cooks]).toEqual([1, 1]);
  shaderRevision = 'shader-b';
  expect((await run()).ok).toBe(true);
  expect([builds, cooks]).toEqual([2, 2]);
  expect(sceneBuilds).toBe(1);
  nestedRevision = 'nested-b';
  expect((await run()).ok).toBe(true);
  expect([builds, cooks, nestedCooks, sceneBuilds]).toEqual([3, 3, 3, 1]);
});

it('reuses Packs with dynamic content reads and recovers from damaged DDC entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-recovery-'));
  const sourcePath = join(root, 'scene.pack.ts');
  const text = 'scene source';
  const packageId = definePackageId('01900000-0000-7000-8000-0000000000d1');
  const dependency = AssetGuid.derive(packageId, 'scene/dependency');
  let builds = 0;
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(sourcePath, text);
  const run = (readsExternal: boolean) =>
    produceScriptablePackProducts({
      sources: [
        preparedSource(
          sourcePath,
          packageId,
          text,
          async ({ readByGuid }) => {
            builds++;
            if (readsExternal) await readByGuid(dependency);
            return ok({ 'scene/main': { kind: 'scene', entities: {} } });
          },
          1,
          'scene.pack.json',
        ),
      ],
      buildCacheRoot: join(root, 'ddc'),
      assetSource: {
        readByGuid: async () =>
          ok({
            asset: { kind: 'scene' as const, entities: {} },
            generation: 1,
            digest: 'sha256:external',
          }),
      },
    });
  expect((await run(true)).ok).toBe(true);
  expect((await run(true)).ok).toBe(true);
  expect(builds).toBe(1);
  expect((await run(false)).ok).toBe(true);
  const store = new DdcEntryStore(join(root, 'ddc', 'scriptable-pack-products'));
  const [key] = await store.listKeys();
  if (key === undefined) throw new Error('Pack product was not cached');
  await writeFile(
    join(root, 'ddc', 'scriptable-pack-products', 'entries', key, 'artifacts', 'product.v8.br.bin'),
    'damaged',
  );
  expect((await run(false)).ok).toBe(true);
  expect(builds).toBe(2);
});

it('observes newly added, removed and unversioned cookers for a native-free output kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-cooker-roster-'));
  const sourcePath = join(root, 'scene.pack.ts');
  let builds = 0;
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(sourcePath, 'scene source');
  const source = preparedSource(
    sourcePath,
    definePackageId('01900000-0000-7000-8000-0000000000f1'),
    'scene source',
    () => {
      builds++;
      return ok({ scene: { kind: 'scene', entities: {} } });
    },
    1,
    'scene.pack.json',
  );
  const run = (identity: string | undefined | null) =>
    produceScriptablePackProducts({
      sources: [source],
      buildCacheRoot: join(root, 'ddc'),
      cookers:
        identity === null
          ? []
          : [
              {
                key: 'scene',
                ...(identity === undefined ? {} : { cacheIdentity: () => identity }),
                cook() {
                  throw Error('Standard scene output does not invoke native cooking');
                },
              },
            ],
    });
  expect((await run(null)).ok).toBe(true);
  expect((await run('scene-cooker')).ok).toBe(true);
  expect(builds).toBe(2);
  expect((await run('scene-cooker')).ok).toBe(true);
  expect(builds).toBe(2);
  expect((await run(null)).ok).toBe(true);
  expect(builds).toBe(2);
  expect((await run(undefined)).ok).toBe(true);
  expect((await run(undefined)).ok).toBe(true);
  expect(builds).toBe(4);
  const manifests = new DdcEntryStore(join(root, 'ddc', 'scriptable-pack-product-kinds'));
  const [key] = await manifests.listKeys();
  if (key === undefined) throw Error('Missing immutable output-kind discovery');
  const entry = await manifests.read(key);
  if (entry === null) throw Error('Missing verified discovery');
  await manifests.remove(key);
  const altered = {
    ...entry,
    payload: { ...(entry.payload as object), kinds: ['material'] },
    receipt: { ...entry.receipt },
  };
  altered.receipt.outputDigest = ddcOutputDigest(altered);
  await manifests.write(altered);
  expect((await run(null)).ok).toBe(true);
  expect(builds).toBe(5);
});

const noDependencies = async () => undefined;

describe('content dependency validation', () => {
  const depPackage = definePackageId('01900000-0000-7000-8000-0000000000e1');
  const userPackage = definePackageId('01900000-0000-7000-8000-0000000000e2');
  const depGuid = AssetGuid.derive(depPackage, 'scene/dep');

  async function harness(
    names = { dep: 'dep.pack.ts', user: 'user.pack.ts' },
    assetSource?: Parameters<typeof produceScriptablePackProducts>[0]['assetSource'],
  ) {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-deps-'));
    const depSource = join(root, names.dep);
    const userSource = join(root, names.user);
    await Promise.all([writeFile(depSource, 'dep'), writeFile(userSource, 'user')]);
    const counts = { dep: 0, user: 0, depReads: 0 };
    const run = (options: { entities: number; depText: string; failDep?: boolean }) => {
      return produceScriptablePackProducts({
        sources: [
          preparedSource(depSource, depPackage, options.depText, () => {
            counts.dep++;
            if (options.failDep) return ok({});
            const entities: Record<string, never> = {};
            for (let i = 0; i < options.entities; i++)
              (entities as Record<string, unknown>)[`e${i}`] = { components: {} };
            return ok({ 'scene/dep': { kind: 'scene' as const, entities } });
          }),
          preparedSource(userSource, userPackage, 'user', async ({ readByGuid }) => {
            counts.user++;
            await readByGuid(depGuid);
            return ok({ 'scene/main': { kind: 'scene' as const, entities: {} } });
          }),
        ],
        buildCacheRoot: join(root, 'ddc'),
        ...(assetSource === undefined ? {} : { assetSource }),
      });
    };
    return { root, depSource, counts, run };
  }

  it('misses the dependent only when the dependency bytes change', async () => {
    const h = await harness();
    onTestFinished(() => rm(h.root, { recursive: true, force: true }));
    const first = await h.run({ entities: 1, depText: 'dep' });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(h.counts).toMatchObject({ dep: 1, user: 1 });
    expect((await h.run({ entities: 1, depText: 'dep' })).ok).toBe(true);
    expect(h.counts).toMatchObject({ dep: 1, user: 1 });
    expect((await h.run({ entities: 2, depText: 'dep2' })).ok).toBe(true);
    expect(h.counts).toMatchObject({ dep: 2, user: 2 });
  });

  it('keeps the dependent when the dependency source changes but its bytes do not', async () => {
    const h = await harness();
    onTestFinished(() => rm(h.root, { recursive: true, force: true }));
    expect((await h.run({ entities: 1, depText: 'dep' })).ok).toBe(true);
    await writeFile(h.depSource, 'dep-comment-edit');
    expect((await h.run({ entities: 1, depText: 'dep-comment-edit' })).ok).toBe(true);
    expect(h.counts).toMatchObject({ dep: 2, user: 1 });
  });

  it('does not reuse a dependent whose dependency is no longer produced', async () => {
    const h = await harness();
    onTestFinished(() => rm(h.root, { recursive: true, force: true }));
    expect((await h.run({ entities: 1, depText: 'dep' })).ok).toBe(true);
    const gone = await h.run({ entities: 1, depText: 'dep-gone', failDep: true });
    expect(gone.ok).toBe(true);
    expect(h.counts).toMatchObject({ dep: 2, user: 2 });
  });

  it('never validates a dependent against a stale published copy of a restaged dependency', async () => {
    const stale = {
      async readByGuid() {
        return {
          ok: true as const,
          value: {
            asset: { kind: 'scene' as const, entities: {} },
            generation: 1,
            digest: 'sha256:old-published',
          },
        };
      },
    };
    const h = await harness({ dep: 'z-dep.pack.ts', user: 'a-user.pack.ts' }, stale as never);
    onTestFinished(() => rm(h.root, { recursive: true, force: true }));
    expect((await h.run({ entities: 1, depText: 'dep' })).ok).toBe(true);
    expect((await h.run({ entities: 2, depText: 'dep2' })).ok).toBe(true);
    expect(h.counts).toMatchObject({ dep: 2, user: 2 });
  });

  it('misses the dependent when a declared external output changes content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-ext-'));
    const userSource = join(root, 'user.pack.ts');
    await writeFile(userSource, 'user');
    let builds = 0;
    const externalGuid = AssetGuid.derive(depPackage, 'scene/external');
    const produce = (entities: number) => {
      const asset: Record<string, never> = {};
      for (let i = 0; i < entities; i++)
        (asset as Record<string, unknown>)[`e${i}`] = { components: {} };
      return produceScriptablePackProducts({
        sources: [
          {
            sourcePath: userSource,
            displaySourcePath: userSource,
            definition: packDefinition(userPackage, async ({ readByGuid }) => {
              builds++;
              await readByGuid(externalGuid);
              return ok({ 'scene/main': { kind: 'scene' as const, entities: {} } });
            }),
            sourceClosure: [{ path: userSource, digest: revision('user') }],
            publicationGeneration: 1,
            policy: {
              base: '/',
              packagePath: `${PackageId.format(userPackage)}.pack.json`,
              artifactPath: (guid: string, key: string) => `${guid}/${key}`,
            },
          },
        ],
        declaredExternalOutputs: [
          {
            guid: externalGuid,
            sourceKey: 'scene/external',
            asset: { kind: 'scene' as const, entities: asset },
          },
        ],
        buildCacheRoot: join(root, 'ddc'),
      });
    };
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    expect((await produce(1)).ok).toBe(true);
    expect((await produce(1)).ok).toBe(true);
    const afterSame = builds;
    expect((await produce(2)).ok).toBe(true);
    expect(builds).toBe(afterSame + 1);
  });
});

it('relocates canonical and configured roots between checkouts while preserving content identity', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-checkouts-')));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const first = join(base, 'first');
  const second = join(base, 'second');
  const linked = join(base, 'linked');
  const cacheRoot = join(base, 'cache');
  const subjectAt = async (root: string) => {
    await mkdir(join(root, 'assets'), { recursive: true });
    const sourcePath = join(root, 'assets', 'scene.pack.ts');
    const helperPath = join(root, 'assets', 'helper.ts');
    await Promise.all([writeFile(sourcePath, 'source'), writeFile(helperPath, 'helper')]);
    return {
      sourcePath,
      sourceClosure: [
        { path: helperPath, digest: revision('helper') },
        { path: sourcePath, digest: revision('source') },
      ],
      definition: packDefinition('01900000-0000-7000-8000-0000000000e5', () => ok({})),
    };
  };
  const [writer, reader] = await Promise.all([subjectAt(first), subjectAt(second)]);
  await symlink(first, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const productAt = (canonical: string, configured = canonical) =>
    fixtureProduct({
      assets: [
        {
          kind: 'scene',
          payload: {
            entities: {},
            cooked: { sourceClosure: [join(canonical, 'assets', 'mesh.glb'), 'forgeax::pbr'] },
          },
        },
      ],
      sourceKey: join(configured, 'assets', 'scene.pack.ts'),
      sourceDependencies: [join(canonical, 'assets', 'helper.ts')],
    });
  const cacheFor = (identityRoot?: string) =>
    createScriptablePackProductCache({
      root: cacheRoot,
      outputVersions: {},
      cookers: [],
      ...(identityRoot === undefined ? {} : { identityRoot }),
    });
  const write = await cacheFor(linked);
  const read = await cacheFor(second);
  const stored = new DdcEntryStore(join(cacheRoot, 'scriptable-pack-products'));
  await write.write(writer, productAt(first, linked));
  const raw = brotliDecompressSync(await storedProductBytes(stored));
  for (const root of [first, linked]) expect(raw.includes(Buffer.from(root))).toBe(false);
  deepStrictEqual(await read.read(reader), productAt(second));
  deepStrictEqual(await (await cacheFor(first)).read(writer), productAt(first));
  for (const key of await stored.listKeys()) await stored.remove(key);
  // A sibling path sharing the configured prefix remains location-bound.
  const bound = productAt(first, linked);
  Object.assign(bound.product, { sibling: `${linked}-sibling` });
  await write.write(writer, bound);
  expect(await stored.listKeys()).toEqual([]);
  await write.write(writer, productAt(first, linked));
  expect(await (await cacheFor()).read(reader)).toBeUndefined();
  const helperPath = join(second, 'assets', 'helper.ts');
  await writeFile(helperPath, 'changed');
  expect(
    await read.read({
      ...reader,
      sourceClosure: reader.sourceClosure.map((entry) =>
        entry.path === helperPath ? { path: helperPath, digest: revision('changed') } : entry,
      ),
    }),
  ).toBeUndefined();
});

it('reuses prebuilt products across project roots and writes misses only to each project cache', async () => {
  const workspace = await scratch.make('forgeax-shared-pack-seed-');
  const seed = join(workspace, 'seed');
  const packageId = definePackageId('01900000-0000-7000-8000-0000000000f2');
  let cooks = 0;
  const run = async (project: string, cache: string, text: string, seedRoot?: string) => {
    const sourcePath = join(project, 'node_modules/@forgeax/engine-content/assets/scene.pack.ts');
    await mkdir(join(sourcePath, '..'), { recursive: true });
    await writeFile(sourcePath, text);
    return produceScriptablePackProducts({
      cacheIdentityRoot: project,
      buildCacheRoot: cache,
      ...(seedRoot === undefined ? {} : { buildCacheSeedRoot: seedRoot }),
      sources: [
        preparedSource(sourcePath, packageId, text, () => {
          cooks++;
          return ok({ scene: { kind: 'scene', entities: {} } });
        }),
      ],
    });
  };

  const products = (root: string) => new DdcEntryStore(join(root, 'scriptable-pack-products'));
  expect((await run(join(workspace, 'producer'), seed, 'original')).ok).toBe(true);
  const seedKeys = await products(seed).listKeys();
  expect(seedKeys).toHaveLength(1);

  const projectA = join(workspace, 'project-a');
  const projectB = join(workspace, 'project-b');
  const cacheA = join(projectA, 'cache');
  const cacheB = join(projectB, 'cache');
  expect((await run(projectA, cacheA, 'original', seed)).ok).toBe(true);
  expect((await run(projectB, cacheB, 'original', seed)).ok).toBe(true);
  expect(cooks).toBe(1);
  expect(await products(cacheA).listKeys()).toEqual([]);
  expect(await products(cacheB).listKeys()).toEqual([]);

  expect((await run(projectA, cacheA, 'edited', seed)).ok).toBe(true);
  expect((await run(projectA, cacheA, 'edited', seed)).ok).toBe(true);
  expect(cooks).toBe(2);
  expect(await products(cacheA).listKeys()).toHaveLength(1);
  expect(await products(seed).listKeys()).toEqual(seedKeys);
});
