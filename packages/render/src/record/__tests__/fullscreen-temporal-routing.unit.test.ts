import { describe, expect, it } from 'vitest';
import { isTemporalFullscreenBinding } from '../../fullscreen-post-process-pass';
import { shouldUseTemporalFrameTransaction } from '../typed-frame-graph';

describe('fullscreen temporal routing', () => {
  it('keeps ordinary fullscreen bindings on the non-temporal path', () => {
    expect(isTemporalFullscreenBinding({ fullscreen: true, shader: 'forgeax.fxaa' })).toBe(false);
    expect(isTemporalFullscreenBinding({ fullscreen: true, shader: 'forgeax.tonemap' })).toBe(
      false,
    );
    expect(isTemporalFullscreenBinding({ fullscreen: true, shader: 'forgeax.motion-blur' })).toBe(
      true,
    );
    expect(
      isTemporalFullscreenBinding({ fullscreen: true, temporal: { kind: 'scene-data' } }),
    ).toBe(true);
  });

  it('opens the coordinator only for TAA frames', () => {
    expect(shouldUseTemporalFrameTransaction('none')).toBe(false);
    expect(shouldUseTemporalFrameTransaction('fxaa')).toBe(false);
    expect(shouldUseTemporalFrameTransaction('msaa')).toBe(false);
    expect(shouldUseTemporalFrameTransaction('taa')).toBe(true);
  });
});
