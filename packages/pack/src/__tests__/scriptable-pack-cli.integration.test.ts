// @perf-budget-skip: intentional ScriptablePack CLI integration gate.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, onTestFinished } from 'vitest';
import { projectScriptablePackMeta } from '../pack-authoring.js';
import { scanInventory } from '../scanner.js';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  inventoryScriptablePackSource,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

describe('ScriptablePack CLI Meta inspection', () => {
  it.each([
    "import './missing';",
    "export { value } from './missing';",
    "const dependency = import('./missing');",
  ])('locates an unresolved runtime import in the original source: %s', async (declaration) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-missing-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'shape.pack.ts');
    await writeFile(source, `${declaration}\nexport default {};`);
    const loaded = await loadScriptablePack(source, { metadataOnly: true });
    expect(loaded).toMatchObject({
      ok: false,
      error: {
        code: 'pack-module-not-found',
        detail: { sourcePath: source, specifier: './missing' },
      },
    });
    expect(JSON.stringify(loaded)).not.toContain('forgeax-scriptable-pack-');
    expect(await scanInventory([root])).toMatchObject({
      ok: false,
      error: {
        code: 'pack-module-not-found',
        detail: { sourcePath: source, specifier: './missing' },
      },
    });
  });

  it.each([
    "import type { Hidden } from './erased.ts';",
    "export type { Hidden } from './erased.ts';",
    "import { type Hidden } from './erased.ts';",
    "export { type Hidden } from './erased.ts';",
    "import { Hidden } from './erased.ts'; type Local = Hidden;",
  ])('does not compile an erased dependency: %s', async (declaration) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-erased-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'shape.pack.ts');
    await writeFile(join(root, 'erased.ts'), 'export const broken = ;');
    await writeFile(
      source,
      `${declaration}
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { throw new Error('META_MUST_NOT_BUILD'); }
        };`,
    );
    const sourceSnapshot = createScriptablePackSourceSnapshot();
    const loaded = await loadScriptablePack(source, { metadataOnly: true, sourceSnapshot });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw loaded.error;
    expect(await sourceSnapshot.verify()).toMatchObject({ ok: true });
  });

  it('does not execute a dependency used only as an imported type', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-type-evaluation-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, 'types.ts'),
      "throw new Error('ERASED_MODULE_MUST_NOT_EXECUTE'); export interface Hidden {}",
    );
    const source = join(root, 'shape.pack.ts');
    await writeFile(
      source,
      `import { Hidden } from './types.ts';
        const hidden: Hidden | null = null;
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          name: hidden === null ? 'erased' : 'unexpected',
          build() { throw new Error('META_MUST_NOT_BUILD'); }
        };`,
    );
    const loaded = await loadScriptablePack(source, { metadataOnly: true });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.name).toBe('erased');
  });

  it('retains runtime imports and reloads their closure in a reusable worker generation', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-runtime-generation-')));
    const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 32 });
    try {
      const source = join(root, 'shape.pack.ts');
      await writeFile(
        join(root, 'side.ts'),
        `const state = globalThis as typeof globalThis & { packRuntimeVisits?: number };
        state.packRuntimeVisits = (state.packRuntimeVisits ?? 0) + 1; export {};`,
      );
      await writeFile(join(root, 'barrel.ts'), "export { count as reexported } from './value.js';");
      await writeFile(
        source,
        `import './side.js';
        import { type Hidden, count } from './value.js';
        import { reexported } from './barrel.js';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          async build() {
            const dynamic = await import('./dynamic.js');
            return { ok: true, value: { scene: { kind: 'scene', entities: [],
              count, reexported, dynamic: dynamic.count,
              visits: (globalThis as typeof globalThis & { packRuntimeVisits?: number }).packRuntimeVisits,
            } } };
          }
        };`,
      );
      for (const [generation, count] of [7, 9].entries()) {
        await writeFile(
          join(root, 'value.ts'),
          `export interface Hidden {} export const count = ${count};`,
        );
        await writeFile(join(root, 'dynamic.ts'), `export const count = ${count + 10};`);
        const executor = await pool.acquire();
        const loaded = await loadScriptablePack(source, { executor });
        if (!loaded.ok) throw loaded.error;
        const built = await loaded.value.build({
          packageId: loaded.value.packageId,
          values: {},
          readByGuid: async () => err('unused'),
        });
        expect(built).toMatchObject({
          ok: true,
          value: {
            scene: { count, reexported: count, dynamic: count + 10, visits: generation + 1 },
          },
        });
      }
    } finally {
      await pool.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares bare and relative JavaScript aliases across fresh worker generations', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-js-alias-')));
    const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 32 });
    try {
      const dependency = join(root, 'node_modules/fixture-shared');
      await mkdir(dependency, { recursive: true });
      await writeFile(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'fixture-shared', type: 'module', exports: './index.js' }),
      );
      const source = join(root, 'shape.pack.ts');
      await writeFile(
        source,
        `import { marker as bare, seen as bareSeen, value as bareValue } from 'fixture-shared';
        import { marker as relative, seen as relativeSeen, value as relativeValue }
          from './node_modules/fixture-shared/index.js';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { return { ok: true, value: { scene: { kind: 'scene', entities: [],
            same: bare === relative, bareSeen, relativeSeen, bareValue, relativeValue,
          } } }; }
        };`,
      );
      for (const [generation, value] of [7, 9].entries()) {
        await writeFile(
          join(dependency, 'index.js'),
          `globalThis.packAliasVisits = (globalThis.packAliasVisits ?? 0) + 1;
          export const marker = {}; export const seen = globalThis.packAliasVisits;
          export const value = ${value};`,
        );
        const loaded = await loadScriptablePack(source, { executor: await pool.acquire() });
        if (!loaded.ok) throw loaded.error;
        const built = await loaded.value.build({
          packageId: loaded.value.packageId,
          values: {},
          readByGuid: async () => err('unused'),
        });
        expect(built).toMatchObject({
          ok: true,
          value: {
            scene: {
              same: true,
              bareSeen: generation + 1,
              relativeSeen: generation + 1,
              bareValue: value,
              relativeValue: value,
            },
          },
        });
      }
    } finally {
      await pool.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes captured module bytes when the source changes before worker loading', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-captured-')));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'shape.pack.ts'),
      helper = join(root, 'helper.ts');
    await writeFile(helper, 'export const count = 7;');
    await writeFile(
      source,
      `import { count } from './helper.js';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { return { ok: true, value: { scene: { kind: 'scene', entities: [], count } } }; }
        };`,
    );
    const sourceSnapshot = createScriptablePackSourceSnapshot();
    await sourceSnapshot.inventory(source);
    await writeFile(helper, 'export const count = 9;');
    const loaded = await loadScriptablePack(source, { sourceSnapshot });
    if (!loaded.ok) throw loaded.error;
    const built = await loaded.value.build({
      packageId: loaded.value.packageId,
      values: {},
      readByGuid: async () => err('unused'),
    });
    expect(built).toMatchObject({ ok: true, value: { scene: { count: 7 } } });
    expect(await sourceSnapshot.verify()).toMatchObject({
      ok: false,
      error: { code: 'pack-source-revision-conflict' },
    });
  });

  it('inventories and executes JS-specifier reexports, directory indexes and dotted TS basenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-ts-closure-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const dependency = 'facade-grammar.pack-lib.ts';
    await mkdir(join(root, 'nested'));
    await Promise.all([
      writeFile(join(root, 'nested/index.ts'), 'export const count: number = 7;'),
      writeFile(join(root, 'barrel.ts'), "export * from './nested';"),
      writeFile(join(root, dependency), 'export const dotted: number = 11;'),
    ]);
    const source = join(root, 'shape.pack.ts');
    await writeFile(
      source,
      `import { count } from './barrel.js';
        import { dotted } from './facade-grammar.pack-lib';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { return { ok: true, value: { 'scene/main': { kind: 'scene', entities: [], mounts: [], count, dotted } } }; }
        };`,
    );
    const inventory = await inventoryScriptablePackSource(source);
    expect(inventory.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(
        await Promise.all(
          ['barrel.ts', 'nested/index.ts', dependency].map((file) => realpath(join(root, file))),
        ),
      ),
    );
    const loaded = (await loadScriptablePack(source)).unwrap();
    expect(
      await loaded.build({
        packageId: loaded.packageId,
        values: {},
        readByGuid: async () => err('unused'),
      }),
    ).toMatchObject({
      ok: true,
      value: { 'scene/main': { kind: 'scene', count: 7, dotted: 11 } },
    });
  });

  it('loads the definition without invoking build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'house.pack.mjs');
    await writeFile(
      source,
      `
        export default {
          schemaVersion: '2.0.0',
          packageId: new Uint8Array([1, 159, 250, 151, 139, 57, 122, 210, 132, 204, 39, 50, 104, 89, 26, 180]),
          build() { throw new Error('META_MUST_NOT_BUILD'); }
        };
      `,
    );
    const loaded = (await loadScriptablePack(source, { metadataOnly: true })).unwrap();
    expect(projectScriptablePackMeta(loaded, source)).toMatchObject({
      kind: 'scriptable-pack-source',
      source,
      packageId: '019ffa97-8b39-7ad2-84cc-273268591ab4',
    });
  });
});
