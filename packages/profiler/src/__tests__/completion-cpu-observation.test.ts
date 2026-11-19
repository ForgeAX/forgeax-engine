import { describe, expect, it, vi } from 'vitest';
import { createProfiler } from '../profiler.js';

describe('receipt completion CPU observations', () => {
  it('records callback-only time against the exact receipt after frame-limit auto-finish', () => {
    let nowMicros = 100;
    const profiler = createProfiler({ clock: { nowMicros: () => nowMicros } });
    const observations: unknown[] = [];
    profiler.observeCompletionCpu((observation) => observations.push(observation));
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 8 });
    expect(started.ok).toBe(true);
    if (!started.ok) throw started.error;
    const session = started.value;
    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.currentFrameToken()).toEqual({ captureId: session.captureId, frameId: 1 });
    expect(session.endFrame().ok).toBe(true);
    expect(session.currentFrameToken()).toBeUndefined();
    expect(profiler.activeSession()).toBeUndefined();

    const result = profiler.observeReceiptCompletion(
      {
        profileFrame: { captureId: session.captureId, frameId: 1 },
        frameId: 27,
        deviceGeneration: 4,
      },
      () => {
        nowMicros = 135;
        return 'not awaited';
      },
    );

    expect(result).toBe('not awaited');
    expect(observations).toEqual([
      {
        captureId: session.captureId,
        profileFrameId: 1,
        receiptFrameId: 27,
        deviceGeneration: 4,
        callbackStatus: 'returned',
        startMicros: 100,
        endMicros: 135,
        durationMicros: 35,
      },
    ]);
    expect(Object.isFrozen(observations[0])).toBe(true);
  });

  it('preserves callback throws and isolates observer failures', () => {
    let nowMicros = 10;
    const profiler = createProfiler({ clock: { nowMicros: () => nowMicros } });
    const observations: unknown[] = [];
    profiler.observeCompletionCpu(() => {
      throw new Error('diagnostic subscriber failed');
    });
    profiler.observeCompletionCpu((observation) => observations.push(observation));
    const failure = new Error('application completion callback failed');

    expect(() =>
      profiler.observeReceiptCompletion(
        {
          profileFrame: { captureId: 'capture-0001', frameId: 1 },
          frameId: 7,
          deviceGeneration: 2,
        },
        () => {
          nowMicros = 16;
          throw failure;
        },
      ),
    ).toThrow(failure);
    expect(observations).toHaveLength(1);
    expect(observations).toMatchObject([
      {
        captureId: 'capture-0001',
        profileFrameId: 1,
        receiptFrameId: 7,
        deviceGeneration: 2,
        callbackStatus: 'threw',
        startMicros: 10,
        endMicros: 16,
        durationMicros: 6,
      },
    ]);
  });

  it('does not sample the clock without an observation lease or a profile token', () => {
    const nowMicros = vi.fn(() => 1);
    const profiler = createProfiler({ clock: { nowMicros } });
    let profileFrameReads = 0;
    const receipt = {
      get profileFrame() {
        profileFrameReads += 1;
        return undefined;
      },
      frameId: 1,
      deviceGeneration: 1,
    };
    expect(profiler.observeReceiptCompletion(receipt, () => 'plain')).toBe('plain');
    expect(profileFrameReads).toBe(0);
    const release = profiler.observeCompletionCpu(() => {});
    expect(profiler.observeReceiptCompletion(receipt, () => 'untagged')).toBe('untagged');
    expect(profileFrameReads).toBe(1);
    expect(nowMicros).not.toHaveBeenCalled();
    release();
  });

  it('calls untagged or invalid-token callbacks once and preserves their original throw', () => {
    const profiler = createProfiler({ clock: { nowMicros: () => 1 } });
    profiler.observeCompletionCpu(() => {});
    const failure = new Error('one business callback failure');
    for (const receipt of [
      { profileFrame: undefined, frameId: 1, deviceGeneration: 1 },
      { profileFrame: { captureId: '', frameId: 0 }, frameId: Number.NaN, deviceGeneration: 1 },
    ]) {
      let callbackCount = 0;
      expect(() =>
        profiler.observeReceiptCompletion(receipt, () => {
          callbackCount += 1;
          throw failure;
        }),
      ).toThrow(failure);
      expect(callbackCount).toBe(1);
    }
  });

  it('detaches receipt identity once before callback mutation', () => {
    let clockReads = 0;
    const profiler = createProfiler({ clock: { nowMicros: () => (clockReads++ === 0 ? 50 : 75) } });
    const observations: unknown[] = [];
    profiler.observeCompletionCpu((observation) => observations.push(observation));
    const tokenValues = { captureId: 'capture-0004', frameId: 4 };
    const captureId = vi.fn(() => tokenValues.captureId);
    const profileFrameId = vi.fn(() => tokenValues.frameId);
    const receiptValues = { frameId: 62, deviceGeneration: 8 };
    const profileFrame = {
      get captureId() {
        return captureId();
      },
      get frameId() {
        return profileFrameId();
      },
    };
    const receipt = {
      profileFrameReads: 0,
      get profileFrame() {
        this.profileFrameReads += 1;
        return profileFrame;
      },
      get frameId() {
        return receiptValues.frameId;
      },
      get deviceGeneration() {
        return receiptValues.deviceGeneration;
      },
    };

    profiler.observeReceiptCompletion(receipt, () => {
      tokenValues.captureId = 'capture-9999';
      tokenValues.frameId = 99;
      receiptValues.frameId = 99;
      receiptValues.deviceGeneration = 99;
    });

    expect(receipt.profileFrameReads).toBe(1);
    expect(captureId).toHaveBeenCalledTimes(1);
    expect(profileFrameId).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([
      {
        captureId: 'capture-0004',
        profileFrameId: 4,
        receiptFrameId: 62,
        deviceGeneration: 8,
        callbackStatus: 'returned',
        startMicros: 50,
        endMicros: 75,
        durationMicros: 25,
      },
    ]);
  });

  it('keeps callback results and errors when the post-callback diagnostic clock fails', () => {
    let reads = 0;
    const profiler = createProfiler({
      clock: {
        nowMicros() {
          reads += 1;
          if (reads % 2 === 0) throw new Error('post-callback clock failure');
          return 100;
        },
      },
    });
    const observations: unknown[] = [];
    profiler.observeCompletionCpu((observation) => observations.push(observation));
    const receipt = {
      profileFrame: { captureId: 'capture-0005', frameId: 1 },
      frameId: 10,
      deviceGeneration: 3,
    };
    let callbackCount = 0;
    expect(
      profiler.observeReceiptCompletion(receipt, () => {
        callbackCount += 1;
        return 'returned';
      }),
    ).toBe('returned');
    const callbackError = new Error('callback remains original');
    expect(() =>
      profiler.observeReceiptCompletion(receipt, () => {
        callbackCount += 1;
        throw callbackError;
      }),
    ).toThrow(callbackError);
    expect(callbackCount).toBe(2);
    expect(reads).toBe(4);
    expect(observations).toEqual([]);
  });
});
