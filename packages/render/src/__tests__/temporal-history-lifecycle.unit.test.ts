import type { RhiQueue } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  commitTemporalGpuSubmit,
  getTemporalBindGroupResources,
  getTemporalGpuState,
  retireTemporalGpuState,
  retireTemporalGpuStateAfterFence,
  stageTemporalGpuSubmit,
} from '../temporal/gpu';
import { TemporalHistory } from '../temporal/history';
import { inspectTemporal } from '../temporal/inspection';
import { createTemporalView } from '../temporal/view';

describe('TAA history lifecycle', () => {
  it('keeps stability history separate from downstream temporal-v1 metadata', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const textures = vi.spyOn(device, 'createTexture');
    const scope = DeviceScope.create(22, 'taa-stability-test');
    const state = getTemporalGpuState({} as RenderFrameState, device, scope, 8, 8);
    try {
      expect(textures.mock.calls.map(([desc]) => desc.format)).toEqual([
        'rgba16float',
        'rgba16float',
        'rgba16float',
        'rgba16float',
        'r8unorm',
        'r8unorm',
      ]);
      expect(state).toHaveProperty('stability');
      expect(state).toHaveProperty('cloudRadiance');
      expect(state).toHaveProperty('cloudTransmittance');
      expect(state).toHaveProperty('cloudDepth');
      expect(state.cloudHistoryEnabled).toBe(false);
      expect(state.cloudRadiance).toBeUndefined();
      const view = createTemporalView({ antialias: 'taa', width: 8, height: 8 });
      const inspection = inspectTemporal(view, undefined, { active: state });
      expect(inspection.historyBytes).toBe(34 * 8 * 8);
      expect(inspection.resources.activeBytes).toBe(34 * 8 * 8);
    } finally {
      retireTemporalGpuState(state);
    }
  });
  it('allocates the cloud MRT only for a cloud-enabled candidate', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const textures = vi.spyOn(device, 'createTexture');
    const state = getTemporalGpuState(
      {} as RenderFrameState,
      device,
      DeviceScope.create(23, 'cloud-history-test'),
      8,
      8,
      true,
    );
    try {
      expect(state.cloudHistoryEnabled).toBe(true);
      expect(state.cloudRadiance).toBeDefined();
      expect(textures).toHaveBeenCalledTimes(12);
      expect(textures.mock.calls.slice(6).map(([desc]) => desc.label)).toEqual([
        'cloud-history-radiance-a',
        'cloud-history-radiance-b',
        'cloud-history-transmittance-a',
        'cloud-history-transmittance-b',
        'cloud-history-depth-a',
        'cloud-history-depth-b',
      ]);
    } finally {
      retireTemporalGpuState(state);
    }
  });
  it('filters subpixel color reconstruction without filtering temporal metadata', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const samplers = vi.spyOn(device, 'createSampler');
    const layouts = vi.spyOn(device, 'createBindGroupLayout');
    const state = getTemporalGpuState(
      {} as RenderFrameState,
      device,
      DeviceScope.create(20, 'taa-test'),
      8,
      8,
    );
    getTemporalBindGroupResources(state);
    expect(samplers.mock.calls.map(([desc]) => desc?.magFilter)).toEqual(['linear', 'nearest']);
    const entries = Array.from(layouts.mock.calls[0]?.[0].entries ?? []);
    expect(entries.find((entry) => entry.binding === 1)?.sampler?.type).toBe('filtering');
    expect(entries.find((entry) => entry.binding === 5)?.sampler?.type).toBe('non-filtering');
    retireTemporalGpuState(state);
  });
  it('accounts for color, temporal, and private stability histories only for TAA', () => {
    const scope = DeviceScope.create(8, 'renderer');
    const taa = new TemporalHistory(scope, { width: 320, height: 200, mode: 'taa' });
    const off = new TemporalHistory(scope, { width: 320, height: 200, mode: 'off' });
    expect(taa.historyCount).toBe(6);
    expect(taa.historyBytes).toBe(34 * 320 * 200);
    expect(taa.childScope?.parent).toBe(scope);
    expect(off.historyCount).toBe(0);
    expect(off.historyBytes).toBe(0);
    expect(off.childScope).toBeUndefined();
  });

  it('seeds current-only on the first frame and commits producer state once', () => {
    const scope = DeviceScope.create(9, 'renderer');
    const history = new TemporalHistory(scope, { width: 64, height: 64, mode: 'taa' });
    const view = createTemporalView({ antialias: 'taa', width: 64, height: 64 });
    expect(history.snapshot().historyValid).toBe(false);
    history.stage(view, {
      rigid: 'rigid:1',
      instance: 'instance:1',
      skin: 'skin:1',
      morph: 'morph:1',
    });
    expect(history.snapshot().historyValid).toBe(false);
    history.commit();
    expect(history.snapshot()).toMatchObject({ historyValid: true, frameIndex: 1 });
    expect(history.snapshot().previous).toEqual({
      rigid: 'rigid:1',
      instance: 'instance:1',
      skin: 'skin:1',
      morph: 'morph:1',
    });
  });

  it('does not advance on an aborted candidate', () => {
    const scope = DeviceScope.create(10, 'renderer');
    const history = new TemporalHistory(scope, { width: 32, height: 32, mode: 'taa' });
    const view = createTemporalView({ antialias: 'taa', width: 32, height: 32 });
    history.stage(view, { rigid: 'candidate' });
    history.abort();
    expect(history.snapshot()).toMatchObject({ historyValid: false, frameIndex: 0 });
  });

  it('owns GPU histories by the renderer child scope and retires replacements', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(12, 'renderer');
    const frameState = {
      temporalGpuState: undefined,
      activeTemporalGpuState: undefined,
      retiringTemporalGpuStates: new Set(),
    } as unknown as RenderFrameState;
    const active = getTemporalGpuState(frameState, device, scope, 64, 64);
    frameState.activeTemporalGpuState = active;
    frameState.temporalGpuState = undefined;
    expect(active.childScope.parent).toBe(scope);
    expect(active.childScope.resourceDelta()).toBe(6);
    const bindGroupResources = getTemporalBindGroupResources(active);
    expect(bindGroupResources.sampler).not.toBeNull();
    expect(active.childScope.resourceDelta()).toBe(9);
    expect(getTemporalGpuState(frameState, device, scope, 64, 64)).toBe(active);

    const replacement = getTemporalGpuState(frameState, device, scope, 128, 64);
    expect(replacement).not.toBe(active);
    expect(frameState.activeTemporalGpuState).toBe(active);
    retireTemporalGpuState(replacement);
    expect(replacement.childScope.state).toBe('retired');
    expect(replacement.childScope.resourceDelta()).toBe(0);
    retireTemporalGpuState(active);
    expect(active.childScope.state).toBe('retired');
    expect(active.childScope.resourceDelta()).toBe(0);
  });

  it('keeps submitted resources retiring until the queue fence resolves', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(13, 'renderer');
    const state = getTemporalGpuState(
      { temporalGpuState: undefined, activeTemporalGpuState: undefined } as RenderFrameState,
      device,
      scope,
      32,
      32,
    );
    getTemporalBindGroupResources(state);
    stageTemporalGpuSubmit(state);
    commitTemporalGpuSubmit(state);
    let resolveFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    const queue = { onSubmittedWorkDone: () => fence } as unknown as RhiQueue;
    const retiring = new Set<typeof state>();
    retireTemporalGpuStateAfterFence(state, queue, retiring, () => {
      throw new Error('unexpected temporal retirement failure');
    });
    expect(state.childScope.state).toBe('retiring');
    expect(state.childScope.resourceDelta()).toBe(9);
    expect(retiring.has(state)).toBe(true);
    resolveFence();
    await fence;
    await Promise.resolve();
    expect(state.childScope.state).toBe('retired');
    expect(state.childScope.resourceDelta()).toBe(0);
    expect(retiring.has(state)).toBe(false);
  });

  it('refuses to promote a candidate without a staged write', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(14, 'renderer');
    const state = getTemporalGpuState(
      { temporalGpuState: undefined, activeTemporalGpuState: undefined } as RenderFrameState,
      device,
      scope,
      16,
      16,
    );
    expect(commitTemporalGpuSubmit(state)).toBe(false);
    expect(state.valid).toBe(false);
    expect(state.committed).toBe(false);
    retireTemporalGpuState(state);
  });

  it('cleans a rejected retirement fence exactly once', async () => {
    const device = (await new RhiNullAdapter().requestDevice()).unwrap();
    const scope = DeviceScope.create(15, 'renderer');
    const state = getTemporalGpuState(
      { temporalGpuState: undefined, activeTemporalGpuState: undefined } as RenderFrameState,
      device,
      scope,
      16,
      16,
    );
    getTemporalBindGroupResources(state);
    stageTemporalGpuSubmit(state);
    commitTemporalGpuSubmit(state);
    const failure = new Error('queue completion failed');
    const retiring = new Set<typeof state>();
    const causes: unknown[] = [];
    retireTemporalGpuStateAfterFence(
      state,
      { onSubmittedWorkDone: () => Promise.reject(failure) } as unknown as RhiQueue,
      retiring,
      (cause) => causes.push(cause),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(causes).toEqual([failure]);
    expect(state.childScope.state).toBe('retired');
    expect(state.childScope.resourceDelta()).toBe(0);
    expect(retiring.size).toBe(0);
    retireTemporalGpuState(state);
    expect(causes).toHaveLength(1);
  });
});
