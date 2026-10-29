import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { brotliDecompressSync } from 'node:zlib';
import { DdcEntryStore, ddcOutputDigest } from '@forgeax/engine-ddc';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { ScriptablePackBuildProduct } from '../scriptable-pack-build-core.js';
import { produceScriptablePackProducts } from '../scriptable-pack-host.js';
import { createScriptablePackProductCache } from '../scriptable-pack-product-cache.js';

const revision = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

it('keeps cached geometry buffers bounded when individual outputs cross a Worker boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-geometry-buffers-'));
  const sourcePath = join(root, 'geometry.pack.ts');
  try {
    await writeFile(sourcePath, 'source');
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision('source') }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000e5'),
        build: () => ok({}),
      }),
    };
    const payloads = Array.from({ length: 64 }, (_, index) => ({
      vertices: new Float32Array(1024).fill(index),
      indices: new Uint32Array([0, 1, 2]),
    }));
    const product = {
      product: { assets: payloads.map((payload) => ({ kind: 'mesh', payload })) },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:source',
    } as unknown as ScriptablePackBuildProduct;
    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    await cache.write(subject, product);
    const restored = await cache.read(subject);
    if (restored === undefined) throw new Error('Geometry product was not restored');
    deepStrictEqual(restored, product);
    for (const output of restored.product.assets) {
      const geometry = structuredClone(output.payload) as (typeof payloads)[number];
      expect(geometry.vertices.buffer.byteLength).toBe(geometry.vertices.byteLength);
      expect(geometry.indices.buffer.byteLength).toBe(geometry.indices.byteLength);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves shared geometry views and their offsets in the cached product', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-shared-geometry-'));
  const sourcePath = join(root, 'geometry.pack.ts');
  try {
    await writeFile(sourcePath, 'source');
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision('source') }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000e6'),
        build: () => ok({}),
      }),
    };
    const buffer = new ArrayBuffer(64);
    const vertices = new Float32Array(buffer, 16, 4);
    vertices.set([1, 2, 3, 4]);
    const payload = {
      vertices,
      indices: new Uint32Array(buffer, 32, 3),
      view: new DataView(buffer),
    };
    const product = {
      product: {
        assets: [
          { kind: 'mesh', payload },
          { kind: 'mesh', payload },
        ],
      },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:source',
    } as unknown as ScriptablePackBuildProduct;
    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    await cache.write(subject, product);
    const restored = await cache.read(subject);
    if (restored === undefined) throw new Error('Shared geometry product was not restored');
    deepStrictEqual(restored, product);
    const first = restored.product.assets[0]?.payload as typeof payload;
    const second = restored.product.assets[1]?.payload as typeof payload;
    expect(first).toBe(second);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('encodes equal immutable program metadata once without mutating the publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-shared-program-'));
  const sourcePath = join(root, 'scene.pack.ts');
  try {
    await writeFile(sourcePath, 'source');
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision('source') }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000e4'),
        build: () => ok({}),
      }),
    };
    const program = () => ({
      wgsl: 'shader text\n'.repeat(8192),
      reflection: { entries: [{ name: 'main', stage: 'fragment' }] },
    });
    const programs = Array.from({ length: 8 }, program);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const edgeCases = {
      cycle,
      sparse: new Array(3),
      values: [undefined, NaN, -0, 1n],
      first: { text: '\ud800' },
      second: { text: '\ud801' },
      names: JSON.parse('{"__proto__":{"kept":true}}'),
    };
    const product = {
      product: {
        assets: programs.map((value) => ({ kind: 'material', payload: { program: value } })),
        edgeCases,
      },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:source',
    } as unknown as ScriptablePackBuildProduct;
    const before = serialize(product);
    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    await cache.write(subject, product);
    deepStrictEqual(serialize(product), before);
    expect(programs[0]).not.toBe(programs[1]);
    const store = new DdcEntryStore(join(root, 'scriptable-pack-products'));
    const [key] = await store.listKeys();
    const entry = key === undefined ? undefined : await store.read(key);
    const bytes = entry?.artifacts['product.v8.br']?.bytes;
    if (bytes === undefined) throw new Error('Missing cached publication');
    expect(brotliDecompressSync(bytes).byteLength).toBeLessThan(before.byteLength / 4);
    deepStrictEqual(await cache.read(subject), product);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reports an absent optional entry as a cold miss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-miss-'));
  const sourcePath = join(root, 'scene.pack.ts');
  vi.stubEnv('FORGEAX_WORKSPACE_TIMING', '1');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await writeFile(sourcePath, 'source');
    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    expect(
      await cache.read({
        sourcePath,
        sourceClosure: [{ path: sourcePath, digest: revision('source') }],
        definition: definePack({
          schemaVersion: '2.0.0',
          packageId: definePackageId('01900000-0000-7000-8000-0000000000e3'),
          build: () => ok({}),
        }),
      }),
    ).toBeUndefined();
    const message = log.mock.calls.find(([tag]) => tag === '[forgeax.pack-ddc.timing]');
    expect(JSON.parse(String(message?.[1]))).toMatchObject({
      state: 'miss',
      reason: 'entry-not-found',
    });
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('stores compressed Pack bytes and restores the product through the DDC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-compressed-'));
  const sourcePath = join(root, 'scene.pack.ts');
  try {
    await writeFile(sourcePath, 'source');
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision('source') }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000e2'),
        build: () => ok({ 'scene/main': { kind: 'scene' as const, entities: {} } }),
      }),
    };
    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    const product = {
      product: { assets: [{ kind: 'scene', payload: new Uint8Array(2 * 1024 * 1024) }] },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:source',
    } as unknown as ScriptablePackBuildProduct;
    await cache.write(subject, product);

    const store = new DdcEntryStore(join(root, 'scriptable-pack-products'));
    const [key] = await store.listKeys();
    if (key === undefined) throw new Error('Pack product was not cached');
    const entry = await store.read(key);
    expect(entry?.artifacts['product.v8.br']?.bytes.byteLength).toBeLessThan(16 * 1024);
    // Node compares typed-array storage directly, including under V8 coverage.
    deepStrictEqual(await cache.read(subject), product);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it('shares equal artifact bytes across a Pack product without changing their content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-shared-bytes-'));
  const sourcePath = join(root, 'materials.pack.ts');
  try {
    await writeFile(sourcePath, 'source');
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision('source') }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000e4'),
        build: () => ok({}),
      }),
    };
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 131 + 17) & 255);
    const product = {
      product: {
        assets: [
          { kind: 'material', payload: { program: { bytes: bytes.slice() } } },
          { kind: 'material', payload: { program: { bytes: bytes.slice() } } },
        ],
        artifacts: { first: { bytes: bytes.slice() }, second: { bytes: bytes.slice() } },
      },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:source',
    } as unknown as ScriptablePackBuildProduct;
    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    await cache.write(subject, product);
    const store = new DdcEntryStore(join(root, 'scriptable-pack-products'));
    const [key] = await store.listKeys();
    if (key === undefined) throw new Error('Pack product was not cached');
    const entry = await store.read(key);
    const body = entry?.artifacts['product.v8.br']?.bytes;
    if (body === undefined) throw new Error('Pack product body is missing');
    const raw = brotliDecompressSync(body);
    expect(raw.byteLength).toBeLessThan(bytes.byteLength * 2);
    const stored = deserialize(raw) as typeof product;
    const first = stored.product.assets[0]?.payload as { program: { bytes: Uint8Array } };
    const second = stored.product.assets[1]?.payload as { program: { bytes: Uint8Array } };
    expect(first.program.bytes).toBe(second.program.bytes);
    deepStrictEqual(first.program.bytes, bytes);
    const artifacts = stored.product.artifacts as typeof product.product.artifacts;
    expect(artifacts.first?.bytes).toBe(first.program.bytes);
    expect(artifacts.second?.bytes).toBe(first.program.bytes);
    const restored = (await cache.read(subject)) as typeof product | undefined;
    if (restored === undefined) throw new Error('Pack product was not restored');
    deepStrictEqual(restored, product);
    const restoredFirst = restored.product.assets[0]?.payload as typeof first | undefined;
    const restoredSecond = restored.product.assets[1]?.payload as typeof second | undefined;
    if (restoredFirst === undefined || restoredSecond === undefined)
      throw new Error('Material bytes were not restored');
    expect(restoredFirst.program.bytes).toBe(restoredSecond.program.bytes);
    expect(restored.product.artifacts.first?.bytes).toBe(restoredFirst.program.bytes);
    expect(restored.product.artifacts.second?.bytes).toBe(restoredFirst.program.bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it('keeps unserializable Pack products out of the advisory DDC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-budget-'));
  const sourcePath = join(root, 'large.pack.ts');
  const sourceText = 'source';
  try {
    await writeFile(sourcePath, sourceText);
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision(sourceText) }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000e1'),
        build: () => ok({ 'scene/main': { kind: 'scene' as const, entities: {} } }),
      }),
    };
    const cache = await createScriptablePackProductCache({
      root,
      outputVersions: {},
      cookers: [],
    });
    const product = (payload: unknown) =>
      ({
        product: { assets: [{ kind: 'scene', payload }] },
        stagedOutputs: [],
        externalEvidence: [],
        inputFingerprint: 'sha256:source',
      }) as unknown as ScriptablePackBuildProduct;
    await expect(cache.write(subject, product(new WeakMap()))).resolves.toBeUndefined();
    expect(await cache.read(subject)).toBeUndefined();
    expect(await new DdcEntryStore(join(root, 'scriptable-pack-products')).listKeys()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reuses each unchanged Pack product and rebuilds only the edited Pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-product-cache-'));
  const sourceA = join(root, 'a.pack.ts');
  const sourceB = join(root, 'b.pack.ts');
  const cacheRoot = join(root, 'ddc');
  let buildsA = 0;
  let buildsB = 0;
  const source = (
    sourcePath: string,
    packageId: string,
    build: () => number,
    text: string,
    publicationGeneration: number,
  ) => ({
    sourcePath,
    displaySourcePath: sourcePath,
    definition: definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId(packageId),
      build: () => {
        build();
        return ok({ 'scene/main': { kind: 'scene' as const, entities: {} } });
      },
    }),
    sourceClosure: [{ path: sourcePath, digest: revision(text) }],
    publicationGeneration,
    policy: {
      base: '/',
      packagePath: `${packageId}.pack.json`,
      artifactPath: (guid: string, key: string) => `${guid}/${key}`,
    },
  });
  const firstText = 'first';
  const changedText = 'changed';
  try {
    await Promise.all([writeFile(sourceA, firstText), writeFile(sourceB, firstText)]);
    const run = (textA: string, publicationGeneration = 1) =>
      produceScriptablePackProducts({
        sources: [
          source(
            sourceA,
            '01900000-0000-7000-8000-0000000000a1',
            () => ++buildsA,
            textA,
            publicationGeneration,
          ),
          source(
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  try {
    await Promise.all([writeFile(sourcePath, text), writeFile(scenePath, 'scene source')]);
    const run = (publicationGeneration = 1) =>
      produceScriptablePackProducts({
        sources: [
          {
            sourcePath,
            displaySourcePath: sourcePath,
            definition: definePack({
              schemaVersion: '2.0.0',
              packageId: definePackageId('01900000-0000-7000-8000-0000000000c1'),
              build: () => {
                builds++;
                return ok({ 'material/main': material });
              },
            }),
            sourceClosure: [{ path: sourcePath, digest: revision(text) }],
            publicationGeneration,
            policy: {
              base: '/',
              packagePath: 'material.pack.json',
              artifactPath: (guid, key) => `${guid}/${key}`,
            },
          },
          {
            sourcePath: scenePath,
            displaySourcePath: scenePath,
            definition: definePack({
              schemaVersion: '2.0.0',
              packageId: definePackageId('01900000-0000-7000-8000-0000000000c2'),
              build: () => {
                sceneBuilds++;
                return ok({ 'scene/main': { kind: 'scene' as const, entities: {} } });
              },
            }),
            sourceClosure: [{ path: scenePath, digest: revision('scene source') }],
            publicationGeneration,
            policy: {
              base: '/',
              packagePath: 'scene.pack.json',
              artifactPath: (guid, key) => `${guid}/${key}`,
            },
          },
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cold builds Packs with dynamic content reads and recovers from damaged DDC entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-recovery-'));
  const sourcePath = join(root, 'scene.pack.ts');
  const text = 'scene source';
  const packageId = definePackageId('01900000-0000-7000-8000-0000000000d1');
  const dependency = AssetGuid.derive(packageId, 'scene/dependency');
  let builds = 0;
  try {
    await writeFile(sourcePath, text);
    const run = (readsExternal: boolean) =>
      produceScriptablePackProducts({
        sources: [
          {
            sourcePath,
            displaySourcePath: sourcePath,
            definition: definePack({
              schemaVersion: '2.0.0',
              packageId,
              build: async ({ readByGuid }) => {
                builds++;
                if (readsExternal) await readByGuid(dependency);
                return ok({ 'scene/main': { kind: 'scene' as const, entities: {} } });
              },
            }),
            sourceClosure: [{ path: sourcePath, digest: revision(text) }],
            publicationGeneration: 1,
            policy: {
              base: '/',
              packagePath: 'scene.pack.json',
              artifactPath: (guid, key) => `${guid}/${key}`,
            },
          },
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
    expect(builds).toBe(2);
    expect((await run(false)).ok).toBe(true);
    const store = new DdcEntryStore(join(root, 'ddc', 'scriptable-pack-products'));
    const [key] = await store.listKeys();
    if (key === undefined) throw new Error('Pack product was not cached');
    await writeFile(
      join(
        root,
        'ddc',
        'scriptable-pack-products',
        'entries',
        key,
        'artifacts',
        'product.v8.br.bin',
      ),
      'damaged',
    );
    expect((await run(false)).ok).toBe(true);
    expect(builds).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('observes newly added, removed and unversioned cookers for a native-free output kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-cooker-roster-'));
  const sourcePath = join(root, 'scene.pack.ts');
  let builds = 0;
  try {
    await writeFile(sourcePath, 'scene source');
    const source = {
      sourcePath,
      displaySourcePath: sourcePath,
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-0000000000f1'),
        build: () => {
          builds++;
          return ok({ scene: { kind: 'scene' as const, entities: {} } });
        },
      }),
      sourceClosure: [{ path: sourcePath, digest: revision('scene source') }],
      publicationGeneration: 1,
      policy: {
        base: '/',
        packagePath: 'scene.pack.json',
        artifactPath: (guid: string, key: string) => `${guid}/${key}`,
      },
    };
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('shares a product between checkouts at different locations through an identity root', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-shared-root-'));
  const checkouts = await Promise.all(
    ['a', 'b'].map((name) => mkdtemp(join(tmpdir(), `forgeax-pack-cache-checkout-${name}-`))),
  );
  try {
    const subjects = await Promise.all(
      checkouts.map(async (root) => {
        await mkdir(join(root, 'assets'));
        const sourcePath = join(root, 'assets', 'scene.pack.ts');
        const helperPath = join(root, 'assets', 'helper.ts');
        await writeFile(sourcePath, 'source');
        await writeFile(helperPath, 'helper');
        return {
          root,
          subject: {
            sourcePath,
            sourceClosure: [
              { path: helperPath, digest: revision('helper') },
              { path: sourcePath, digest: revision('source') },
            ],
            definition: definePack({
              schemaVersion: '2.0.0',
              packageId: definePackageId('01900000-0000-7000-8000-0000000000e5'),
              build: () => ok({}),
            }),
          },
        };
      }),
    );
    const [first, second] = subjects;
    if (first === undefined || second === undefined) throw new Error('missing checkout');
    // Products name their sources by absolute path; a hit must name the
    // reading checkout's files exactly as a fresh cook there would.
    const productAt = (root: string) =>
      ({
        product: {
          assets: [
            {
              kind: 'scene',
              payload: {
                entities: {},
                cooked: { sourceClosure: [join(root, 'assets', 'mesh.glb'), 'forgeax::pbr'] },
              },
            },
          ],
          sourceKey: join(root, 'assets', 'scene.pack.ts'),
          sourceDependencies: [join(root, 'assets', 'helper.ts')],
        },
        stagedOutputs: [],
        externalEvidence: [],
        inputFingerprint: 'sha256:source',
      }) as unknown as ScriptablePackBuildProduct;
    const product = productAt(first.root);
    const cacheFor = (identityRoot?: string) =>
      createScriptablePackProductCache({
        root: cacheRoot,
        outputVersions: {},
        cookers: [],
        ...(identityRoot === undefined ? {} : { identityRoot }),
      });
    await (await cacheFor(first.root)).write(first.subject, product);
    const stored = new DdcEntryStore(join(cacheRoot, 'scriptable-pack-products'));
    const [key] = await stored.listKeys();
    const bytes =
      key === undefined ? undefined : (await stored.read(key))?.artifacts['product.v8.br'];
    if (bytes === undefined) throw new Error('product was not cached');
    expect(brotliDecompressSync(bytes.bytes).includes(Buffer.from(first.root))).toBe(false);
    deepStrictEqual(
      await (await cacheFor(second.root)).read(second.subject),
      productAt(second.root),
    );
    deepStrictEqual(await (await cacheFor(first.root)).read(first.subject), product);
    // Only whole root components relocate. A sibling path sharing the root's
    // prefix is location-bound, so that product never enters the shared cache.
    await stored.remove(key as string);
    const bound = productAt(first.root);
    Object.assign(bound.product, { sibling: `${first.root}-sibling` });
    await (await cacheFor(first.root)).write(first.subject, bound);
    expect(await stored.listKeys()).toEqual([]);
    await (await cacheFor(first.root)).write(first.subject, product);
    // Absolute identities remain private to the checkout that wrote them.
    expect(await (await cacheFor()).read(second.subject)).toBeUndefined();
    // Location independence never relaxes content identity.
    await writeFile(join(second.root, 'assets', 'helper.ts'), 'changed');
    const changed = {
      ...second.subject,
      sourceClosure: [
        { path: join(second.root, 'assets', 'helper.ts'), digest: revision('changed') },
        { path: second.subject.sourcePath, digest: revision('source') },
      ],
    };
    expect(await (await cacheFor(second.root)).read(changed)).toBeUndefined();
  } finally {
    await Promise.all(
      [cacheRoot, ...checkouts].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

it('relocates both canonical and configured root spellings to the reading checkout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-spellings-'));
  try {
    const cacheRoot = join(base, 'cache');
    const real = join(base, 'real');
    const linked = join(base, 'linked');
    const reader = join(base, 'reader');
    await Promise.all([
      mkdir(join(real, 'assets'), { recursive: true }),
      mkdir(join(reader, 'assets'), { recursive: true }),
    ]);
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const subjectAt = async (root: string) => {
      const sourcePath = join(root, 'assets', 'scene.pack.ts');
      await writeFile(sourcePath, 'source');
      return {
        sourcePath,
        sourceClosure: [{ path: sourcePath, digest: revision('source') }],
        definition: definePack({
          schemaVersion: '2.0.0',
          packageId: definePackageId('01900000-0000-7000-8000-0000000000e6'),
          build: () => ok({}),
        }),
      };
    };
    const productAt = (canonical: string, configured: string) =>
      ({
        product: {
          assets: [],
          sourceKey: join(configured, 'assets', 'scene.pack.ts'),
          sourceDependencies: [join(canonical, 'assets', 'scene.pack.ts')],
        },
        stagedOutputs: [],
        externalEvidence: [],
        inputFingerprint: 'sha256:source',
      }) as unknown as ScriptablePackBuildProduct;
    const cacheFor = (identityRoot: string) =>
      createScriptablePackProductCache({
        root: cacheRoot,
        outputVersions: {},
        cookers: [],
        identityRoot,
      });
    const canonicalReal = await realpath(real);
    const canonicalReader = await realpath(reader);
    // Scanned subjects are canonical; product strings may use either spelling.
    await (await cacheFor(linked)).write(
      await subjectAt(canonicalReal),
      productAt(canonicalReal, linked),
    );
    deepStrictEqual(
      await (await cacheFor(reader)).read(await subjectAt(canonicalReader)),
      productAt(canonicalReader, reader),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
