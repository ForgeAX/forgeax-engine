import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { produceBuildAssets } from '../../../../import/src/build-production.js';
import { ImporterRegistry } from '../../../../import/src/importer-registry.js';
import { discoverPluginAssets } from '../plugin-assets.js';

interface OwnedExecutor {
  readonly worker: Worker;
  readonly compileRootReady: Promise<string>;
}

const owned = vi.hoisted(() => new Set<OwnedExecutor>());
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
          owned.add(executor as unknown as OwnedExecutor);
          return executor;
        },
        dispose: pool.dispose.bind(pool),
      };
    },
  };
});

it.each([
  'bootstrap',
  'formal',
] as const)('%s releases each complete module graph before executing the next large source closure', async (stage) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-module-memory-')));
  try {
    await mkdir(join(root, 'assets'));
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(root, `assets/${index}-retained.ts`),
        `export const retained = new Array(8_000_000).fill(${index + 0.5});`,
      );
      await writeFile(
        join(root, `assets/${index}.pack.ts`),
        `import { retained } from './${index}-retained.js';
          export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(${index + 1}),
            build() {
              if (retained[0] !== ${index + 0.5}) throw new Error('source closure value changed');
              return { ok: true, value: {} };
            }
          };`,
      );
    }
    const sourceSnapshot = createScriptablePackSourceSnapshot();
    const inventory = await scanInventory([join(root, 'assets')], {
      scriptablePack: { metadataOnly: true, sourceSnapshot },
    });
    if (!inventory.ok) throw inventory.error;
    if (stage === 'bootstrap') {
      const result = await discoverPluginAssets(
        { root, assetRoots: ['assets'] },
        inventory.value,
        sourceSnapshot,
      );
      expect(result.assets.size).toBe(0);
      expect(result.deferred).toEqual([]);
    } else {
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
        sourceSnapshot,
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
          emitFile: () => 'fixture',
          getFileName: (id) => id,
          fileUrl: (path) => `/${path}`,
        },
        fail: (failure) => Object.assign(new Error(JSON.stringify(failure)), failure),
      });
      expect(result).toEqual([]);
    }
    expect(owned.size).toBe(4);
    for (const executor of owned) expect(executor.worker.threadId).toBe(-1);
  } finally {
    // Retain the failure; clean only Workers and directories acquired by this fixture.
    for (const executor of owned) {
      await executor.worker.terminate();
      await rm(await executor.compileRootReady, { recursive: true, force: true });
    }
    owned.clear();
    await rm(root, { recursive: true, force: true });
  }
});
