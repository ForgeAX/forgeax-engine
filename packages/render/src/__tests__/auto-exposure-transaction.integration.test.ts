import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  executeAutoExposureFrameTransaction,
  type RendererFrameStage,
} from '../assembly/renderer-frame-transaction';
import {
  type AutoExposureCandidate,
  commitAutoExposureSubmission,
  createAutoExposureState,
} from '../pipeline/standard-output/auto-exposure/state';
import { renderTime } from '../publication/resource-scope';
import { canonicalizeWorldComposition } from '../render-system-projections';

function candidate(): AutoExposureCandidate {
  return { ev: 1.25, generation: 4, deviceEpoch: 2, frameId: 9 };
}

function state() {
  const result = createAutoExposureState({
    fallback: 1,
    targetGeneration: 4,
    deviceEpoch: 2,
    frameId: 8,
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('auto exposure frame transaction', () => {
  it.each([
    'build',
    'execute',
    'finish',
    'submit',
  ] as const)('keeps accepted state on %s failure', (failedStage: RendererFrameStage) => {
    const before = state();
    const result = executeAutoExposureFrameTransaction(before, candidate(), {
      failAt: failedStage,
    });

    expect(result).toMatchObject({ ok: false, error: { stage: failedStage } });
    expect(result.state).toEqual(before);
    expect(result.state.receipt.committed).toBe(false);
    expect(result.state.deviceEpoch).toBe(2);
  });

  it('publishes candidate exactly once after submit', () => {
    const result = executeAutoExposureFrameTransaction(state(), candidate());

    expect(result.ok).toBe(true);
    expect(result.state.acceptedEv).toBe(1.25);
    expect(result.state.lastKnownGood).toBe(1.25);
    expect(result.state.receipt).toEqual({ frameId: 9, committed: true });
    expect(result.commitCount).toBe(1);
  });

  it('publishes only the GPU submit receipt without inventing a CPU exposure value', () => {
    const before = state();
    const after = commitAutoExposureSubmission(before, {
      generation: 4,
      deviceEpoch: 2,
      frameId: 9,
    });
    expect(after.receipt).toEqual({ frameId: 9, committed: true });
    expect(after.acceptedEv).toBe(0);
    expect(after.lastKnownGood).toBe(before.lastKnownGood);
  });

  it('keeps camera-owned delta time after reversing a two-World composition', () => {
    const first = new World();
    const second = new World();
    const worlds =
      first.identity.localeCompare(second.identity) < 0 ? [second, first] : [first, second];
    const cameraWorld = worlds[0];
    const otherWorld = worlds[1];
    if (cameraWorld === undefined || otherWorld === undefined) {
      throw new Error('expected a two-World composition');
    }
    cameraWorld.update(1 / 30).unwrap();
    otherWorld.update(1 / 120).unwrap();

    const composition = canonicalizeWorldComposition(
      worlds,
      { cameraOwner: 0, resourceOwner: 0 },
      undefined,
    );
    const resolvedCameraWorld = composition.worlds[composition.owners.cameraOwner];

    expect(resolvedCameraWorld).toBe(cameraWorld);
    if (resolvedCameraWorld === undefined) throw new Error('Camera owner is missing');
    expect(renderTime(resolvedCameraWorld).delta).toBeCloseTo(1 / 30);
  });
});
