import { describe, expect, it } from 'vitest';
import { executeRendererFrameTransaction } from '../assembly/renderer-frame-transaction';
import {
  commitStandardLutCandidate,
  createStandardLutState,
  inspectStandardLutState,
  prepareStandardLutCandidate,
  recordStandardLutFailure,
  resetStandardLutState,
} from '../pipeline/standard-output/lut-state';

describe('Standard LUT candidate and LKG transaction', () => {
  it('keeps the compatible LKG when validation or graph construction fails', () => {
    const initial = createStandardLutState({
      resident: 'lut:stable',
      targetGeneration: 3,
      deviceEpoch: 2,
    });
    const stale = prepareStandardLutCandidate(initial, {
      resident: 'lut:late',
      generation: 2,
      deviceEpoch: 2,
      frameId: 9,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe('standard-lut-stale-generation');

    const candidate = prepareStandardLutCandidate(initial, {
      resident: 'lut:new',
      generation: 3,
      deviceEpoch: 2,
      frameId: 10,
    });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const result = executeRendererFrameTransaction({
      build: () => ({ ok: true, value: candidate.value }),
      execute: () => ({ ok: false, stage: 'execute' as const }),
      finish: () => ({ ok: true, value: undefined }),
      submit: () => ({ ok: true, value: undefined }),
      commit: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(initial.lastKnownGood).toBe('lut:stable');
  });

  it('publishes a new resident only after the one submit barrier', () => {
    const initial = createStandardLutState({ resident: 'lut:stable' });
    const candidate = prepareStandardLutCandidate(initial, {
      resident: 'lut:new',
      generation: 0,
      deviceEpoch: 0,
      frameId: 2,
    });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    let state = initial;
    const result = executeRendererFrameTransaction({
      build: () => ({ ok: true, value: candidate.value }),
      execute: () => ({ ok: true, value: undefined }),
      finish: () => ({ ok: true, value: undefined }),
      submit: () => ({ ok: true, value: undefined }),
      commit: (value) => {
        state = commitStandardLutCandidate(state, value);
      },
    });
    expect(result.ok).toBe(true);
    expect(state.lastKnownGood).toBe('lut:new');
    expect(state.receipt.committed).toBe(true);
    expect(inspectStandardLutState(state)).toMatchObject({
      resident: 'lut:new',
      sourceKey: 'lut:new',
      receipt: { committed: true },
    });
  });

  it('resets residency after device recovery without publishing stale generations', () => {
    const initial = createStandardLutState({ resident: 'lut:stable', targetGeneration: 3 });
    const reset = resetStandardLutState(initial, 'device-recovered', {
      targetGeneration: 4,
      deviceEpoch: 1,
    });
    expect(reset.lastKnownGood).toBe('lut:stable');
    expect(reset.targetGeneration).toBe(4);
    expect(reset.receipt.committed).toBe(false);
  });

  it('retains accepted/LKG state and clears the failure only after a commit', () => {
    const initial = createStandardLutState({
      resident: 'lut:stable',
      targetGeneration: 3,
      deviceEpoch: 2,
      frameId: 7,
    });
    const failed = recordStandardLutFailure(initial, {
      code: 'standard-lut-filter-unavailable',
      expected: 'a live filterable 3D LUT view',
      hint: 'retry the same source key after producer recovery',
      detail: { sourceKey: 'lut:stable', format: 'rgba16float' },
    });
    expect(failed.resident).toBe('lut:stable');
    expect(failed.lastKnownGood).toBe('lut:stable');
    expect(inspectStandardLutState(failed).recentFailure).toMatchObject({
      code: 'standard-lut-filter-unavailable',
      expected: 'a live filterable 3D LUT view',
    });

    const candidate = prepareStandardLutCandidate(failed, {
      resident: 'lut:stable',
      sourceKey: 'lut:stable',
      generation: 3,
      deviceEpoch: 2,
      frameId: 8,
    });
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(
      inspectStandardLutState(commitStandardLutCandidate(failed, candidate.value)),
    ).not.toHaveProperty('recentFailure');
  });
});
