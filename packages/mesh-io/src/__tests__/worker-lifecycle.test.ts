import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { runMeshWorker } from '../worker.js';

it.each([
  [
    'success',
    "require('node:worker_threads').parentPort.postMessage('done'); setInterval(() => {}, 1000)",
    true,
  ],
  ['exit', 'process.exit(0)', false],
  ['error', "throw new Error('broken parser')", false],
  ['timeout', 'setInterval(() => {}, 1000)', false],
] as const)('retires a format Worker before returning %s', async (kind, source, success) => {
  const worker = new Worker(source, { eval: true });
  const result = await runMeshWorker<string>(
    worker,
    'test',
    'deadline',
    kind === 'timeout' ? 20 : 5_000,
  );
  expect(result.ok).toBe(success);
  expect(worker.threadId).toBe(-1);
  if (result.ok) expect(result.value).toBe('done');
  else
    expect(result.error).toMatchObject({
      detail: {
        reason: expect.stringContaining(
          kind === 'timeout'
            ? 'deadline'
            : kind === 'exit'
              ? 'before producing a result'
              : 'broken parser',
        ),
      },
    });
});
