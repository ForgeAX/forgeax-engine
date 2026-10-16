import { describe, expect, it } from 'vitest';
import {
  beginProbeIblUpdate,
  createIblKernelCache,
  createProbeIblOutput,
  type ProbeIblOutput,
  publishProbeIblOutput,
} from '../ibl/kernel-cache';

describe('ReflectionProbe IBL topology', () => {
  it('shares only generation-scoped kernels and keeps probe outputs independent', () => {
    const kernels = createIblKernelCache(7);
    const first = createProbeIblOutput({ entityKey: 1, resolution: 256, deviceGeneration: 7 });
    const second = createProbeIblOutput({ entityKey: 2, resolution: 256, deviceGeneration: 7 });
    expect(kernels.generation).toBe(7);
    expect(first.raw).not.toBe(first.filtered);
    expect(first.raw).not.toBe(second.raw);
    expect(first.filteredGeneration).toBe(0);
    expect(first.lkg).toBe(true);
  });

  it('requires raw, filtered, and publish order before a new generation is visible', () => {
    const initial = createProbeIblOutput({ entityKey: 4, resolution: 128, deviceGeneration: 2 });
    const update = beginProbeIblUpdate(initial);
    expect(update.stages).toEqual(['raw', 'filtered', 'publish']);
    expect(update.nextStage).toBe('raw');
    const published = publishProbeIblOutput(update, { stage: 'raw', ok: true });
    expect(published.filteredGeneration).toBe(0);
    expect(published.lkg).toBe(true);
  });

  it('retains filtered LKG when PMREM, encode, or submit fails', () => {
    let output: ProbeIblOutput = createProbeIblOutput({
      entityKey: 5,
      resolution: 64,
      deviceGeneration: 3,
    });
    const update = beginProbeIblUpdate(output);
    for (const stage of ['raw', 'filtered', 'publish'] as const) {
      output = publishProbeIblOutput({ ...update, nextStage: stage }, { stage, ok: false });
      expect(output.lkg).toBe(true);
      expect(output.filteredGeneration).toBe(0);
    }
  });
});
