import { describe, expect, it } from 'vitest';
import {
  abortCloudHistory,
  acceptCloudHistory,
  createCloudHistoryState,
  invalidateCloudHistory,
  prepareCloudHistory,
} from '../history';
import { cloudMode0Layout } from '../reconstruction';

const stamp = {
  viewId: 'main',
  width: 1919,
  height: 1079,
  deviceGeneration: 0,
  materialIdentity: 'a',
  policyIdentity: 'mode0',
  initializationRevision: 0,
  exposure: 1,
};

describe('Mode 0 submitted history transactions', () => {
  it('revokes a pending receipt before device recovery without publishing retired resources', () => {
    const state = createCloudHistoryState<string>();
    const pending = prepareCloudHistory(state, stamp);
    invalidateCloudHistory(state);
    expect(acceptCloudHistory(state, pending, 'retired-device')).toBe(false);
    expect(state.accepted).toBeUndefined();
    expect(prepareCloudHistory(state, { ...stamp, deviceGeneration: 1 }).phase).toBe(0);
  });
  it('ceil-divides each level, preserving odd edges', () => {
    expect(cloudMode0Layout(1919, 1079)).toEqual({
      full: { width: 1919, height: 1079 },
      reconstruct: { width: 960, height: 540 },
      trace: { width: 480, height: 270 },
    });
    expect(cloudMode0Layout(5, 3).trace).toEqual({ width: 2, height: 1 });
    expect(() => cloudMode0Layout(0, 5)).toThrow();
  });
  it('advances [0,2,3,1] only after actual acceptance, ignoring stale candidates', () => {
    const state = createCloudHistoryState<string>();
    const first = prepareCloudHistory(state, stamp);
    expect(first.history).toBeUndefined();
    expect(abortCloudHistory(state, first)).toBe(true);
    expect(state.completedFrames).toBe(0);
    const retry = prepareCloudHistory(state, stamp);
    expect(acceptCloudHistory(state, first, 'stale')).toBe(false);
    expect(acceptCloudHistory(state, retry, 'a')).toBe(true);
    const offsets = [retry.pixelOffset];
    for (let i = 0; i < 3; i++) {
      const next = prepareCloudHistory(state, stamp);
      offsets.push(next.pixelOffset);
      acceptCloudHistory(state, next, `frame${i}`);
    }
    expect(offsets).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ]);
  });
  it('retains accepted resources across abort and rejects overlapping preparation', () => {
    const state = createCloudHistoryState<string>();
    acceptCloudHistory(state, prepareCloudHistory(state, stamp), 'original');
    const candidate = prepareCloudHistory(state, { ...stamp, initializationRevision: 1 });
    expect(candidate.resetReasons).toEqual(['initialization']);
    expect(candidate.history).toBeUndefined();
    expect(() => prepareCloudHistory(state, stamp)).toThrow();
    abortCloudHistory(state, candidate);
    expect(state.accepted?.resource).toBe('original');
    expect(prepareCloudHistory(state, stamp).history?.resource).toBe('original');
  });
  it.each([
    [{ width: 1900 }, 'resize'],
    [{ deviceGeneration: 1 }, 'device-generation'],
    [{ cameraCut: true }, 'camera-cut'],
    [{ materialIdentity: 'b' }, 'material-changed'],
    [{ policyIdentity: 'changed' }, 'policy-changed'],
    [{ viewId: 'other' }, 'view-changed'],
  ] as const)('rejects incompatible history %j', (change, reason) => {
    const state = createCloudHistoryState<string>();
    acceptCloudHistory(state, prepareCloudHistory(state, stamp), 'a');
    expect(prepareCloudHistory(state, { ...stamp, ...change }).resetReasons).toContain(reason);
  });
  it('retains history across exposure changes without a fixed history blend weight', () => {
    const state = createCloudHistoryState<string>();
    acceptCloudHistory(state, prepareCloudHistory(state, stamp), 'a');
    expect(prepareCloudHistory(state, { ...stamp, exposure: 2 }).history?.resource).toBe('a');
  });
  it('keeps small solar motion and spectral noise, rejecting angle jumps and substantive channel changes', () => {
    const lighting = { directionToLight: [0, 1, 0] as const, illuminance: [100, 80, 20] as const };
    const state = createCloudHistoryState<string>();
    acceptCloudHistory(state, prepareCloudHistory(state, { ...stamp, lighting }), 'lit');
    const subtle = prepareCloudHistory(state, {
      ...stamp,
      lighting: { directionToLight: [0.001, 1, 0], illuminance: [100.01, 80, 20] },
    });
    expect(subtle.history?.resource).toBe('lit');
    abortCloudHistory(state, subtle);
    for (const changed of [
      { directionToLight: [0.01, 1, 0] as const, illuminance: lighting.illuminance },
      { directionToLight: lighting.directionToLight, illuminance: [100, 80, 10] as const },
      { directionToLight: lighting.directionToLight, illuminance: [0, 0, 0] as const },
    ]) {
      const next = prepareCloudHistory(state, { ...stamp, lighting: changed });
      expect(next.resetReasons).toEqual(['lighting-changed']);
      expect(next.history).toBeUndefined();
      abortCloudHistory(state, next);
    }
  });
});
