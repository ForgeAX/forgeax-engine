import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { retainBackendLifetime, watchBackendLifetime } from '../backend-lifetime.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-backend-lifetime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
function watcherTicks() {
  const nativeTimeout = globalThis.setTimeout;
  let pending: (() => void) | undefined;
  const scheduled = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms !== 20) return nativeTimeout(callback, ms, ...args);
    pending = () => callback(...args);
    return nativeTimeout(() => {}, 0);
  }) as typeof setTimeout);
  cleanup.push(() => scheduled.mockRestore());
  const settled = () => vi.waitFor(() => expect(pending).toBeTypeOf('function'));
  return {
    settled,
    waits: () => scheduled.mock.calls.filter(([, ms]) => ms === 25).length,
    async run() {
      await settled();
      const callback = pending;
      if (!callback) throw new Error('The watcher did not schedule its next check.');
      pending = undefined;
      callback();
    },
  };
}
it('retains siblings, releases the last owner and fences a replacement during shutdown', async () => {
  const root = await directory();
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const ticks = watcherTicks();
  const first = await retainBackendLifetime(root),
    second = await retainBackendLifetime(root);
  cleanup.push(first.close, second.close);
  let stopped = 0;
  let complete!: () => void;
  const disposal = new Promise<void>((done) => {
    complete = done;
  });
  const watch = watchBackendLifetime(
    root,
    async () => {
      stopped++;
      await disposal;
    },
    { intervalMs: 20, graceMs: 80 },
  );
  cleanup.push(() => {
    complete();
    watch.close();
  });
  await ticks.settled();
  await first.close();
  await ticks.run();
  await ticks.settled();
  now = 180;
  expect(stopped).toBe(0);
  await second.close();
  // Run a complete check after removal; a preceding check may have seen its owner.
  await ticks.run();
  await ticks.settled();
  now = 260;
  await ticks.run();
  await vi.waitFor(() => expect(stopped).toBe(1));
  let acquired = false;
  const waiting = ticks.waits();
  const next = retainBackendLifetime(root).then((value) => {
    acquired = true;
    cleanup.push(value.close);
    return value;
  });
  // The replacement must encounter the real admission lock held by disposal.
  await vi.waitFor(() => expect(ticks.waits()).toBeGreaterThan(waiting));
  expect(acquired).toBe(false);
  complete();
  await next;
  expect(acquired).toBe(true);
});
it('a new owner within the grace period cancels shutdown', async () => {
  const root = await directory();
  let stopped = false;
  let now = 0;
  // OS identity and disk locks stay real; only the grace clock is controlled.
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const ticks = watcherTicks();
  const first = await retainBackendLifetime(root);
  cleanup.push(first.close);
  const watch = watchBackendLifetime(
    root,
    async () => {
      stopped = true;
    },
    { intervalMs: 20, graceMs: 180 },
  );
  cleanup.push(watch.close);
  await ticks.settled();
  await first.close();
  await ticks.run();
  await ticks.settled();
  now = 70;
  const next = await retainBackendLifetime(root);
  cleanup.push(next.close);
  now = 240;
  await ticks.run();
  await ticks.settled();
  expect(stopped).toBe(false);
  await next.close();
  await ticks.run();
  await ticks.settled();
  now = 420;
  await ticks.run();
  await watch.finished;
  expect(stopped).toBe(true);
});
it('recovers a SIGKILL owner without relying on its handlers or reusing its PID', async () => {
  const root = await directory();
  const child = fork(new URL('./fixtures/backend-lifetime-owner.mjs', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  cleanup.push(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'message');
  let stopped = false;
  const watch = watchBackendLifetime(
    root,
    async () => {
      stopped = true;
    },
    { intervalMs: 20, graceMs: 80 },
  );
  cleanup.push(watch.close);
  await wait(160);
  expect(stopped).toBe(false);
  child.kill('SIGKILL');
  await once(child, 'exit');
  await watch.finished;
  expect(stopped).toBe(true);
});
it('shutdown failures remain visible to the owner', async () => {
  const root = await directory();
  const watch = watchBackendLifetime(
    root,
    async () => {
      throw new Error('dispose failed');
    },
    { intervalMs: 20, graceMs: 30 },
  );
  cleanup.push(watch.close);
  await expect(watch.finished).rejects.toThrow('dispose failed');
});
