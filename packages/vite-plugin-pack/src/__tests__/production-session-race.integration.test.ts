import { describe, expect, it } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import { createProductionSession } from '../production/session.js';

function fixture(produce: Parameters<typeof createProductionSession>[0]['produce']) {
  const discarded: number[] = [];
  const published: number[] = [];
  const session = createProductionSession({
    inventory: async () => [{ sourceKey: 'source-a', guids: ['guid-a'] }],
    produce,
    publish: async ({ generation }) => {
      published.push(generation);
    },
    discard: async ({ generation }) => {
      discarded.push(generation);
    },
  });
  return { session, discarded, published };
}

describe('ProductionSession generation fence', () => {
  it('does not let a stale generation discard the successor candidate', async () => {
    const firstProduction = testGate();
    const { session, discarded, published } = fixture(async ({ generation }) =>
      generation === 1 ? firstProduction.promise : undefined,
    );

    const stale = session.start();
    const current = session.rebuild([{ sourceKey: 'source-a' }]);
    firstProduction.resolve();

    const [staleResult, currentResult] = await Promise.all([stale, current]);

    expect(staleResult.status).toBe('stale');
    expect(currentResult.status).toBe('accepted');
    expect(published).toEqual([2]);
    expect(discarded).toEqual([1]);
    await session.close();
  });

  it('aborts materialization when a newer rebuild supersedes the accepted generation', async () => {
    const materializeStarted = testGate();
    const releaseMaterialize = testGate();
    let materializeAborted = false;
    const { session } = fixture(async ({ intent, signal }) => {
      if (intent !== 'materialize') return;
      signal.addEventListener('abort', () => {
        materializeAborted = true;
      });
      materializeStarted.resolve();
      await releaseMaterialize.promise;
    });

    expect((await session.start()).status).toBe('accepted');
    const materialized = session.materialize('guid-a');
    await materializeStarted.promise;

    const rebuilt = session.rebuild([{ sourceKey: 'source-a' }]);
    releaseMaterialize.resolve();

    expect(await materialized).toEqual({ status: 'stale', generation: 1 });
    expect(await rebuilt).toEqual({ status: 'accepted', generation: 2 });
    expect(materializeAborted).toBe(true);
    await session.close();
  });

  it('discards a failed candidate without poisoning the next generation', async () => {
    let calls = 0;
    const { session, discarded } = fixture(async ({ generation }) => {
      calls += 1;
      if (generation === 1) throw new Error('source failure');
    });

    const failed = await session.start();
    const recovered = await session.rebuild([{ sourceKey: 'source-a' }]);

    expect(failed.status).toBe('failed');
    expect(recovered.status).toBe('accepted');
    expect(calls).toBe(2);
    expect(discarded).toEqual([1]);
    await session.close();
  });

  it('classifies an obsolete producer failure as stale', async () => {
    let rejectFirst!: (reason: unknown) => void;
    const firstProduction = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const { session, discarded } = fixture(async ({ generation }) =>
      generation === 1 ? firstProduction : undefined,
    );

    const first = session.start();
    const successor = await session.rebuild([{ sourceKey: 'source-a' }]);
    rejectFirst(new Error('source changed during the obsolete generation'));

    expect(successor.status).toBe('accepted');
    expect(await first).toEqual({ status: 'stale', generation: 1 });
    expect(discarded).toEqual([1]);
    await session.close();
  });

  it('aborts intake, drains late work, and discards instead of publishing on close', async () => {
    const lateProduction = testGate();
    const started = testGate();
    let aborted = false;
    const { session, discarded, published } = fixture(async ({ signal }) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      started.resolve();
      await lateProduction.promise;
    });

    const pending = session.start();
    await started.promise;
    const closing = session.close();
    lateProduction.resolve();
    await closing;

    expect(aborted).toBe(true);
    expect(await pending).toEqual({ status: 'stale', generation: 1 });
    expect(published).toEqual([]);
    expect(discarded).toEqual([1]);
  });

  it('does not resolve close until an abort-ignoring producer reaches terminal state', async () => {
    const lateProduction = testGate();
    const started = testGate();
    const { session } = fixture(async () => {
      started.resolve();
      await lateProduction.promise;
    });

    const pending = session.start();
    await started.promise;
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    lateProduction.resolve();
    await closing;

    expect(closed).toBe(true);
    expect(await pending).toEqual({ status: 'stale', generation: 1 });
  });
});
