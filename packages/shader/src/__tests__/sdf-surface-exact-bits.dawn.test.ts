import { expect, it } from 'vitest';
import { runSurfaceBufferWork } from '../../../render/src/__tests__/raytracing/sdf-surface-intersection.fixture';
import {
  assessExactBits,
  exactBitCases,
  exactBitInput,
  exactBitVariants,
} from './sdf-surface-exact-bits.fixture';

for (const variant of exactBitVariants()) {
  it(`keeps private bit failures separate from exact zero: ${variant.name}`, async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) return;
    const device = await adapter.requestDevice();
    try {
      const raw = await runSurfaceBufferWork(
        device,
        variant.source,
        exactBitInput(),
        'exactBits',
        exactBitCases.length,
        16,
      );
      const result = assessExactBits(raw);
      expect(result.failures.length === 0).toBe(!variant.negative);
    } finally {
      device.destroy();
    }
  });
}
