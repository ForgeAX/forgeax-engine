import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

it.each([
  'single',
  'reusable',
] as const)('releases captured load inputs before a bounded %s Worker builds', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'pack-load-memory-'));
  const source = join(root, 'owner.pack.ts');
  const pool =
    mode === 'reusable'
      ? createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 2 })
      : undefined;
  try {
    // Author-only dependencies belong to the source snapshot, but have no
    // role after the executable closure is written. Keep the real executor's
    // 256 MiB old-generation limit: the build fits only after this load input
    // is released, without changing the authored workload or Worker policy.
    await writeFile(
      join(root, 'author-types.ts'),
      `export interface AuthorInput {}\n/*${'x'.repeat(48 * 1024 * 1024)}*/`,
    );
    await writeFile(join(root, 'dynamic.ts'), 'export const marker = 7;');
    await writeFile(
      source,
      `import type { AuthorInput } from './author-types.ts';
        export default {
          schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
          async build() {
            const { marker } = await import('./dynamic.ts');
            const rows = new Array(26 * 1024 * 1024).fill(marker);
            return { ok: true, value: { scene: { kind: 'scene', entities: {},
              first: rows[0], last: rows[rows.length - 1], length: rows.length,
            } } };
          },
        };`,
    );
    const snapshot = createScriptablePackSourceSnapshot();
    const loaded = await loadScriptablePack(source, {
      sourceSnapshot: snapshot,
      ...(pool === undefined ? {} : { executor: await pool.acquire() }),
    });
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) throw loaded.error;
    const built = await loaded.value.build({
      packageId: loaded.value.packageId,
      readByGuid: async () => {
        throw new Error('unexpected asset read');
      },
    } as never);
    expect(built).toMatchObject({
      ok: true,
      value: { scene: { first: 7, last: 7, length: 26 * 1024 * 1024 } },
    });
  } finally {
    await pool?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
