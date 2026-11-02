import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { RenderFrameState } from '../frame-snapshot';
import { prepareViewSky } from '../helpers';
import type { RenderSystemInternals } from '../render-context';

const internals = {} as RenderSystemInternals;
const world = {} as RenderResourceScope;
const sky = (skylightCount: number, skyboxCount: number) => ({
  skylight: undefined,
  skylightCount,
  skybox: undefined,
  skyboxCount,
});

describe('prepareViewSky (render-standard-lighting sky step)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once per renderer for a duplicated Skylight and SkyboxBackground', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = {
      warnedMultiSkylight: false,
      warnedMultiSkybox: false,
    } as RenderFrameState;
    prepareViewSky(internals, world, frameState, sky(2, 3));
    prepareViewSky(internals, world, frameState, sky(2, 3));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stays silent for a single Skylight and no equirect source', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frameState = {
      warnedMultiSkylight: false,
      warnedMultiSkybox: false,
    } as RenderFrameState;
    prepareViewSky(internals, world, frameState, sky(1, 0));
    expect(spy).not.toHaveBeenCalled();
  });
});
