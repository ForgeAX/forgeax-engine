import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnDdcWorker } from './multiprocess-worker.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryModule = join(sourceRoot, 'entry-store.ts');
const lifecycleModule = join(sourceRoot, 'lifecycle.ts');
const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const secondGuid = '019e3969-1d48-7c3b-ac24-6d68f457065e';
const key = 'a'.repeat(64);

function runWorker(
  root: string,
  source: string,
  args: readonly string[] = [],
  workerGuid = guid,
): Promise<Record<string, unknown>> {
  return new Promise((resolveWorker, reject) => {
    const child = spawnDdcWorker(source, [lifecycleModule, root, workerGuid, key, ...args]);
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (error += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker timed out: ${error}`));
    }, 5000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`worker failed (${code}): ${error}`));
        return;
      }
      try {
        resolveWorker(JSON.parse(output) as Record<string, unknown>);
      } catch (parseError) {
        reject(new Error(`worker output was not JSON: ${output}; ${String(parseError)}`));
      }
    });
  });
}

describe('DDC multiprocess lifecycle', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('allocates unique persistent generations across two independent processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-multiprocess-generation-'));
    roots.push(root);
    const script = `
      const { DdcLifecycle } = await load(process.argv[1]);
      const lease = await new DdcLifecycle(process.argv[2]).begin(process.argv[3], process.argv[4]);
      console.log(JSON.stringify({ attempt: lease.attempt, generation: lease.generation }));
    `;

    const [first, second] = await Promise.all([runWorker(root, script), runWorker(root, script)]);
    expect(first.generation).toEqual(expect.any(Number));
    expect(second.generation).toEqual(expect.any(Number));
    expect(first.generation).not.toBe(second.generation);
  });

  it('does not reuse a generation after a process restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-multiprocess-restart-'));
    roots.push(root);
    const script = `
      const { DdcLifecycle } = await load(process.argv[1]);
      const lease = await new DdcLifecycle(process.argv[2]).begin(process.argv[3], process.argv[4]);
      console.log(JSON.stringify({ generation: lease.generation }));
    `;
    const first = await runWorker(root, script);
    const second = await runWorker(root, script);

    expect(second.generation).toBeGreaterThan(first.generation as number);
  });

  it('serializes generation allocation across independent asset heads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-multiprocess-generation-'));
    roots.push(root);
    const script = `
      const { DdcLifecycle } = await load(process.argv[1]);
      const lease = await new DdcLifecycle(process.argv[2]).begin(process.argv[3], process.argv[4]);
      console.log(JSON.stringify({ generation: lease.generation }));
    `;

    const [first, second] = await Promise.all([
      runWorker(root, script, [], guid),
      runWorker(root, script, [], secondGuid),
    ]);
    expect(first.generation).toEqual(expect.any(Number));
    expect(second.generation).toEqual(expect.any(Number));
    expect(first.generation).not.toBe(second.generation);
  });

  it('rejects the stale writer instead of silently overwriting current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-multiprocess-head-'));
    roots.push(root);
    const script = `
      const { mkdir, readdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { DdcEntryStore, ddcOutputDigest } = await load(process.argv[5]);
      const { DdcLifecycle } = await load(process.argv[1]);
      const root = process.argv[2];
      const guid = process.argv[3];
      const key = process.argv[4];
      const payload = process.argv[6];
      const entry = { key, guid, payload: { payload }, refs: [], artifacts: {}, receipt: { guid, key, producer: 'worker', inputFingerprint: payload, outputDigest: '' } };
      const store = new DdcEntryStore(root);
      const lifecycle = new DdcLifecycle(root);
      const lease = await lifecycle.begin(guid, key);
      const barrier = join(root, 'stale-writer-barrier');
      await mkdir(barrier, { recursive: true });
      await writeFile(join(barrier, lease.attempt), 'ready');
      const deadline = Date.now() + 4000;
      while ((await readdir(barrier)).length < 2) {
        if (Date.now() >= deadline) {
          throw new Error('timed out waiting for both stale-writer leases');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await store.write({ ...entry, receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) } });
      const committed = await lifecycle.commit(lease, key);
      console.log(JSON.stringify({ result: committed.result, revision: committed.revision, generation: lease.generation }));
    `;
    const [first, second] = await Promise.all([
      runWorker(root, script, [entryModule, 'first']),
      runWorker(root, script, [entryModule, 'second']),
    ]);

    expect([first.result, second.result].filter((value) => value === 'current')).toHaveLength(1);
    expect([first.result, second.result]).toContain('stale');
    expect(first.revision ?? second.revision).toEqual(expect.any(Number));
  });
});
