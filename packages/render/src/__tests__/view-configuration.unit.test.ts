import { describe, expect, it, vi } from 'vitest';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { configureViewStandard, seedViewConfiguration } from '../view-configuration';
import type { ViewSettlementOwner } from '../world/view-settlement';

const device = { label: 'device' };

function owner(builtins: Map<string, PostProcessShaderEntry> = new Map()) {
  const registerBuiltinPostProcess = vi.fn((id: string, entry: PostProcessShaderEntry) => {
    builtins.set(id, entry);
    return () => builtins.delete(id);
  });
  const bag = {
    frameState: {
      installedPipelineHandle: 0,
      installedPipelineConfig: undefined,
      cameraStandardProfile: 'stale',
      standardInstall: {
        configured: undefined,
        built: 0,
        cameraConfigured: false,
        cameraFailure: '',
      },
    },
    internals: { device, standardProfile: undefined },
    ssrFormats: new WeakMap(),
    postProcess: { params: { builtinEntries: builtins, registerBuiltinPostProcess } },
  };
  return { bag, view: bag as unknown as ViewSettlementOwner, registerBuiltinPostProcess };
}

describe('view configuration', () => {
  it('installs the Standard configuration on one view owner and bumps its install epoch', () => {
    const { bag, view } = owner();
    configureViewStandard(view, { outputDither: false });
    configureViewStandard(view, { outputDither: false });
    expect(bag.frameState.installedPipelineHandle).toBe(2);
    expect(bag.frameState.standardInstall.configured).toEqual({ outputDither: false });
    expect(bag.frameState.installedPipelineConfig).toEqual({ outputDither: false });
    expect(bag.frameState.cameraStandardProfile).toBeUndefined();
  });

  it('rejects an invalid cluster grid before changing the view', () => {
    const { bag, view } = owner();
    expect(() => configureViewStandard(view, { clusterGrid: { x: 0, y: 1, z: 1 } })).toThrow();
    expect(bag.frameState.installedPipelineHandle).toBe(0);
  });

  it('seeds a new view from the primary owner without a RenderSystem', () => {
    const entry = { source: 'builtin' } as unknown as PostProcessShaderEntry;
    const primary = owner(new Map([['forgeax.fxaa', entry]]));
    configureViewStandard(primary.view, { outputDither: false });
    const receipt = { formats: [] };
    primary.bag.ssrFormats.set(device, receipt);
    const target = owner();
    seedViewConfiguration(primary.view, target.view);
    expect(target.registerBuiltinPostProcess).toHaveBeenCalledWith('forgeax.fxaa', entry);
    expect(target.bag.frameState.standardInstall.configured).toEqual({ outputDither: false });
    expect(target.bag.ssrFormats.get(device)).toBe(receipt);
  });
});

it('uses native V2 for a new Standard view and retains explicit saved V1', () => {
  const f = owner();
  Object.assign(f.bag.internals, { standardProfile: DEFAULT_STANDARD_PROFILE });
  configureViewStandard(f.view, undefined);
  expect(f.bag.frameState.installedPipelineConfig).toMatchObject({
    outputContract: 'standard-output-v2',
  });
  configureViewStandard(f.view, { outputContract: 'standard-output-v1' });
  expect(f.bag.frameState.installedPipelineConfig).toMatchObject({
    outputContract: 'standard-output-v1',
  });
});
