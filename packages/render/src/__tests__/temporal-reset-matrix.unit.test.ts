import { describe, expect, it } from 'vitest';
import { TEMPORAL_TAAU_DEPENDENCY_STATUS } from '../temporal/temporal-view';
import { createTemporalView, HALTON_23_8, resolveTemporalReset } from '../temporal/view';

const base = () =>
  createTemporalView({
    antialias: 'taa',
    width: 100,
    height: 100,
    historyVersion: 1,
    viewIdentity: 'main',
    environmentSignature: 'environment:1',
    fogSignature: 'fog:1',
    deviceGeneration: 4,
  });

describe('TemporalView reset matrix', () => {
  it.each([
    ['width', { width: 101 }, 'resize'],
    ['height', { height: 101 }, 'resize'],
    ['camera cut', { cameraCut: true }, 'camera-cut'],
    ['history version', { historyVersion: 2 }, 'history-version'],
    ['view identity', { viewIdentity: 'secondary' }, 'view-switch'],
    ['environment signature', { environmentSignature: 'environment:2' }, 'environment-change'],
    ['fog signature', { fogSignature: 'fog:2' }, 'fog-change'],
    ['device generation', { deviceGeneration: 5 }, 'device-recover'],
  ] as const)('resets on %s', (_label, changes, reason) => {
    const previous = base();
    const next = createTemporalView({ ...previous.input, ...changes });
    expect(resolveTemporalReset(previous, next)).toBe(reason);
  });

  it('does not reset a stable view', () => {
    const previous = base();
    const next = createTemporalView({ ...previous.input });
    expect(resolveTemporalReset(previous, next)).toBeUndefined();
  });

  it('applies camera reset reasons to motion-blur-only off views', () => {
    const previous = createTemporalView({ ...base().input, antialias: 'none' });
    const next = createTemporalView({
      ...previous.input,
      antialias: 'none',
      viewIdentity: 'secondary',
    });
    expect(resolveTemporalReset(previous, next)).toBe('view-switch');
  });

  it('treats an explicit off commit as a first-frame boundary when TAA resumes', () => {
    const previous = base();
    const off = createTemporalView({
      ...previous.input,
      antialias: 'none',
      frameIndex: previous.temporalFrameIndex,
      historyValid: false,
      previousUnjitteredViewProjection: undefined,
    });
    expect(off.mode).toBe('off');
    expect(off.historyRequired).toBe(false);
    expect(off.currentProjection).toBe('unjittered');

    const resumed = createTemporalView({
      ...previous.input,
      frameIndex: 0,
      historyValid: false,
      previousUnjitteredViewProjection: undefined,
    });
    expect(resolveTemporalReset(off, resumed)).toBe('first-frame');
    expect(resumed.previousUnjitteredViewProjection).toBeUndefined();
  });

  it('reseeds the temporal sequence after a successful off commit', () => {
    const lastTaa = createTemporalView({
      ...base().input,
      frameIndex: 5,
      currentUnjitteredViewProjection: Float32Array.from({ length: 16 }, (_v, i) => i + 1),
      previousUnjitteredViewProjection: Float32Array.from({ length: 16 }, (_v, i) => i + 2),
    });
    const off = createTemporalView({
      ...lastTaa.input,
      antialias: 'none',
      frameIndex: lastTaa.temporalFrameIndex,
      historyValid: false,
      previousUnjitteredViewProjection: undefined,
    });
    const firstAfterOff = createTemporalView({
      ...lastTaa.input,
      frameIndex: 0,
      historyValid: false,
      previousUnjitteredViewProjection: undefined,
      resetReason: resolveTemporalReset(off, lastTaa) ?? 'first-frame',
    });
    expect(firstAfterOff.temporalFrameIndex).toBe(0);
    expect(firstAfterOff.jitter).toEqual(HALTON_23_8[0]);
    expect(firstAfterOff.previousUnjitteredViewProjection).toBeUndefined();
    expect(firstAfterOff.resetReason).toBe('first-frame');

    const next = createTemporalView({
      ...firstAfterOff.input,
      frameIndex: firstAfterOff.temporalFrameIndex + 1,
      historyValid: true,
      previousUnjitteredViewProjection: firstAfterOff.currentUnjitteredViewProjection,
      resetReason: undefined,
    });
    expect(next.temporalFrameIndex).toBe(1);
    expect(next.jitter).toEqual(HALTON_23_8[1]);
  });

  it('records the renderer TAAU owner as available', () => {
    expect(TEMPORAL_TAAU_DEPENDENCY_STATUS).toBe('available');
  });
});
