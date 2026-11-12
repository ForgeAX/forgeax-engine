import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectCookers, type ProjectCookers } from '../build/cookers.js';
import { discoverPluginAssets } from '../build/plugin-assets.js';
import type { ProjectFacts } from '../types.js';

const namespace = '019fb7ce-4200-7000-8000-000000000000';
const parsed = PackageId.parse(namespace);
if (!parsed.ok) throw parsed.error;
const guid = AssetGuid.format(AssetGuid.derive(parsed.value, 'plugin/build'));
const roots: string[] = [];
const sessions: ProjectCookers[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(body: string, nested = false, config?: unknown): Promise<ProjectFacts> {
  const parent = await mkdtemp(resolve(import.meta.dirname, '../../..', '.build-fixture-'));
  roots.push(parent);
  const root = nested ? resolve(parent, '.forgeax/game') : parent;
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({
      id: 'fixture',
      name: 'Fixture',
      schemaVersion: '3.0.0',
      roots: { build: guid },
    }),
  );
  await writeFile(
    resolve(root, 'assets/build.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: namespace,
      assets: {
        'plugin/build': {
          kind: 'plugin',
          payload: {
            module: { specifier: './build.ts' },
            ...(config === undefined ? {} : { config }),
          },
        },
      },
    }),
  );
  await writeFile(resolve(root, 'assets/build.ts'), body);
  return {
    root,
    id: 'fixture',
    name: 'Fixture',
    packageJson: {},
    assetRoots: ['assets'],
    assetLibraries: [],
    roots: { build: guid },
  };
}

describe('native build root process', () => {
  it('reuses the host inventory without re-evaluating declared plugin producers', async () => {
    const facts = await fixture('export default { apply() {} };');
    const events = resolve(facts.root, 'pack-builds.txt');
    await writeFile(
      resolve(facts.root, 'assets/extra.pack.ts'),
      `
      import {appendFileSync} from 'node:fs';
      import {definePack,definePackageId} from '@forgeax/engine-pack/source';
      import {ok} from '@forgeax/engine-types';
      export default definePack({schemaVersion:'2.0.0',plugins:true,
        packageId:definePackageId('019fb7ce-4200-7000-8000-000000000099'),
        build(){appendFileSync(${JSON.stringify(events)},'build\\n');return ok({});}
      });
    `,
    );
    const inventory = await discoverPluginAssets(facts);
    expect(await readFile(events, 'utf8')).toBe('build\n');
    const session = await loadProjectCookers(facts, [], {}, { inventory });
    sessions.push(session);
    expect(await readFile(events, 'utf8')).toBe('build\n');
  }, 30_000);

  it('samples authored App options from the native build root and preserves defaults', async () => {
    const standardProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      volumetricFog: { quality: 'low', depth: 48, tileSize: 16 },
    };
    const time = { fixedDeltaSeconds: 0.05, maxStepsPerUpdate: 2, maxDeltaSeconds: 0.15 };
    const startupUi = {
      loading: 'none',
      failure: { html: '<h1>Retry</h1>', script: 'return () => {};' },
    };
    const facts = await fixture(
      `export default { provide: ['devkitAppOptions'], apply(ctx, config) {
      ctx.provide('devkitAppOptions', config);
    } };`,
      false,
      {
        dynamicGeometryMeshBudgetBytes: 256 * 1024 * 1024,
        standardProfile,
        time,
        startupUi,
        wechat: { maxRenderShortSide: 0 },
      },
    );
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    expect(session.appOptions).toEqual({
      dynamicGeometryMeshBudgetBytes: 256 * 1024 * 1024,
      standardProfile,
      time,
      startupUi,
      wechat: { maxRenderShortSide: 0 },
    });
    const absent = await loadProjectCookers({ ...facts, roots: {} }, []);
    sessions.push(absent);
    expect(absent.appOptions).toEqual({});
  }, 30_000);

  it.each([
    'null',
    '[]',
    '{ unknown: 1 }',
    '{ dynamicGeometryMeshBudgetBytes: 0 }',
    '{ dynamicGeometryMeshBudgetBytes: 536870913 }',
    '{ dynamicGeometryMeshBudgetBytes: 1.5 }',
    '{ dynamicGeometryMeshBudgetBytes: NaN }',
    '{ dynamicGeometryMeshBudgetBytes: "256" }',
    '{ get dynamicGeometryMeshBudgetBytes() { return 256; } }',
    '{ [Symbol("extra")]: 1 }',
    '{ standardProfile: null }',
    '{ time: null }',
    '{ wechat: null }',
    '{ startupUi: { loading: false } }',
    '{ startupUi: { failure: { html: 1 } } }',
    '{ wechat: [] }',
    '{ wechat: { unknown: 720 } }',
    '{ wechat: { maxRenderShortSide: -1 } }',
    '{ wechat: { maxRenderShortSide: 0.5 } }',
    '{ wechat: { maxRenderShortSide: NaN } }',
    '{ wechat: { maxRenderShortSide: "720" } }',
    '{ time: [] }',
    '{ time: { unknown: 1 } }',
    '{ time: { fixedDeltaSeconds: 0 } }',
    '{ time: { fixedDeltaSeconds: NaN } }',
    '{ time: { maxStepsPerUpdate: 1.5 } }',
    '{ time: { maxStepsPerUpdate: 0 } }',
    '{ time: { maxDeltaSeconds: -1 } }',
    '{ time: { maxDeltaSeconds: "0.1" } }',
    '{ get standardProfile() { throw new Error("accessor must not run"); } }',
    `{ standardProfile: { ...${JSON.stringify(DEFAULT_STANDARD_PROFILE)},
      volumetricFog: { quality: 'low', depth: 48, tileSize: 8 } } }`,
    `{ standardProfile: { ...${JSON.stringify(DEFAULT_STANDARD_PROFILE)},
      volumetricFog: { quality: 'low', depth: 48, get tileSize() { throw new Error('accessor must not run'); } } } }`,
  ])('rejects non-POD or invalid authored App options before cooking: %s', async (value) => {
    const facts = await fixture(`export default { provide: ['devkitAppOptions'], apply(ctx) {
      ctx.provide('devkitAppOptions', ${value});
    } };`);
    await expect(loadProjectCookers(facts, [])).rejects.toMatchObject({
      name: expect.stringMatching(/^(TypeError|RangeError)$/),
    });
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);

  it('preserves declared cache identity and its live closure across the build process', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      let revision = 1;
      ctx.effect(() => ctx.nativeCookers.register({ key: 'versioned', concurrency: 'parallel',
        cacheIdentity() { return 'fixture/' + revision; },
        cook(input) { revision++; return { guid: input.guid, payload: input.source, refs: [], artifacts: {}, inputFingerprint: 'fixture' }; }
      }));
      ctx.effect(() => ctx.nativeCookers.register({ key: 'unversioned',
        cook(input) { return { guid: input.guid, payload: input.source, refs: [], artifacts: {}, inputFingerprint: 'fixture' }; }
      }));
    } };`);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    const cooker = session.cookers.find((cooker) => cooker.key === 'versioned');
    expect(cooker?.concurrency).toBe('parallel');
    expect(await cooker?.cacheIdentity?.()).toBe('fixture/1');
    await cooker?.cook({ guid, source: { kind: 'fixture' } });
    expect(await cooker?.cacheIdentity?.()).toBe('fixture/2');
    expect(
      session.cookers.find((cooker) => cooker.key === 'unversioned')?.cacheIdentity,
    ).toBeUndefined();
  }, 30_000);

  it('cold-starts an original Cooker in one process and preserves its closure across calls', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      let sequence = 0;
      const pid = process.pid;
      ctx.effect(() => ctx.nativeCookers.register({ key: 'fixture',
        discover(input) { return { ...input, transformed: true }; },
        cook(input) { return { guid: input.guid, payload: { pid, sequence: ++sequence, transformed: input.transformed },
          refs: [], artifacts: { body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2]) } }, inputFingerprint: 'fixture' }; }
      }));
    } };`);
    const first = await discoverPluginAssets(facts);
    const second = await discoverPluginAssets(facts);
    expect([...second.assets]).toEqual([...first.assets]);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    expect(session.cookers).toHaveLength(1);
    if (!session.cookers[0]) throw new Error('required fixture session.cookers[0] missing');
    const a = await session.cookers[0].cook({ guid });
    const b = await session.cookers[0].cook({ guid });
    expect(a.payload).toMatchObject({ sequence: 1, transformed: true });
    expect(b.payload).toMatchObject({ sequence: 2 });
    expect((a.payload as { pid: number }).pid).not.toBe(process.pid);
    expect((b.payload as { pid: number }).pid).toBe((a.payload as { pid: number }).pid);
    expect(a.artifacts.body?.bytes).toEqual(new Uint8Array([1, 2]));
    await session.dispose();
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
    await expect(session.cookers[0].cook({ guid })).rejects.toThrow('unavailable');
  }, 30_000);

  it('backs each cooker context with a namespaced build DDC store that outlives the session', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      for (const key of ['fixture-a', 'fixture-b'])
        ctx.effect(() => ctx.nativeCookers.register({ key,
          cook(input, context) {
            const seen = context.cache?.get('job');
            if (seen === undefined) context.cache?.put('job', new Uint8Array([key.length, 7]));
            return { guid: input.guid, payload: { seen: seen === undefined ? null : [...seen], cache: context.cache !== undefined },
              refs: [], artifacts: {}, inputFingerprint: key };
          }
        }));
    } };`);
    const buildCacheRoot = resolve(facts.root, '.forgeax/ddc/build-cache');
    const cook = async (session: ProjectCookers, key: string) => {
      const cooker = session.cookers.find((candidate) => candidate.key === key);
      if (!cooker) throw new Error(`required fixture cooker ${key} missing`);
      return (await cooker.cook({ guid })).payload;
    };
    const first = await loadProjectCookers(facts, [], {}, { buildCacheRoot });
    sessions.push(first);
    expect(await cook(first, 'fixture-a')).toEqual({ seen: null, cache: true });
    expect(await cook(first, 'fixture-b')).toEqual({ seen: null, cache: true });
    await first.dispose();
    const second = await loadProjectCookers(facts, [], {}, { buildCacheRoot });
    sessions.push(second);
    expect(first.producerIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.producerIdentity).toBe(first.producerIdentity);
    expect(await cook(second, 'fixture-a')).toEqual({ seen: [9, 7], cache: true });
    const storeless = await loadProjectCookers(facts, []);
    sessions.push(storeless);
    expect(await cook(storeless, 'fixture-a')).toEqual({ seen: null, cache: false });
  }, 30_000);

  it('invalidates the sealed producer identity for plugin configuration and code changes', async () => {
    const facts = await fixture('export default { apply() {} };');
    const identity = async () => {
      const session = await loadProjectCookers(facts, []);
      sessions.push(session);
      const value = session.producerIdentity;
      await session.dispose();
      return value;
    };
    const first = await identity();
    const declaration = resolve(facts.root, 'assets/build.pack.json');
    const pack = JSON.parse(await readFile(declaration, 'utf8'));
    pack.assets['plugin/build'].payload.config = { importVariant: 2 };
    await writeFile(declaration, JSON.stringify(pack));
    const configured = await identity();
    expect(configured).not.toBe(first);
    await writeFile(
      resolve(facts.root, 'assets/build.ts'),
      'export default { apply() { globalThis.fixtureProducerVersion = 2; } };',
    );
    expect(await identity()).not.toBe(configured);
  }, 30_000);

  it('rejects a builtin key collision and leaves no build process artifacts', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      ctx.effect(() => ctx.nativeCookers.register({ key: 'builtin', cook() {} }));
    } };`);
    await expect(
      loadProjectCookers(facts, [
        {
          key: 'builtin',
          cook() {
            throw new Error('unused');
          },
        },
      ]),
    ).rejects.toThrow('duplicate builtin/project cooker');
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);

  it('reports unowned producer residue instead of treating native disposal as clean', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      ctx.nativeCookers.register({ key: 'leaked', cook() {} });
    } };`);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    await expect(session.dispose()).rejects.toMatchObject({
      message: expect.stringContaining('cleanup left registered cookers'),
    });
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);
  it('keeps Importer reads, decoder capabilities, visibility and finalization in the build owner', async () => {
    const facts = await fixture(`export default { inject: ['importers'], apply(ctx) {
      const pid = process.pid;
      ctx.effect(() => ctx.importers.register({ key: 'fixture-importer',
        async import(input) {
          const source = await input.readSource();
          const sibling = await input.readSibling('sibling.bin');
          const decoded = await input.decodeImage(source.value, 'image/png', {});
          return { pid, source, sibling, decoded };
        },
        capabilities: {
          decodeImage: async bytes => ({ ok: true, value: { texture: { kind: 'texture', pid }, bytes } }),
          catalog: { publish: ({ importSettings }) => importSettings.visible === true },
        },
        finalize(product, { artifactUrl }) {
          return { ok: true, value: { asset: { pid, url: artifactUrl({ path: 'body' }) }, artifacts: [] } };
        },
      }));
    } };`);
    const session = await loadProjectCookers(facts, []);
    sessions.push(session);
    const importer = session.importers[0];
    if (!importer) throw new Error('required fixture importer missing');
    const decode = importer.capabilities?.decodeImage,
      publish = importer.capabilities?.catalog?.publish,
      finalize = importer.finalize;
    if (!decode) throw new Error('required fixture decode missing');
    if (!publish) throw new Error('required fixture publish missing');
    if (!finalize) throw new Error('required fixture finalize missing');
    const result = await importer.import({
      source: 'source.bin',
      subAssets: [],
      importSettings: {},
      readSource: async () => ({ ok: true, value: new Uint8Array([7]) }),
      readSibling: async (uri) => {
        expect(uri).toBe('sibling.bin');
        return { ok: true, value: new Uint8Array([8]) };
      },
      decodeImage: (...args) => decode(...args),
    });
    expect(result.pid).not.toBe(process.pid);
    expect(result.source.value).toEqual(new Uint8Array([7]));
    expect(result.sibling.value).toEqual(new Uint8Array([8]));
    expect(result.decoded.value.texture.pid).toBe(result.pid);
    expect(
      await publish({
        importSettings: { visible: false },
        subAssets: [],
      }),
    ).toBe(false);
    const finalized = await finalize(
      {
        assets: [
          {
            guid,
            kind: 'blob',
            payload: {},
            refs: [],
            artifacts: {
              body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([7]) },
            },
          },
        ],
        sourceDependencies: [],
      },
      { artifactUrl: ({ path }) => `/published/${path}` },
    );
    expect(finalized).toMatchObject({
      ok: true,
      value: { asset: { pid: result.pid, url: '/published/body' } },
    });
    await session.dispose();
  }, 30_000);
});

describe('build environment deadlines', () => {
  it.each([
    'startup',
    'cook',
    'cleanup',
  ] as const)('terminates an uncooperative %s operation and removes its session', async (operation) => {
    const facts = await fixture(
      operation === 'startup'
        ? 'export default { apply() { return new Promise(() => {}); } };'
        : `export default { inject: ['nativeCookers'], apply(ctx) {
          ctx.effect(() => ctx.nativeCookers.register({ key: 'hung', cook() { return new Promise(() => {}); } }));
          ${operation === 'cleanup' ? 'ctx.effect(() => () => new Promise(() => {}));' : ''}
        } };`,
    );
    const pending = loadProjectCookers(
      facts,
      [],
      {},
      {
        startupTimeoutMs: operation === 'startup' ? 100 : 10_000,
        operationTimeoutMs: 100,
        cleanupTimeoutMs: 100,
      },
    );
    if (operation === 'startup') await expect(pending).rejects.toThrow('process terminated');
    else {
      const session = await pending;
      sessions.push(session);
      if (!session.cookers[0]) throw new Error('required fixture session.cookers[0] missing');
      if (operation === 'cook')
        await expect(session.cookers[0].cook({ guid })).rejects.toThrow('process terminated');
      else await expect(session.dispose()).rejects.toThrow('process terminated');
      await session.dispose();
    }
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);

  it('gives a cooker its declared cook bound instead of the session default', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      ctx.effect(() => ctx.nativeCookers.register({ key: 'slow', timeoutMs: 5000,
        cook: (input) => new Promise((done) => setTimeout(() => done({ guid: input.guid, payload: {},
          refs: [], artifacts: {}, inputFingerprint: 'slow' }), 400)) }));
      ctx.effect(() => ctx.nativeCookers.register({ key: 'hung', timeoutMs: 300,
        cook: () => new Promise(() => {}) }));
    } };`);
    const session = await loadProjectCookers(facts, [], {}, { operationTimeoutMs: 100 });
    sessions.push(session);
    const [slow, hung] = session.cookers;
    if (!slow || !hung) throw new Error('required fixture cookers missing');
    expect([slow.key, slow.timeoutMs, hung.timeoutMs]).toEqual(['slow', 5000, 300]);
    // 400 ms is past the 100 ms session default but inside the declared 5 s.
    await expect(slow.cook({ guid })).resolves.toMatchObject({ guid });
    const started = performance.now();
    await expect(hung.cook({ guid })).rejects.toThrow('exceeded 300ms; process terminated');
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    await session.dispose();
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);

  it('forwards a parallel declaration and overlaps its cooks in the build process', async () => {
    // Each cook records how many cooks of its cooker were running when it started.
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      const make = (key, concurrency) => {
        let active = 0;
        return { key, ...(concurrency ? { concurrency } : {}), async cook(input) {
          const peak = ++active;
          await new Promise((done) => setTimeout(done, 150));
          active--;
          return { guid: input.guid, payload: { peak }, refs: [], artifacts: {}, inputFingerprint: key };
        } };
      };
      ctx.effect(() => ctx.nativeCookers.register(make('overlap', 'parallel')));
      ctx.effect(() => ctx.nativeCookers.register(make('serial')));
    } };`);
    const session = await loadProjectCookers(facts, [], {}, { operationTimeoutMs: 5000 });
    sessions.push(session);
    const [overlap, serial] = session.cookers;
    if (!overlap || !serial) throw new Error('required fixture cookers missing');
    expect([overlap.concurrency, serial.concurrency]).toEqual(['parallel', undefined]);
    const peaks = async (cooker: typeof overlap) =>
      (await Promise.all([1, 2, 3].map(() => cooker.cook({ guid })))).map(
        (draft) => (draft.payload as { peak: number }).peak,
      );
    expect(Math.max(...(await peaks(overlap)))).toBe(3);
    expect(Math.max(...(await peaks(serial)))).toBe(1);
    await session.dispose();
  }, 30_000);

  it('rejects a cooker whose declared bound is not positive finite milliseconds', async () => {
    const facts = await fixture(`export default { inject: ['nativeCookers'], apply(ctx) {
      ctx.effect(() => ctx.nativeCookers.register({ key: 'bad', timeoutMs: 0, cook() {} }));
    } };`);
    await expect(loadProjectCookers(facts, [])).rejects.toMatchObject({
      code: 'plugin-startup-failed',
      detail: { cause: { name: 'RangeError', message: expect.stringContaining('timeoutMs') } },
    });
    expect(await readdir(resolve(facts.root, '.forgeax/build'))).toEqual([]);
  }, 30_000);
});

it('discovers projects beneath an ancestor cache while ignoring their own generated sources', async () => {
  const facts = await fixture('export default { apply() {} };', true);
  await mkdir(resolve(facts.root, 'assets/.forgeax'));
  await writeFile(resolve(facts.root, 'assets/.forgeax/broken.pack.json'), 'not authored JSON');
  const inventory = await discoverPluginAssets(facts);
  expect([...inventory.assets.keys()]).toEqual([guid]);
});
