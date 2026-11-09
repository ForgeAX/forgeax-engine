import { describe, expect, it } from 'vitest';
import { ANTIALIAS_TAA, ANTIALIAS_TSR, antialiasFromF32 } from '../components/camera';
import { validateDynamicResolutionCamera } from '../components/dynamic-resolution';
import { TemporalViewHistory } from '../temporal/frame';
import { createTemporalView, resolveTemporalReset } from '../temporal/view';

describe('TSR temporal contract', () => {
  it('keeps published TAA identity and gives TSR its own mode', () => {
    expect(ANTIALIAS_TAA).toBe(3);
    expect(ANTIALIAS_TSR).toBe(5);
    expect(antialiasFromF32(ANTIALIAS_TSR)).toBe('tsr');
    expect(antialiasFromF32(ANTIALIAS_TAA)).toBe('taa');
  });

  it('scales the shared jitter in input pixels and preserves output-sized history', () => {
    const view = createTemporalView({
      antialias: 'tsr',
      width: 1920,
      height: 1080,
      internalWidth: 960,
      internalHeight: 536,
      frameIndex: 1,
    });
    expect(view.mode).toBe('tsr');
    expect(view.historyRequired).toBe(true);
    expect(view.currentJitterUv).toEqual([-0.25 / 960, 1 / 6 / 536]);
    expect([view.input.width, view.input.height]).toEqual([1920, 1080]);
    expect(view.currentProjection).toBe('jittered');
  });

  it('accepts TSR in the existing DRS controller and rejects spatial AA', () => {
    const drs = { minScale: 0.5, maxScale: 1, targetGpuMs: 16.67 };
    expect(validateDynamicResolutionCamera(drs, 'tsr').ok).toBe(true);
    expect(validateDynamicResolutionCamera(drs, 'taa').ok).toBe(true);
    expect(validateDynamicResolutionCamera(drs, 'fxaa').ok).toBe(false);
  });

  it('cuts history when switching algorithms but keeps it over input-only scale changes', () => {
    const taa = createTemporalView({ antialias: 'taa', width: 100, height: 100 });
    const tsr = createTemporalView({ antialias: 'tsr', width: 100, height: 100 });
    const scaled = createTemporalView({
      antialias: 'tsr',
      width: 100,
      height: 100,
      internalWidth: 50,
      internalHeight: 50,
    });
    expect(resolveTemporalReset(taa.input, tsr.input)).toBe('first-frame');
    expect(resolveTemporalReset(tsr.input, taa.input)).toBe('first-frame');
    expect(resolveTemporalReset(tsr.input, scaled.input)).toBeUndefined();
  });

  it('only advances TSR jitter after a successful committed frame', () => {
    const history = new TemporalViewHistory();
    const view = createTemporalView({ antialias: 'tsr', width: 16, height: 16 });
    history.stage({ kind: 'tsr', view });
    history.discard();
    expect(history.frameIndex).toBe(0);
    history.stage({ kind: 'tsr', view });
    expect(history.commit()).toBe('tsr');
    expect(history.frameIndex).toBe(1);
    expect(history.accepted?.mode).toBe('tsr');
  });
});
