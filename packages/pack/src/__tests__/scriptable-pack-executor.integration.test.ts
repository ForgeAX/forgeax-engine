import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { Result } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
  type ScriptablePackModuleExecutor,
} from '../scriptable-pack-node.js';

interface OwnedExecutor {
  readonly worker: Worker;
  readonly compileRootReady: Promise<Result<string, unknown>>;
}

async function withPool(
  maxTasksPerWorker: number,
  run: (fixture: {
    readonly pool: ReturnType<typeof createScriptablePackModuleExecutorPool>;
    readonly acquire: () => Promise<ScriptablePackModuleExecutor>;
    readonly source: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'pack-executor-cleanup-'));
  const source = join(root, 'owner.pack.ts');
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker });
  const owned = new Set<OwnedExecutor>();
  try {
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        build: () => ({ ok: true, value: {} }) };`,
    );
    await run({
      pool,
      source,
      acquire: async () => {
        const executor = await pool.acquire();
        owned.add(executor as unknown as OwnedExecutor);
        return executor;
      },
    });
  } finally {
    // A failing cleanup assertion must not leave this test's real Worker or files behind.
    await pool.dispose();
    for (const executor of owned) {
      await executor.worker.terminate();
      const allocated = await executor.compileRootReady;
      if (allocated.ok) await rm(allocated.value, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function load(source: string, executor: ScriptablePackModuleExecutor) {
  const loaded = await loadScriptablePack(source, { executor });
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

async function build(definition: Awaited<ReturnType<typeof load>>) {
  expect(
    await definition.build({
      packageId: definition.packageId,
      readByGuid: async () => {
        throw new Error('unexpected content read');
      },
    } as never),
  ).toEqual({ ok: true, value: {} });
}

async function expectRetired(
  executor: ScriptablePackModuleExecutor,
  compileRoot: string,
  pool: ReturnType<typeof createScriptablePackModuleExecutorPool>,
) {
  expect((executor as unknown as OwnedExecutor).worker.threadId).toBe(-1);
  await expect(stat(compileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((pool as unknown as { readonly executors: Set<unknown> }).executors.size).toBe(0);
}

it('terminates the reusable Worker and removes its compiled directory after successful pool shutdown', async () => {
  await withPool(32, async ({ pool, acquire, source }) => {
    const executor = await acquire();
    await build(await load(source, executor));
    const owned = executor as unknown as OwnedExecutor;
    const compileRoot = (await owned.compileRootReady).unwrap();
    expect(owned.worker.threadId).toBeGreaterThan(0);
    expect((await stat(compileRoot)).isDirectory()).toBe(true);
    await pool.dispose();
    await expectRetired(executor, compileRoot, pool);
  });
});

it('compiles a captured local module both as source text and as a normal module', async () => {
  await withPool(32, async ({ acquire, source }) => {
    const program = 'export const marker = "exact text";\n';
    await writeFile(join(dirname(source), 'program.mjs'), program);
    await writeFile(
      source,
      `import text from './program.mjs?raw';
      import { marker } from './program.mjs';
      export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        build: () => {
          if (text !== ${JSON.stringify(program)} || marker !== 'exact text') throw new Error('module identity lost');
          return { ok: true, value: {} };
        } };`,
    );
    await build(await load(source, await acquire()));
  });
});

it('escalates a same-turn complete disposal to failure when the pool shuts down', async () => {
  await withPool(32, async ({ pool, acquire, source }) => {
    const executor = await acquire();
    await load(source, executor);
    const compileRoot = (await (executor as unknown as OwnedExecutor).compileRootReady).unwrap();
    const complete = executor.dispose?.('complete');
    const shutdown = pool.dispose();
    await Promise.all([complete, shutdown]);
    await expectRetired(executor, compileRoot, pool);
  });
});

it('hands a queued lease the same Worker and really retires it at the second task limit', async () => {
  await withPool(2, async ({ pool, acquire, source }) => {
    const first = await acquire();
    const definition = await load(source, first);
    const compileRoot = (await (first as unknown as OwnedExecutor).compileRootReady).unwrap();
    const queued = acquire();
    await build(definition);
    const second = await queued;
    expect(second).toBe(first);
    expect((second as unknown as OwnedExecutor).worker.threadId).toBeGreaterThan(0);
    await build(await load(source, second));
    await expectRetired(second, compileRoot, pool);
    await pool.dispose();
  });
});

it('loads standard JSON attributes through captured imports and re-exports', async () => {
  await withPool(32, async ({ acquire, source }) => {
    await writeFile(
      join(dirname(source), 'data.json'),
      '{"__proto__":{"marker":1},"values":[1,2,3]}',
    );
    await writeFile(
      join(dirname(source), 'bridge.ts'),
      "export { default as row } from './data.json' with { type: 'json' };",
    );
    await writeFile(
      source,
      `import direct from './data.json' with { type: 'json' };
      import { row } from './bridge.ts';
      export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        build: () => {
          if (direct !== row || !Object.hasOwn(row, '__proto__') || row.__proto__.marker !== 1 ||
            row.values.join(',') !== '1,2,3') throw new Error('JSON identity or values lost');
          return { ok: true, value: {} };
        } };`,
    );
    await build(await load(source, await acquire()));
  });
});

it('does not silence unsupported attributes while lowering captured JSON', async () => {
  await withPool(32, async ({ acquire, source }) => {
    await writeFile(join(dirname(source), 'data.json'), '{"marker":1}');
    await writeFile(
      source,
      `import row from './data.json' with { type: 'json', unsupported: 'refuse' };
      export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        build: () => { if (row.marker !== 1) throw new Error('value lost'); return { ok: true, value: {} }; } };`,
    );
    const result = await loadScriptablePack(source, { executor: await acquire() });
    expect(result.ok).toBe(false);
  });
});

it('awaits real Worker retirement from every concurrent pool disposal', async () => {
  await withPool(32, async ({ pool, acquire }) => {
    const executor = await acquire();
    const owned = executor as unknown as OwnedExecutor;
    const first = pool.dispose();
    try {
      await pool.dispose();
      expect(owned.worker.threadId).toBe(-1);
    } finally {
      await first;
    }
  });
});
