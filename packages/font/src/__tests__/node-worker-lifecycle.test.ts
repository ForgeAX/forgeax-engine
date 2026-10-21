import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NodeWorkerAdapter } from '../node-worker-adapter.js';

it('owns one native message subscription per browser listener identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'font-worker-'));
  const script = join(directory, 'echo.mjs');
  await writeFile(
    script,
    "import { parentPort } from 'node:worker_threads'; parentPort.on('message', value => parentPort.postMessage(value));",
  );
  const worker = new NodeWorkerAdapter(script);
  try {
    const values: unknown[] = [];
    let received!: () => void;
    const done = new Promise<void>((resolve) => {
      received = resolve;
    });
    const listener = (event: { data: unknown }) => {
      values.push(event.data);
      received();
    };
    worker.addEventListener('message', listener);
    worker.addEventListener('message', listener);
    worker.postMessage('one');
    await done;
    expect(values).toEqual(['one']);
    worker.removeEventListener('message', listener);
    await worker.terminate();
  } finally {
    await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
