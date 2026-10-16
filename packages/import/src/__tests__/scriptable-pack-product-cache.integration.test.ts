import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { DdcEntryStore, ddcOutputDigest, semanticDdcKey } from '@forgeax/engine-ddc';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { ScriptablePackBuildProduct } from '../scriptable-pack-build-core.js';
import { produceScriptablePackProducts } from '../scriptable-pack-host.js';
import { createScriptablePackProductCache } from '../scriptable-pack-product-cache.js';

const revision = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

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

it('migrates a verified preceding product without rebuilding or accepting changed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-cache-migrate-'));
  const sourcePath = join(root, 'scene.pack.ts');
  const packageId = definePackageId('01900000-0000-7000-8000-0000000000e3');
  const source = 'original source';
  try {
    await writeFile(sourcePath, source);
    const subject = {
      sourcePath,
      sourceClosure: [{ path: sourcePath, digest: revision(source) }],
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId,
        build: () => ok({ 'scene/main': { kind: 'scene' as const, entities: {} } }),
      }),
    };
    const product = {
      product: { assets: [{ kind: 'scene', payload: new Uint8Array(1024) }] },
      stagedOutputs: [],
      externalEvidence: [],
      inputFingerprint: 'sha256:original',
    } as unknown as ScriptablePackBuildProduct;
    const schema = 'scriptable-pack-product/5';
    const guid = '01900000-0000-7000-8000-0000000000e3';
    const key = semanticDdcKey({
      schemaVersion: schema,
      importer: 'scriptable-pack',
      codec: `node-v8/${process.versions.v8}`,
      settings: {
        sourcePath,
        packageId: guid,
        values: null,
        inheritedValues: null,
        outputVersions: {},
        cookerIdentity: [],
      },
      sourceBytes: [new TextEncoder().encode(`${sourcePath}\0${revision(source)}`)],
      declaredGuids: [guid],
      targetProfile: 'dev',
      producer: schema,
    });
    const store = new DdcEntryStore(join(root, 'scriptable-pack-products'));
    const entry = {
      key,
      guid,
      payload: { schemaVersion: schema, sourcePath },
      refs: [] as string[],
      artifacts: {
        'product.v8.br': {
          mediaType: 'application/vnd.node-v8-serialized+br',
          bytes: brotliCompressSync(serialize(product)),
        },
      },
      receipt: { guid, key, producer: schema, inputFingerprint: key, outputDigest: '' },
    };
    entry.receipt.outputDigest = ddcOutputDigest(entry);
    await store.write(entry);

    const cache = await createScriptablePackProductCache({ root, outputVersions: {}, cookers: [] });
    expect(await cache.read(subject)).toEqual(product);
    expect(await store.listKeys()).toHaveLength(2);
    await store.remove(key);
    expect(await cache.read(subject)).toEqual(product);
    await writeFile(sourcePath, 'edited without notification');
    expect(await cache.read(subject)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

it('invalidates one material Pack when its cooker source identity changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-pack-cache-'));
  const sourcePath = join(root, 'material.pack.ts');
  const text = 'material source';
  let builds = 0;
  let cooks = 0;
  let shaderRevision = 'shader-a';
  const material = {
    kind: 'material' as const,
    passes: [{ name: 'forward', program: { module: 'game::surface' } }] as const,
    parameters: [],
  };
  try {
    await writeFile(sourcePath, text);
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
        ],
        buildCacheRoot: join(root, 'ddc'),
        cookers: [
          {
            key: 'material',
            cacheIdentity: () => shaderRevision,
            cook(input: unknown) {
              cooks++;
              const draft = input as { guid: string; source: typeof material };
              return {
                guid: draft.guid,
                payload: draft.source,
                refs: [],
                artifacts: {},
                inputFingerprint: shaderRevision,
              };
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
