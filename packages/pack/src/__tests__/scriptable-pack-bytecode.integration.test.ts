import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

type Pool = ReturnType<typeof createScriptablePackModuleExecutorPool> & {
  readonly bytecodeCacheRootReady?: Promise<string | undefined>;
  readonly ownsBytecodeCache: boolean;
};

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

it('keeps fresh module state and source bytes while sharing only disposable bytecode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-bytecode-freshness-'));
  const dependency = join(root, 'node_modules', 'fixture-bytecode');
  const source = join(root, 'owner.pack.ts');
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 1 });
  const owner = pool as Pool;
  const workers: Worker[] = [];
  try {
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture-bytecode', type: 'module', exports: './index.mjs' }),
    );
    await writeFile(
      source,
      `import { marker } from 'fixture-bytecode';
      export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        name: 'current-' + marker, build: () => ({ ok: true, value: {} }) };`,
    );
    for (const marker of [11, 22]) {
      // Same bare-module path and source length: a warm bytecode entry cannot
      // authorize the previous value or retain the previous module instance.
      await writeFile(join(dependency, 'index.mjs'), `export const marker = ${marker};`);
      const executor = await pool.acquire();
      const worker = (executor as unknown as { readonly worker: Worker }).worker;
      workers.push(worker);
      const loaded = await loadScriptablePack(source, { executor });
      expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
      if (!loaded.ok) throw loaded.error;
      expect(loaded.value.name).toBe(`current-${marker}`);
      expect(
        await loaded.value.build({
          packageId: loaded.value.packageId,
          readByGuid: async () => {
            throw new Error('unexpected content read');
          },
        } as never),
      ).toEqual({ ok: true, value: {} });
      expect(worker.threadId).toBe(-1);
    }
    expect(workers[0]).not.toBe(workers[1]);
    const directory = await owner.bytecodeCacheRootReady;
    if (owner.ownsBytecodeCache && directory !== undefined) {
      expect((await files(directory)).length).toBeGreaterThan(0);
      await pool.dispose();
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await pool.dispose();
    for (const worker of workers) await worker.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

it('retires an owned bytecode directory when the pool closes during first acquisition', async () => {
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 1 });
  const owner = pool as Pool;
  const pending = expect(pool.acquire()).rejects.toThrow('executor pool is closed');
  await pool.dispose();
  await pending;
  const directory = await owner.bytecodeCacheRootReady;
  if (owner.ownsBytecodeCache && directory !== undefined)
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
