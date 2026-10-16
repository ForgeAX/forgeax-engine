import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import { AssetGuid } from '@forgeax/engine-pack/source';
import {
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import { err } from '@forgeax/engine-types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { produceBuildAssets } from '../../../../import/src/build-production.js';
import { ImporterRegistry } from '../../../../import/src/importer-registry.js';
import { discoverPluginAssets } from '../plugin-assets.js';

const ownership = vi.hoisted(() => ({ active: 0, maximum: 0, acquired: 0, closed: 0 }));
vi.mock('@forgeax/engine-pack/source-node', async () => {
  const actual = await vi.importActual<typeof import('@forgeax/engine-pack/source-node')>(
    '@forgeax/engine-pack/source-node',
  );
  return {
    ...actual,
    createScriptablePackModuleExecutorPool(
      options: Parameters<typeof actual.createScriptablePackModuleExecutorPool>[0],
    ) {
      const pool = actual.createScriptablePackModuleExecutorPool(options);
      return {
        async acquire() {
          const executor = await pool.acquire();
          ownership.active += 1;
          ownership.acquired += 1;
          ownership.maximum = Math.max(ownership.maximum, ownership.active);
          let released = false;
          return {
            supportsPackParameters: true as const,
            load: executor.load.bind(executor),
            async dispose(reason: 'complete' | 'timeout' | 'failure') {
              if (released) return;
              released = true;
              try {
                await executor.dispose?.(reason);
              } finally {
                ownership.active -= 1;
              }
            },
          };
        },
        async dispose() {
          ownership.closed += 1;
          await pool.dispose();
        },
      };
    },
  };
});

const roots: string[] = [];
beforeEach(() => Object.assign(ownership, { active: 0, maximum: 0, acquired: 0, closed: 0 }));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-leases-')));
  roots.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/runtime.ts'), 'export default { apply() {} };');
  return root;
}

async function pack(root: string, index: number, body: string) {
  const path = join(root, `assets/${index}.pack.ts`);
  await writeFile(
    path,
    `export default {
    schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(${index + 1}),
    build: ${body}
  };`,
  );
  return path;
}

it('bootstraps actual sources and deferred reads with at most four isolated execution leases', async () => {
  const root = await project();
  for (let index = 0; index < 4; index += 1) {
    await pack(
      root,
      index,
      `() => {
      globalThis.bootstrapLeaseBuilds = (globalThis.bootstrapLeaseBuilds ?? 0) + 1;
      if (globalThis.bootstrapLeaseBuilds !== 1) throw new Error('bootstrap worker was reused');
      return { ok: true, value: {
      behavior: { kind: 'plugin', module: { specifier: './runtime.ts', export: 'default' } }
    } }; }`,
    );
  }
  await pack(
    root,
    4,
    `async (context) => {
      globalThis.bootstrapLeaseBuilds = (globalThis.bootstrapLeaseBuilds ?? 0) + 1;
      if (globalThis.bootstrapLeaseBuilds !== 1) throw new Error('bootstrap worker was reused');
      return context.readByGuid(new Uint8Array(16).fill(7));
    }`,
  );
  const result = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  expect(result.assets.size).toBe(4);
  expect(result.deferred).toEqual([join('assets', '4.pack.ts')]);
  expect(ownership).toEqual({ active: 0, maximum: 4, acquired: 5, closed: 1 });
});

it('consumes a current retained inventory without reopening or leaving its original definition unused', async () => {
  const root = await project();
  const source = await pack(root, 0, '() => ({ ok: true, value: {} })');
  const inventory = await scanInventory([join(root, 'assets')]);
  if (!inventory.ok) throw inventory.error;
  const result = await discoverPluginAssets({ root, assetRoots: ['assets'] }, inventory.value);
  expect(result.assets.size).toBe(0);
  expect(result.deferred).toEqual([]);
  expect(ownership).toEqual({ active: 0, maximum: 0, acquired: 0, closed: 1 });
  const declaration = inventory.value.declarations.get(source);
  if (declaration?.format !== 'pack.ts') throw new Error('missing retained declaration');
  await expect(
    declaration.definition.build({
      packageId: declaration.definition.packageId,
      readByGuid: async () => {
        throw new Error('unexpected content read');
      },
    } as never),
  ).rejects.toThrow('ScriptablePack worker is closed');
});

it('rejects changed retained source before consuming the caller-owned definition', async () => {
  const root = await project();
  const source = await pack(root, 0, '() => ({ ok: true, value: {} })');
  const inventory = await scanInventory([join(root, 'assets')]);
  if (!inventory.ok) throw inventory.error;
  await writeFile(source, "throw new Error('changed author source must not execute');");
  await expect(
    discoverPluginAssets({ root, assetRoots: ['assets'] }, inventory.value),
  ).rejects.toMatchObject({ code: 'plugin-bootstrap-failed' });
  expect(ownership).toEqual({ active: 0, maximum: 0, acquired: 0, closed: 0 });
  const declaration = inventory.value.declarations.get(source);
  if (declaration?.format !== 'pack.ts') throw new Error('missing retained declaration');
  const context = {
    packageId: declaration.definition.packageId,
    readByGuid: async () => {
      throw new Error('unexpected content read');
    },
  };
  // Rejection did not consume or reopen the retained module. Its caller
  // remains the lease owner and retires it by completing the original build.
  await expect(declaration.definition.build(context as never)).resolves.toMatchObject({
    ok: true,
    value: {},
  });
  await expect(declaration.definition.build(context as never)).rejects.toThrow(
    'ScriptablePack worker is closed',
  );
});

async function build(
  root: string,
  inventory: Awaited<ReturnType<typeof scanInventory>>,
  sourceSnapshot?: ScriptablePackSourceSnapshot,
) {
  if (!inventory.ok) throw inventory.error;
  const emitted: unknown[] = [];
  const result = await produceBuildAssets({
    inventory: {
      schemaVersion: 'catalog-legacy-v1',
      entries: [],
      authority: 'authoritative',
      diagnostics: [],
      declarations: new Map(),
      sourceDeclarations: inventory.value.declarations,
    },
    cwd: root,
    ...(sourceSnapshot === undefined ? {} : { sourceSnapshot }),
    basePrefix: '',
    generation: 1,
    cookers: [],
    importerRegistry: new ImporterRegistry(),
    fsForImport: {
      readSource: async () =>
        err({
          code: 'import-internal-error',
          expected: 'no external reads',
          hint: 'repair the fixture',
        }),
    },
    cookedCurrentProjection: {},
    directCurrentProjection: {},
    authoredCookedCurrentProjection: {},
    sink: {
      emitFile: (file) => {
        emitted.push(file);
        return String(emitted.length);
      },
      getFileName: (id) => id,
      fileUrl: (path) => `/${path}`,
    },
    fail: (failure) => Object.assign(new Error(failure.code), failure),
  });
  return { result, emitted };
}

it('formal production executes actual metadata subjects lazily instead of retaining all workers', async () => {
  const root = await project();
  for (let index = 0; index < 8; index += 1)
    await pack(root, index, '() => ({ ok: true, value: {} })');
  const inventory = await scanInventory([join(root, 'assets')], {
    scriptablePack: { metadataOnly: true },
  });
  const result = await build(root, inventory);
  expect(result.result).toEqual([]);
  expect(result.emitted.length).toBeGreaterThan(0);
  expect(ownership).toEqual({ active: 0, maximum: 1, acquired: 8, closed: 1 });
});

it('releases a forward content read before building its later dependency and reacquires for retry', async () => {
  const root = await project();
  const guid = AssetGuid.derive(new Uint8Array(16).fill(2) as never, 'content');
  await pack(
    root,
    0,
    `async (context) => {
    const read = await context.readByGuid(new Uint8Array(${JSON.stringify([...guid])}));
    return read.ok ? { ok: true, value: { copied: read.value } } : read;
  }`,
  );
  await pack(root, 1, '() => ({ ok: true, value: { content: { kind: "scene", entities: {} } } })');
  const snapshot = createScriptablePackSourceSnapshot();
  const inventory = await scanInventory([join(root, 'assets')], {
    scriptablePack: { metadataOnly: true, sourceSnapshot: snapshot },
  });
  const result = await build(root, inventory, snapshot);
  expect(result.result).toHaveLength(2);
  expect(ownership).toEqual({ active: 0, maximum: 1, acquired: 3, closed: 1 });
});

it('keeps the captured body after a same-package author edit and never publishes the new body under old evidence', async () => {
  const root = await project();
  const source = await pack(root, 0, '() => ({ ok: true, value: {} })');
  const snapshot = createScriptablePackSourceSnapshot();
  const inventory = await scanInventory([join(root, 'assets')], {
    scriptablePack: { metadataOnly: true, sourceSnapshot: snapshot },
  });
  if (!inventory.ok) throw inventory.error;
  await writeFile(
    source,
    (await snapshot.readText(source)).replace(
      '() => ({ ok: true, value: {} })',
      '() => { throw new Error("new body must not run under old evidence"); }',
    ),
  );
  const bootstrap = await discoverPluginAssets(
    { root, assetRoots: ['assets'] },
    inventory.value,
    snapshot,
  );
  expect(bootstrap.assets.size).toBe(0);
  expect(bootstrap.deferred).toEqual([]);
  expect(ownership).toEqual({ active: 0, maximum: 1, acquired: 1, closed: 1 });
  Object.assign(ownership, { active: 0, maximum: 0, acquired: 0, closed: 0 });
  expect((await build(root, inventory, snapshot)).result).toEqual([]);
  expect(ownership).toEqual({ active: 0, maximum: 1, acquired: 1, closed: 1 });
  Object.assign(ownership, { active: 0, maximum: 0, acquired: 0, closed: 0 });
  await expect(build(root, inventory)).rejects.toMatchObject({
    code: 'pack-source-revision-conflict',
  });
  expect(ownership).toEqual({ active: 0, maximum: 0, acquired: 0, closed: 1 });
});
