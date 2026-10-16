import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

interface OwnedExecutor {
  readonly worker: Worker;
  readonly compileRootReady: Promise<string>;
}

const owned = vi.hoisted(() => new Set<OwnedExecutor>());
const workerErrors = vi.hoisted(() => [] as Array<{ code?: string; message: string }>);
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
          const captured = executor as unknown as OwnedExecutor;
          if (!owned.has(captured)) {
            captured.worker.on('error', (error: Error & { code?: string }) => {
              workerErrors.push({
                ...(error.code === undefined ? {} : { code: error.code }),
                message: error.message,
              });
            });
          }
          owned.add(captured);
          return executor;
        },
        dispose: pool.dispose.bind(pool),
      };
    },
  };
});

it('releases each complete module graph before publishing the next large authored dev closure', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dev-pack-module-memory-')));
  const assets = join(root, 'assets');
  const plugin = createPluginPackInternal({ roots: [assets], watch: false });
  try {
    await mkdir(assets);
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(assets, `${index}-retained.ts`),
        `export const retained = new Array(8_000_000).fill(${index + 0.5});`,
      );
      await writeFile(
        join(assets, `${index}.pack.ts`),
        `import { retained } from './${index}-retained.js';
          export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(${index + 1}),
            build() {
              if (retained[0] !== ${index + 0.5}) throw new Error('source closure value changed');
              return { ok: true, value: { 'scene/main': { kind: 'scene', entities: {} } } };
            }
          };`,
      );
    }
    plugin.configureServer({
      middlewares: { use() {} },
      ws: { send() {} },
    });
    await plugin.ready();
    expect(plugin.catalogSnapshot()).toHaveLength(4);
    for (const entry of plugin.catalogSnapshot())
      expect(entry).toMatchObject({ kind: 'scene', publication: {} });
    expect(owned.size).toBe(4);
    for (const executor of owned) expect(executor.worker.threadId).toBe(-1);
    expect(workerErrors).toEqual([]);
  } finally {
    await plugin.closeBundle();
    // biome-ignore lint/suspicious/noConsole: Retain the real Worker OOM cause in the RED receipt.
    console.info('Owned authored dev Worker errors:', JSON.stringify(workerErrors));
    // Retain the failure; clean only Workers and directories acquired by this fixture.
    for (const executor of owned) {
      await executor.worker.terminate();
      await rm(await executor.compileRootReady, { recursive: true, force: true });
    }
    owned.clear();
    workerErrors.length = 0;
    await rm(root, { recursive: true, force: true });
  }
});
