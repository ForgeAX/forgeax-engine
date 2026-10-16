import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { VOLUMETRIC_FOG_PARAMS_BYTES } from '../../volume/resources';
import type { RenderFrameState } from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';
import {
  emptyVolumetricFogParams,
  promoteVolumetricFogParams,
  stageVolumetricFogParams,
} from '../volume-params';

async function nullDevice(): Promise<RhiDevice> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const result = await adapter.value.requestDevice();
  if (!result.ok) throw result.error;
  return result.value;
}

describe('volumetric fog parameter slots', () => {
  it('writes the pending slot and never the accepted one until promotion', async () => {
    const device = await nullDevice();
    const fired: unknown[] = [];
    const internals = {
      device,
      errorRegistry: { fire: (error: unknown) => fired.push(error) },
    } as unknown as RenderSystemInternals;
    const frameState = {
      volumetricFogParams: emptyVolumetricFogParams(),
    } as unknown as RenderFrameState;
    const payload = (value: number): Float32Array =>
      new Float32Array(VOLUMETRIC_FOG_PARAMS_BYTES / 4).fill(value);
    const state = (): RenderFrameState['volumetricFogParams'] => frameState.volumetricFogParams;

    const first = stageVolumetricFogParams(internals, frameState, payload(1));
    expect(state().pending?.slot).toBe(0);
    expect(state().accepted).toBeNull();
    // A failed submit retries into the same pending slot.
    expect(stageVolumetricFogParams(internals, frameState, payload(2))).toBe(first);
    expect(state().pending?.params[0]).toBe(2);

    promoteVolumetricFogParams(state());
    expect(state().accepted?.slot).toBe(0);
    expect(state().accepted?.params[0]).toBe(2);
    expect(state().pending).toBeNull();

    const second = stageVolumetricFogParams(internals, frameState, payload(3));
    expect(second).not.toBe(first);
    expect(state().pending?.slot).toBe(1);
    expect(state().accepted?.params[0]).toBe(2);
    promoteVolumetricFogParams(state());
    stageVolumetricFogParams(internals, frameState, payload(4));
    expect(state().pending?.slot).toBe(0);
    expect(state().buffers.filter((buffer) => buffer !== null)).toHaveLength(2);
    expect(fired).toEqual([]);
  });
});
