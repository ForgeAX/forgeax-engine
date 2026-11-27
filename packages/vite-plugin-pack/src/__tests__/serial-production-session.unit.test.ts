import { expect, it } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import { createProductionSession } from '../production/session.js';

it('watcher rebuild and explicit import both publish without stale generations', async () => {
  let entered!: () => void;
  const { promise: gate, resolve: release } = testGate();
  const first = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const published: number[] = [];
  const source = createProductionSession({
    serial: true,
    inventory: async ({ generation }) => {
      if (generation === 1) {
        entered();
        await gate;
      }
      return [];
    },
    produce: async () => {},
    publish: async ({ generation }) => {
      published.push(generation);
    },
  });
  const watcher = source.start();
  await first;
  const explicit = source.rebuild([{ sourceKey: 'scene.pack.ts' }]);
  release();
  expect((await watcher).status).toBe('accepted');
  expect((await explicit).status).toBe('accepted');
  expect(published).toEqual([1, 2]);
  await source.close();
});

it('closing cancels active production and drains queued operations without publishing', async () => {
  const { promise: first, resolve: entered } = testGate();
  const published: number[] = [];
  const source = createProductionSession({
    serial: true,
    inventory: async ({ signal }) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return [];
    },
    produce: async () => {},
    publish: async ({ generation }) => {
      published.push(generation);
    },
  });
  const running = source.start();
  await first;
  const queued = Promise.allSettled([
    source.rebuild([{ sourceKey: 'scene.pack.ts' }]),
    source.start(),
    source.materialize('guid'),
  ]);
  await source.close();
  expect((await running).status).not.toBe('accepted');
  for (const result of await queued) {
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'cleanup-failed' } });
  }
  expect(published).toEqual([]);
});
