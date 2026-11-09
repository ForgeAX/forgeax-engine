import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderFrameState } from '../frame-snapshot';
import { warnIgnoredDirectionalShadowCasters } from '../helpers';

describe('warnIgnoredDirectionalShadowCasters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stays silent without ignored shadow casters', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedIgnoredDirectionalShadow: false } as RenderFrameState;
    warnIgnoredDirectionalShadowCasters(frameState, {
      directional: { entity: 3 } as never,
      ignoredDirectionalShadowCasters: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns once, naming the CSM owner and the ignored entities', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = { warnedIgnoredDirectionalShadow: false } as RenderFrameState;
    const lights = {
      directional: { entity: 3 } as never,
      ignoredDirectionalShadowCasters: [5, 7],
    };
    warnIgnoredDirectionalShadowCasters(frameState, lights);
    warnIgnoredDirectionalShadowCasters(frameState, lights);
    expect(spy).toHaveBeenCalledTimes(1);
    const message = String(spy.mock.calls[0]?.[0]);
    expect(message).toContain('entity 3 owns the single CSM shadow');
    expect(message).toContain('entities 5, 7 render unshadowed');
  });
});
