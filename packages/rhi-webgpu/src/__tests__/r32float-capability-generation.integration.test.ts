import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

const hasGpu = globalThis.navigator?.gpu !== undefined;

describe.skipIf(!hasGpu)('WebGPU r32float probe generation budget', () => {
  it('reuses one receipt within a generation and probes a replacement', async () => {
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;
    const firstDeviceResult = await adapterResult.value.requestDevice();
    expect(firstDeviceResult.ok).toBe(true);
    if (!firstDeviceResult.ok) return;

    const first = firstDeviceResult.value;
    const firstProbe = first.probeTextureFormatCapability();
    expect(first.probeTextureFormatCapability()).toBe(firstProbe);
    const firstReceipt = await firstProbe;
    expect(firstReceipt.ok).toBe(true);
    if (!firstReceipt.ok) return;
    expect(firstReceipt.value.probeExecutions).toBe(1);

    const replacementAdapterResult = await rhi.requestAdapter();
    expect(replacementAdapterResult.ok).toBe(true);
    if (!replacementAdapterResult.ok) return;
    const replacementResult = await replacementAdapterResult.value.requestDevice();
    expect(replacementResult.ok).toBe(true);
    if (!replacementResult.ok) return;
    const replacementReceipt = await replacementResult.value.probeTextureFormatCapability();
    expect(replacementReceipt.ok).toBe(true);
    if (!replacementReceipt.ok) return;
    expect(replacementReceipt.value.deviceGeneration).not.toBe(firstReceipt.value.deviceGeneration);
    expect(replacementReceipt.value.probeExecutions).toBe(1);
  });
});
