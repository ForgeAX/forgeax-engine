import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const output = await build({
  entryPoints: [new URL('../../src/app/tool-queue.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { createToolQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
);
test('blocked subscriptions reserve foreground capacity and bound total admission', async () => {
  const active = new Set();
  let peak = 0;
  const queue = createToolQueue(
    (id) =>
      new Promise((resolve) => {
        active.add(id);
        peak = Math.max(peak, active.size);
        releases.set(id, () => {
          active.delete(id);
          resolve(id);
        });
      }),
  );
  const releases = new Map();
  const polls = Array.from({ length: 4 }, (_, i) => queue.call(`poll${i}`, { background: true }));
  const foreground = Array.from({ length: 8 }, (_, i) => queue.call(`asset${i}`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...active], ['poll0', 'asset0', 'asset1', 'asset2']);
  assert.equal(peak, 4);
  for (let i = 0; i < 8; i++) {
    releases.get(`asset${i}`)();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(foreground);
  assert.ok(active.has('poll0'));
  assert.equal(peak, 4);
  for (let i = 0; i < 4; i++) {
    releases.get(`poll${i}`)();
    if (i < 3) await new Promise((resolve) => setTimeout(resolve, 260));
  }
  await Promise.all(polls);
  queue.close();
});
test('cancelled queued work never reaches the host and retirement rejects pending work', async () => {
  let release;
  let calls = 0;
  const queue = createToolQueue(
    () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    { foreground: 1, background: 1 },
  );
  const active = queue.call('active');
  const controller = new AbortController();
  const cancelled = queue.call('cancelled', { signal: controller.signal });
  const rejection = assert.rejects(cancelled, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejection;
  const retired = queue.call('retired');
  const retiredResult = assert.rejects(retired, /retired/);
  queue.close();
  await retiredResult;
  release();
  await active;
  assert.equal(calls, 1);
});
test('a complete scene resource burst is admitted without dropping asset requests', async () => {
  let active = 0,
    peak = 0,
    completed = 0;
  const queue = createToolQueue(async (id) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    completed++;
    return id;
  });
  const results = await Promise.allSettled(Array.from({ length: 354 }, (_, id) => queue.call(id)));
  queue.close();
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
  assert.equal(completed, 354);
  assert.equal(peak, 3);
});
