// @perf-budget-skip: real production bundling of shared Worker module graphs.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { bundleSingleHtmlEntry } from '../single-html.js';

it('stores a shared dependency once across main, Worker and nested Worker entries', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-shared-workers-'));
  try {
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="./main.js"></script>');
    await writeFile(
      resolve(root, 'shared.js'),
      'export const payload = "SHARED_WORKER_PAYLOAD_ONCE"; export let count = 0; export function increment() { count++; }',
    );
    await writeFile(
      resolve(root, 'main.js'),
      'import { payload, increment } from "./shared.js"; increment(); globalThis.payload = payload; new Worker(new URL("./worker.js", import.meta.url), {type:"module"});',
    );
    await writeFile(
      resolve(root, 'worker.js'),
      'import {payload, count} from "./shared.js"; postMessage({payload, count}); new Worker(new URL("./nested.js", import.meta.url), {type:"module"});',
    );
    await writeFile(
      resolve(root, 'nested.js'),
      'import {payload, count} from "./shared.js"; postMessage({payload, count});',
    );
    const result = await bundleSingleHtmlEntry(
      root,
      await readFile(resolve(root, 'index.html'), 'utf8'),
    );
    if (!result.ok) throw result.error;
    const code = [
      result.value.entrySource,
      ...result.value.artifacts.map((row) => Buffer.from(row.bytes).toString('utf8')),
    ].join('\n');
    expect(code.match(/SHARED_WORKER_PAYLOAD_ONCE/g)).toHaveLength(1);
    expect(result.value.artifacts.some((row) => row.path.endsWith('/worker.js'))).toBe(true);
    expect(result.value.artifacts.some((row) => row.path.endsWith('/nested.js'))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
