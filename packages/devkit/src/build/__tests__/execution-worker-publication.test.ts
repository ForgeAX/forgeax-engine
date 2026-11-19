import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExecutionWorkersOptions } from '@forgeax/engine-app';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';
import { executionWorkerEntries } from '../execution-workers';

it.each([
  [{}, ['engine', 'render', 'task']],
  [{ engine: false, render: false, kernels: false }, []],
  [{ engine: false, kernels: false }, ['render']],
  [{ engine: false, render: false, kernels: false }, ['engine', 'render', 'task'], 'consumer'],
] as const)('publishes only the Worker graphs admitted by %j', async (workers, expected, owner: string = '@forgeax/engine-app') => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-publication-'));
  try {
    const app = resolve(root, 'node_modules/@forgeax/engine-app');
    await mkdir(app, { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(app, 'package.json'),
      JSON.stringify({ name: owner, type: 'module', exports: './index.mjs' }),
    );
    await writeFile(
      resolve(root, 'entry.js'),
      "import * as factories from '@forgeax/engine-app'; export { factories };",
    );
    await writeFile(
      resolve(app, 'index.mjs'),
      ['engine', 'render', 'task']
        .map(
          (kind) =>
            `export const ${kind} = () => new Worker(new URL('./${kind}-worker-runtime.mjs', import.meta.url), { type: 'module' });`,
        )
        .join('\n'),
    );
    for (const kind of ['engine', 'render', 'task'])
      await writeFile(resolve(app, `${kind}-worker-runtime.mjs`), `postMessage('${kind}');`);
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [
        executionWorkerEntries([], 'native', undefined, workers as ExecutionWorkersOptions),
      ],
      build: {
        minify: false,
        rolldownOptions: {
          input: resolve(root, 'entry.js'),
          preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'entry.mjs' },
        },
      },
    });
    if (Array.isArray(result) || !('output' in result)) throw Error('Expected one output');
    const published = result.output.filter(
      (row) => row.type === 'chunk' && /(?:engine|render|task)-worker-runtime/.test(row.fileName),
    );
    expect(published.map((row) => row.name).sort()).toEqual(
      expected.map((kind) => `${kind}-worker-runtime`).sort(),
    );
    const Worker = vi.fn(function Worker() {});
    vi.stubGlobal('Worker', Worker);
    const { factories } = await import(pathToFileURL(resolve(root, 'dist/entry.mjs')).href);
    for (const kind of ['engine', 'render', 'task']) {
      if (!expected.some((published) => published === kind))
        expect(() => factories[kind]()).toThrow(
          `Execution Worker disabled by build policy: ${kind === 'task' ? 'kernels' : kind}`,
        );
    }
    expect(Worker).not.toHaveBeenCalled();
    expect(await readFile(resolve(root, 'dist/entry.mjs'), 'utf8')).not.toContain('node:');
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
