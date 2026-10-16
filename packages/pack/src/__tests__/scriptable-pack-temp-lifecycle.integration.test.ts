import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

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
