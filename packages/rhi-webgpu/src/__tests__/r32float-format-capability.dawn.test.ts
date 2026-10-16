import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

describe('Dawn r32float format profile', () => {
  it('executes the independent full chain through completion and readback', async () => {
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;
    const deviceResult = await adapterResult.value.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;

    const receiptResult = await deviceResult.value.probeTextureFormatCapability();
    expect(receiptResult.ok).toBe(true);
    if (!receiptResult.ok) return;
    expect(receiptResult.value.profile).toBe('r32float-mip-sampled-storage');
    expect(receiptResult.value.verdict).toBe('admitted');
    expect(receiptResult.value.evidence).toBe('real');
    expect(receiptResult.value.stages.map((stage) => stage.stage)).toEqual([
      'texture-create',
      'mip-view',
      'sampled-storage-bind-group',
      'pipeline-bind',
      'finish',
      'submit',
      'completion',
      'readback',
    ]);
    expect(receiptResult.value.readback?.values.length).toBeGreaterThan(0);
  });
});
