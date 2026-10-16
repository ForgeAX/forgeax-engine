import type { InputBackendSample } from '@forgeax/engine-input';
import { describe, expect, it } from 'vitest';
import { FrameCreditLedger } from '../execution/protocol';

const sample: InputBackendSample = {
  downKeys: new Set(),
  upKeys: new Set(),
  buttons: [false, false, false],
  movementX: 0,
  movementY: 0,
  wheelDelta: 0,
  focused: true,
  pointerLocked: false,
};

describe('frame credit protocol', () => {
  it('carries an explicit raw render sample timestamp through the frame message', () => {
    const ledger = new FrameCreditLedger('world-raw-time');
    const frame = ledger.issue(0.1, () => sample, { width: 320, height: 180 }, 12.5, true);
    expect(frame).toMatchObject({
      kind: 'frame',
      sampleTimeSeconds: 12.5,
      temporalReset: true,
      canvasWidth: 320,
      canvasHeight: 180,
    });
  });

  it('allows one in-flight frame and handles duplicate, late and old identities without writes', () => {
    const ledger = new FrameCreditLedger('world-1');
    const first = ledger.issue(0.016, () => sample);
    expect(first?.frameId).toBe(1);
    expect(ledger.issue(0.016, () => sample)).toBeUndefined();
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'old',
        frameId: 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('stale-world');
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-1',
        frameId: 2,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('late');
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-1',
        frameId: 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('accepted');
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-1',
        frameId: 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('duplicate');
    expect(ledger.issue(0.016, () => sample)?.frameId).toBe(2);
  });

  it('rejects a completion from the retired World before accepting the replacement generation', () => {
    const retired = new FrameCreditLedger('world-retired');
    const retiredFrame = retired.issue(0.016, () => sample);
    expect(retiredFrame?.frameId).toBe(1);

    const replacement = new FrameCreditLedger('world-replacement');
    expect(
      replacement.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-retired',
        frameId: retiredFrame?.frameId ?? 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('stale-world');

    const replacementFrame = replacement.issue(0.016, () => sample);
    expect(replacementFrame?.frameId).toBe(1);
    expect(
      replacement.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-replacement',
        frameId: replacementFrame?.frameId ?? 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('accepted');
    expect(replacement.inspect()).toMatchObject({ submitted: 1, completed: 1, inFlight: 0 });
  });
});
