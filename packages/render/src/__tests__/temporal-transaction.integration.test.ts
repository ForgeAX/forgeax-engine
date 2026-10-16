import { describe, expect, it } from 'vitest';
import { TemporalFrameCoordinator } from '../temporal/frame-coordinator';

describe('temporal successful-submit transaction', () => {
  it.each([
    'build',
    'encode',
    'finish',
    'submit',
  ] as const)('does not publish state when %s fails', (stage) => {
    const coordinator = new TemporalFrameCoordinator<number>();
    const result = coordinator.run(
      { current: 7, antialias: 'taa' },
      {
        build: () => {
          if (stage === 'build') throw { stage };
          return 7;
        },
        encode: () => {
          if (stage === 'encode') throw { stage };
        },
        finish: () => {
          if (stage === 'finish') throw { stage };
        },
        submit: () => {
          if (stage === 'submit') throw { stage };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(coordinator.inspect()).toMatchObject({
      epoch: 0,
      previous: undefined,
      attempt: 'aborted',
    });
  });

  it('publishes current and advances history only after submit', () => {
    const coordinator = new TemporalFrameCoordinator<number>();
    const result = coordinator.run(
      { current: 3, antialias: 'taa' },
      { build: () => 3, encode: () => undefined, finish: () => undefined, submit: () => undefined },
    );
    expect(result).toMatchObject({ ok: true, value: { epoch: 1, previous: 3 } });
    expect(coordinator.inspect()).toMatchObject({ epoch: 1, previous: 3, attempt: 'committed' });
  });

  it.each([
    'cut',
    'resize',
    'camera-switch',
    'detach',
    'device-loss',
  ] as const)('resets history on %s', (reason) => {
    const coordinator = new TemporalFrameCoordinator<number>({ previous: 1, epoch: 3 });
    coordinator.reset(reason);
    expect(coordinator.inspect()).toMatchObject({ epoch: 0, previous: undefined, attempt: 'none' });
    expect(coordinator.historyStore.inspect().valid).toBe(false);
  });
});

import { executeAutoExposureFrameTransaction } from '../assembly/renderer-frame-transaction';
import {
  createAutoExposureState,
  resetAutoExposureState,
} from '../pipeline/standard-output/auto-exposure/state';

describe('temporal and auto exposure transaction identity', () => {
  it('keeps reset and device identity when submit aborts', () => {
    const initial = createAutoExposureState({ fallback: 1, targetGeneration: 2, deviceEpoch: 5 });
    if (!initial.ok) throw initial.error;
    const reset = resetAutoExposureState(initial.value, 'device-lost', {
      targetGeneration: 3,
      deviceEpoch: 6,
    });
    const result = executeAutoExposureFrameTransaction(
      reset,
      { ev: 2, generation: 3, deviceEpoch: 6, frameId: 12 },
      { failAt: 'submit' },
    );

    expect(result.ok).toBe(false);
    expect(result.state).toBe(reset);
    expect(result.state.reset).toEqual(['device-lost']);
    expect(result.state.deviceEpoch).toBe(6);
    expect(result.state.receipt.committed).toBe(false);
  });
});
