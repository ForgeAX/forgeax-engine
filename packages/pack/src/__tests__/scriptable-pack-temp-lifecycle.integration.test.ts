import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

it('returns the module failure and retires its Worker when temporary allocation is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-unavailable-temp-'));
  try {
    const source = join(root, 'owner.pack.ts');
    await writeFile(source, 'export default {};');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { Worker } from 'node:worker_threads';
        const workers = new Set();
        const on = Worker.prototype.on;
        Worker.prototype.on = function (...args) {
          workers.add(this);
          return Reflect.apply(on, this, args);
        };
        try {
          const { loadScriptablePack } = await import(process.argv[2]);
          const result = await loadScriptablePack(process.argv[1]);
          console.log(JSON.stringify({ result, workers: [...workers].map(w => w.threadId) }));
        } catch (error) {
          console.log(JSON.stringify({ rejected: String(error) }));
        } finally {
          await Promise.all([...workers].map(w => w.terminate()));
        }`,
        source,
        new URL('../../dist/scriptable-pack-node.mjs', import.meta.url).href,
      ],
      { env: { ...process.env, TMPDIR: join(root, 'missing-parent') } },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      result: { ok: false, error: { detail: { reason: 'module-load', phase: 'module-load' } } },
      workers: [-1],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not restart a retired worker when captured sources arrive after the module timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-late-module-'));
  const source = join(root, 'owner.pack.ts');
  const lateRoots: string[] = [];
  const postMessage = Worker.prototype.postMessage;
  const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    const message = args[0];
    if (message?.kind === 'load' && message.sourcePath === source)
      lateRoots.push(message.compileRoot);
    return Reflect.apply(postMessage, this, args);
  });
  const terminated = vi.spyOn(Worker.prototype, 'terminate');
  try {
    await writeFile(source, 'export default {};');
    const snapshot = createScriptablePackSourceSnapshot();
    const captured = await snapshot.moduleSources(source);
    const pending = Promise.withResolvers<typeof captured>();
    const result = await loadScriptablePack(source, {
      timeoutMs: 10,
      sourceSnapshot: { ...snapshot, moduleSources: () => pending.promise },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { reason: 'timeout', phase: 'module-load' } },
    });
    expect(terminated).toHaveBeenCalledOnce();
    expect(terminated.mock.contexts[0]?.threadId).toBe(-1);
    pending.resolve(captured);
    await delay(100);
    expect(lateRoots).toEqual([]);
  } finally {
    posted.mockRestore();
    terminated.mockRestore();
    for (const directory of lateRoots) await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  'complete',
  'failure',
  'timeout',
] as const)('removes the compiled module directory after %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'pack-temp-lifecycle-'));
  try {
    const source = join(root, 'owner.pack.ts');
    const build =
      mode === 'failure'
        ? "throw new Error('AUTHORED_FAILURE');"
        : mode === 'timeout'
          ? 'return new Promise(() => {});'
          : 'return { ok: true, value: {} };';
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0',
      packageId: new Uint8Array(16).fill(7), name: new URL('.', import.meta.url).href,
      build() { ${build} } };`,
    );
    const loaded = await loadScriptablePack(source, { buildTimeoutMs: 100 });
    if (!loaded.ok) throw loaded.error;
    const compileRoot = fileURLToPath(loaded.value.name ?? '');
    expect((await stat(compileRoot)).isDirectory()).toBe(true);
    const built = loaded.value.build({
      packageId: loaded.value.packageId,
      readByGuid: async () => {
        throw new Error('unused');
      },
    });
    if (mode === 'failure') await expect(built).rejects.toThrow('AUTHORED_FAILURE');
    else if (mode === 'timeout')
      expect(await built).toMatchObject({
        ok: false,
        error: { detail: { reason: 'timeout', phase: 'build' } },
      });
    else expect(await built).toEqual({ ok: true, value: {} });
    await expect(stat(compileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('recreates a removed idle compile directory from current source and removes it on pool retirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-temp-recovery-'));
  const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 32 });
  try {
    const source = join(root, 'owner.pack.ts');
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0',
      packageId: new Uint8Array(16).fill(7), name: new URL('.', import.meta.url).href,
      build() { return { ok: true, value: {} }; } };`,
    );
    const first = await loadScriptablePack(source, {
      executor: await pool.acquire(),
      metadataOnly: true,
    });
    if (!first.ok) throw first.error;
    const compileRoot = fileURLToPath(first.value.name ?? '');
    await rm(compileRoot, { recursive: true, force: true });
    const second = await loadScriptablePack(source, {
      executor: await pool.acquire(),
      metadataOnly: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(fileURLToPath(second.value.name ?? '')).toBe(compileRoot);
    expect((await stat(compileRoot)).isDirectory()).toBe(true);
    await pool.dispose();
    await expect(stat(compileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await pool.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
